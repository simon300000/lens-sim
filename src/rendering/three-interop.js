import * as THREE from 'three/webgpu';
import {attribute,instancedBufferAttribute,instancedDynamicBufferAttribute,mat4,normalLocal,positionLocal,positionPrevious,transformNormal,varyingProperty} from 'three/tsl';
import {hasSharedInstanceAttributes,INSTANCE_MATRIX_ATTRIBUTES,INSTANCE_COLOR_ATTRIBUTE} from '../scene/static-batches.js';
import {computeConfiguration,createGPUMemoryBudget} from './gpu-policy.js';

const SHARED_INSTANCE_UUID='shared-instance-attributes';

/** Three builds a separate shader graph (and WGSL program) for every
 * InstancedMesh in every pass: NodeMaterial wires the mesh's own instance
 * buffer into the graph, so render-object cache keys include the mesh uuid
 * and the uniform-buffer variant even embeds the node id and instance count
 * in the WGSL. With this scene's procedural PBR materials each build costs
 * ~30 ms, and 176 batches × 6 passes made that the whole startup wait.
 * Meshes prepared by shareInstanceAttributes() carry their matrices and
 * colours as geometry attributes, resolved per draw by name, so the graph no
 * longer depends on the mesh: one build serves every batch of a material.
 * Any other InstancedMesh keeps Three's own path, except that its matrices
 * always go through the vertex-attribute variant so at least the compiled
 * programs are shared. Pinned to r183 (InstanceNode, NodeManager); idempotent. */
export function installSharedInstancing(renderer){
  if(THREE.REVISION!=='183')throw new Error(`Shared instancing requires tested Three r183; got ${THREE.REVISION}`);
  const instance=THREE.InstanceNode.prototype;
  if(!instance.setup.sharedInstancing){
    const originalSetup=instance.setup,originalUpdate=instance.update,originalMatrix=instance._createInstanceMatrixNode;
    function setup(builder){
      if(!hasSharedInstanceAttributes(builder.object))return originalSetup.call(this,builder);
      // Per-object updates: this node instance is shared by every batch of the material.
      this.updateType=THREE.NodeUpdateType.OBJECT;
      const matrix=mat4(...INSTANCE_MATRIX_ATTRIBUTES.map(name=>attribute(name,'vec4')));
      positionLocal.assign(matrix.mul(positionLocal).xyz);
      if(builder.needsPreviousData())positionPrevious.assign(matrix.mul(positionPrevious).xyz);
      if(builder.hasGeometryAttribute('normal'))normalLocal.assign(transformNormal(normalLocal,matrix));
      if(builder.object.instanceColor)varyingProperty('vec3','vInstanceColor').assign(attribute(INSTANCE_COLOR_ATTRIBUTE,'vec3'));
    }
    function update(frame){
      const object=frame.object;
      if(!hasSharedInstanceAttributes(object))return originalUpdate.call(this,frame);
      // instanceMatrix.needsUpdate on the mesh re-uploads its shared interleaved buffer.
      const matrices=object.geometry.attributes[INSTANCE_MATRIX_ATTRIBUTES[0]].data;
      if(matrices.sourceVersion!==object.instanceMatrix.version){matrices.sourceVersion=object.instanceMatrix.version;matrices.needsUpdate=true;}
    }
    function createInstanceMatrixNode(assignBuffer,builder){
      if(this.isStorageMatrix)return originalMatrix.call(this,assignBuffer,builder);
      const {instanceMatrix}=this;
      const interleaved=new THREE.InstancedInterleavedBuffer(instanceMatrix.array,16,1);
      if(assignBuffer===true)this.buffer=interleaved;
      const column=instanceMatrix.usage===THREE.DynamicDrawUsage?instancedDynamicBufferAttribute:instancedBufferAttribute;
      return mat4(column(interleaved,'vec4',16,0),column(interleaved,'vec4',16,4),column(interleaved,'vec4',16,8),column(interleaved,'vec4',16,12));
    }
    setup.sharedInstancing=true;
    Object.assign(instance,{setup,update,_createInstanceMatrixNode:createInstanceMatrixNode});
  }
  // Node builder states are cached by the render object's cache key, which
  // includes the mesh uuid for instanced meshes. Prepared meshes share one key.
  const nodes=renderer._nodes;
  if(!nodes?.getForRenderCacheKey)throw new Error('Shared instancing requires the renderer node manager (Three r183)');
  if(!nodes.getForRenderCacheKey.sharedInstancing){
    const original=nodes.getForRenderCacheKey;
    function getForRenderCacheKey(renderObject){
      const {object}=renderObject;
      if(!hasSharedInstanceAttributes(object))return original.call(this,renderObject);
      const uuid=object.uuid;object.uuid=SHARED_INSTANCE_UUID;
      try{return renderObject.getCacheKey();}finally{object.uuid=uuid;}
    }
    getForRenderCacheKey.sharedInstancing=true;
    nodes.getForRenderCacheKey=getForRenderCacheKey;
  }
}

/** Make Three's render bundles usable for a scene that is drawn by several
 * passes. r183 caches one GPURenderBundle per (BundleGroup, camera), yet a
 * bundle is only valid for the colour/depth formats and sample count of the
 * pass it was recorded in: the same group and camera are drawn here into the
 * normal/depth prepass, the 4x MSAA beauty target, the lens lighting refresh
 * target and shadow maps. The bundle registry is keyed by the current render
 * context as well. r183 also executes recorded bundles when the pass ends,
 * i.e. after Three's directly drawn transparent objects (water, lantern
 * paper, Moon), which would blend them over an incomplete frame; bundles are
 * executed as soon as they are added instead, before the direct draws, and
 * the backend's redundant-state tracking is reset because executeBundles
 * clears the pass state. Pinned to r183 (RenderBundles, WebGPUBackend);
 * idempotent; call after renderer.init(). */
export function installRenderBundleContexts(renderer){
  if(THREE.REVISION!=='183')throw new Error(`Render bundle contexts require tested Three r183; got ${THREE.REVISION}`);
  const bundles=renderer._bundles,backend=renderer.backend;
  if(!bundles?.bundles||typeof backend?.addBundle!=='function'||typeof backend.get!=='function')throw new Error('Render bundle contexts require the initialized WebGPU renderer (Three r183)');
  if(!bundles.get.bundleContexts){
    const keys=[],records=new Set();
    function get(bundleGroup,camera){
      const context=renderer._currentRenderContext;
      if(!context)throw new Error('Render bundle requested outside of a render context');
      keys[0]=bundleGroup;keys[1]=camera;keys[2]=context;
      let bundle=this.bundles.get(keys);
      // RenderBundle (not exported by three/webgpu) is a plain {bundleGroup, camera} record used as a backend data key.
      if(bundle===undefined){bundle={bundleGroup,camera,renderContext:context};this.bundles.set(keys,bundle);records.add(bundle);}
      keys[0]=keys[1]=keys[2]=null;
      return bundle;
    }
    get.bundleContexts=true;get.records=records;
    bundles.get=get;
    const dispose=bundles.dispose.bind(bundles);
    bundles.dispose=()=>{records.clear();dispose();};
  }
  if(!backend.addBundle.bundleContexts){
    function addBundle(renderContext,bundle){
      const data=this.get(renderContext);
      data.currentPass.executeBundles([this.get(bundle).bundleGPU]);
      data.currentSets={attributes:{},bindingGroups:[],pipeline:null,index:null};
    }
    addBundle.bundleContexts=true;
    backend.addBundle=addBundle;
  }
  return {
    /** Force re-recording of the bundles whose record ({bundleGroup, camera, renderContext})
     * matches, e.g. only the beauty pass after its AO texture was recreated. */
    invalidate(predicate=()=>true){
      let count=0;
      for(const record of bundles.get.records){if(predicate(record)){backend.get(record).version=-1;count++;}}
      return count;
    },
    get recorded(){return bundles.get.records.size;},
  };
}

/** The ONLY module touching Three's private backend and node internals. Pinned r183 ABI.
 * Raw WGSL is used because the staged optical kernels have heterogeneous
 * storage/texture bindings. Textures stay on Three's one device/queue; no copy
 * through CPU and no second rendering device. Public StorageTexture owns output.
 */
export function createGPUInterop(renderer,{memoryBudget}={}) {
  if(THREE.REVISION!=='183')throw new Error(`Interop requires tested Three r183; got ${THREE.REVISION}`);
  const backend=renderer.backend,device=backend?.device;
  if(!backend?.isWebGPUBackend||!device||typeof backend.get!=='function')throw new Error('Native WebGPU renderer must be initialized');
  const configuration=computeConfiguration(device.limits),budget=createGPUMemoryBudget(memoryBudget);
  let disposed=false,lost=false,compilations=0;
  device.lost.then(()=>{lost=true;});
  const resources=new Set(),reservations=new Map(),images=new Set();
  function check(){if(disposed||lost||renderer.backend?.device!==device)throw new Error('GPU interop lifecycle expired or device lost');}
  function buffer(size,usage,label,data){
    check();size=Math.max(4,Math.ceil(size/4)*4);
    if(!Number.isSafeInteger(size)||size>device.limits.maxBufferSize)throw new RangeError(`${label}: GPU buffer size exceeds maxBufferSize`);
    if((usage&GPUBufferUsage.STORAGE)&&size>device.limits.maxStorageBufferBindingSize)throw new RangeError(`${label}: GPU buffer size exceeds maxStorageBufferBindingSize`);
    if((usage&GPUBufferUsage.UNIFORM)&&size>device.limits.maxUniformBufferBindingSize)throw new RangeError(`${label}: GPU buffer size exceeds maxUniformBufferBindingSize`);
    const token=budget.reserve(size,label);let b;
    try{b=device.createBuffer({size,usage,label});resources.add(b);reservations.set(b,token);if(data)device.queue.writeBuffer(b,0,data);return b;}
    catch(error){if(b)release(b);else budget.release(token);throw error;}
  }
  function release(resource){if(resources.delete(resource)){resource.destroy();budget.release(reservations.get(resource));reservations.delete(resource);}}
  return {
    device,
    configuration,memoryBudget:budget,
    get compilations(){return compilations;},
    get liveBuffers(){return resources.size;},
    buffer,
    uniform(data,label){return buffer(data.byteLength,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,label,data);},
    storage(dataOrSize,label){const size=typeof dataOrSize==='number'?dataOrSize:dataOrSize.byteLength;return buffer(size,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC,label,typeof dataOrSize==='number'?null:dataOrSize);},
    texture(texture){
      check();const resource=backend.get(texture).texture;
      if(!resource)throw new Error(`Texture not initialized: ${texture.name||texture.uuid}`);
      return resource;
    },
    storageImage(width,height,label='Lens HDR mean'){
      check();if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||Math.max(width,height)>device.limits.maxTextureDimension2D)throw new RangeError(`${label}: unsupported GPU texture dimensions`);
      const token=budget.reserve(width*height*8,label);let texture;
      try{
        texture=new THREE.StorageTexture(width,height);texture.type=THREE.HalfFloatType;
        texture.colorSpace=THREE.LinearSRGBColorSpace;texture.name=label;texture.generateMipmaps=false;texture.mipmapsAutoUpdate=false;
        const dispose=texture.dispose.bind(texture);images.add(texture);
        texture.dispose=()=>{if(images.delete(texture)){budget.release(token);dispose();}};
        renderer.initTexture(texture);return {texture,gpu:this.texture(texture)};
      }catch(error){if(texture&&images.has(texture))texture.dispose();else budget.release(token);throw error;}
    },
    async computePipeline(code,label){
      check();device.pushErrorScope('validation');
      let module,pipelinePromise,infoPromise,errorPromise,creationError;
      try{
        module=device.createShaderModule({code,label});
        infoPromise=module.getCompilationInfo();
        pipelinePromise=device.createComputePipelineAsync({label,layout:'auto',compute:{module,entryPoint:'main'}});
      }catch(error){creationError=error;}finally{
        // Error scopes are a device-wide stack. Pop synchronously, before any
        // await, so concurrent jobs cannot consume one another's validation scope.
        errorPromise=device.popErrorScope();
      }
      const results=await Promise.allSettled([infoPromise,pipelinePromise,errorPromise]);
      if(creationError)throw creationError;
      const rejection=results.find(result=>result.status==='rejected');
      if(rejection)throw new Error(`${label}: ${rejection.reason?.message??rejection.reason}`);
      const [info,pipeline,error]=results.map(result=>result.value);
      const errors=info.messages.filter(m=>m.type==='error');
      if(errors.length)throw new Error(`${label}: `+errors.map(m=>`${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
      if(error)throw new Error(`${label}: ${error.message}`);
      compilations++;return pipeline;
    },
    release,
    async readBuffer(source,size,offset=0){
      check();const staging=buffer(size,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ,'GPU buffer readback staging');
      try{const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(source,offset,staging,0,size);device.queue.submit([encoder.finish()]);await staging.mapAsync(GPUMapMode.READ);return staging.getMappedRange().slice(0);}
      finally{if(staging.mapState==='mapped')staging.unmap();release(staging);}
    },
    async readTexture(texture,{x=0,y=0,width=texture.width,height=texture.height}={}){
      const half=texture.format==='rgba16float',bpp=half?8:texture.format.includes('rgba32')?16:4;
      const bytesPerRow=Math.ceil(width*bpp/256)*256;
      const staging=buffer(bytesPerRow*height,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ,'GPU texture readback staging');
      try{
        const enc=device.createCommandEncoder();enc.copyTextureToBuffer({texture,origin:{x,y}},{buffer:staging,bytesPerRow},{width,height});device.queue.submit([enc.finish()]);
        await staging.mapAsync(GPUMapMode.READ);const raw=staging.getMappedRange(),values=half?new Uint16Array(raw):bpp===16?new Float32Array(raw):new Uint8Array(raw),channels=bpp/(half?2:bpp===16?4:1);
        const out=new Float32Array(width*height*channels),stride=bytesPerRow/(half?2:bpp===16?4:1);
        for(let row=0;row<height;row++)for(let i=0;i<width*channels;i++){const v=values[row*stride+i];out[row*width*channels+i]=half?THREE.DataUtils.fromHalfFloat(v):bpp===16?v:v/255;}
        return out;
      }finally{if(staging.mapState==='mapped')staging.unmap();release(staging);}
    },
    dispose(){if(disposed)return;disposed=true;for(const r of resources)release(r);for(const image of [...images])image.dispose();},
  };
}

/** Milliseconds between two resolved timestamps, or null when end <= begin. WebGPU does not
 * guarantee monotonic timestamps (e.g. across passes or GPU clock recalibration), and BigInt
 * subtraction does not wrap, so a reordered pair would otherwise read as a negative time. */
export function timestampSpanMs(begin,end){return end>begin?Number(end-begin)/1e6:null;}

/** Optional real GPU timestamps. One pending read, never stalls each batch. */
export function createComputeTimer(interop) {
  const {device}=interop;
  if(!device.features.has('timestamp-query'))return {supported:false,begin(){return undefined;},end(){},dispose(){}};
  const querySet=device.createQuerySet({type:'timestamp',count:2});
  let resolve,read;
  try{resolve=interop.buffer(16,GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC,'Compute timestamp resolve');read=interop.buffer(16,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ,'Compute timestamp readback');}
  catch(error){querySet.destroy();if(resolve)interop.release(resolve);throw error;}
  let pending=false;
  return {
    supported:true,
    begin(){if(pending)return undefined;pending=true;return {querySet,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1};},
    end(encoder,measured,onResult){if(!measured)return;encoder.resolveQuerySet(querySet,0,2,resolve,0);encoder.copyBufferToBuffer(resolve,0,read,0,16);
      return ()=>read.mapAsync(GPUMapMode.READ).then(()=>{const t=new BigUint64Array(read.getMappedRange()),ms=timestampSpanMs(t[0],t[1]);read.unmap();if(ms!==null)onResult(ms);pending=false;},()=>{pending=false;});},
    dispose(){querySet.destroy();interop.release(resolve);interop.release(read);},
  };
}

/** Startup bookkeeping only: never share render states or GPU bindings.
 * Include Three's real attachment/MRT/nesting context, not target identity. */
export function renderVariantKey(renderer,args){
  if(THREE.REVISION!=='183')throw new Error('Render warmup requires Three r183');
  const [object,scene,camera,geometry,material,,lights,clipping]=args;
  const context=renderer._currentRenderContext;
  if(!context)throw new Error('No active render context during warmup');
  return [object.id,geometry.id,material.id,material.version,scene.overrideMaterial?.id,scene.overrideMaterial?.version,
    camera.id,context.id,renderer.contextNode.id,renderer.contextNode.version,lights.getCacheKey(),clipping?.cacheKey,object.receiveShadow].join('/');
}
export function renderCacheCounts(renderer){
  if(THREE.REVISION!=='183')throw new Error('Render warmup requires Three r183');
  return {nodes:renderer._nodes.nodeBuilderCache.size,pipelines:renderer._pipelines.caches.size};
}
