import * as THREE from 'three/webgpu';
import {attribute,instanceColor,mat4,normalLocal,positionLocal,positionPrevious,transformNormal,OnObjectUpdate} from 'three/tsl';
import {hasSharedInstanceAttributes,INSTANCE_MATRIX_ATTRIBUTES,INSTANCE_COLOR_ATTRIBUTE} from '../scene/static-batches.js';
import {createGPUInterop} from './gpu-interop.js';

const SHARED_INSTANCE_UUID='shared-instance-attributes';

/** Three builds a separate shader graph (and WGSL program) for every
 * InstancedMesh in every pass: NodeMaterial wires the mesh's own instance
 * buffer into the graph (r186: instancedMesh() inside setupPosition), so
 * render-object cache keys include the mesh uuid and the uniform-buffer variant
 * even embeds the instance count in the WGSL. With this scene's procedural PBR
 * materials each build costs ~30 ms, and 176 batches × 6 passes made that the
 * whole startup wait. Meshes prepared by shareInstanceAttributes() carry their
 * matrices and colours as geometry attributes, resolved per draw by name, so
 * the graph no longer depends on the mesh: one build serves every batch of a
 * material. Other InstancedMeshes keep Three's own path. Relies on three's
 * private NodeMaterial.setupPosition order (morph, skinning, displacement,
 * batch, instancing, positionNode; prepared meshes have none of the first four)
 * and the node manager's render cache key; idempotent. */
export function installSharedInstancing(renderer){
  const material=THREE.NodeMaterial.prototype;
  if(!material.setupPosition.sharedInstancing){
    const originalSetupPosition=material.setupPosition;
    function setupPosition(builder){
      const object=builder.object;
      if(!hasSharedInstanceAttributes(object))return originalSetupPosition.call(this,builder);
      const matrix=mat4(...INSTANCE_MATRIX_ATTRIBUTES.map(name=>attribute(name,'vec4')));
      positionLocal.assign(matrix.mul(positionLocal).xyz);
      if(builder.needsPreviousData())positionPrevious.assign(matrix.mul(positionPrevious).xyz);
      if(builder.hasGeometryAttribute('normal'))normalLocal.assign(transformNormal(normalLocal,matrix));
      if(object.instanceColor)instanceColor.assign(attribute(INSTANCE_COLOR_ATTRIBUTE,'vec3'));
      // Per-object update: this graph is shared by every batch of the material.
      // instanceMatrix.needsUpdate on the mesh re-uploads its shared interleaved buffer.
      OnObjectUpdate(({object:target})=>updateSharedMatrices(target));
      // Hide the mesh's own matrices from three's instancing branch for this setup.
      const instanceMatrix=object.instanceMatrix;object.instanceMatrix=null;
      try{return originalSetupPosition.call(this,builder);}finally{object.instanceMatrix=instanceMatrix;}
    }
    setupPosition.sharedInstancing=true;
    material.setupPosition=setupPosition;
  }
  // Node builder states are cached by the render object's cache key, which
  // includes the mesh uuid for instanced meshes. Prepared meshes share one key.
  const nodes=renderer._nodes;
  if(!nodes?.getForRenderCacheKey)throw new Error('Shared instancing requires the renderer node manager');
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
/** Re-upload a prepared mesh's interleaved matrices after instanceMatrix.needsUpdate. */
export function updateSharedMatrices(object){
  const matrices=object.geometry.attributes[INSTANCE_MATRIX_ATTRIBUTES[0]].data;
  if(matrices.sourceVersion!==object.instanceMatrix.version){matrices.sourceVersion=object.instanceMatrix.version;matrices.needsUpdate=true;}
}

/** three r186 creates a shadow map while building the first receiver's material,
 * binds its depth texture as an ordinary sampled texture, and then recreates
 * the texture on the map's first shadow render (render-target initialization
 * bumps its version). Commands already encoded in that frame, and any recorded
 * render bundle, keep the destroyed texture ("Destroyed texture ShadowDepthTexture
 * used in a submit"). Initialize the shadow render target as soon as three creates
 * it. Relies on three's ShadowNode.setupShadow/shadowMap; idempotent. */
export function installShadowMapInit(){
  const shadow=THREE.ShadowNode.prototype;
  if(shadow.setupShadow.shadowMapInit)return;
  const original=shadow.setupShadow;
  function setupShadow(builder){
    const result=original.call(this,builder);
    if(this.shadowMap)builder.renderer.initRenderTarget(this.shadowMap);
    return result;
  }
  setupShadow.shadowMapInit=true;
  shadow.setupShadow=setupShadow;
}

/** Make Three's render bundles usable for a scene that is drawn by several
 * passes. A bundle is only valid for the colour/depth formats and sample count
 * of the pass it was recorded in: the same group and camera are drawn here into
 * the normal/depth prepass, the 4x MSAA beauty target, the lens lighting refresh
 * target and shadow maps. r186 keys bundles by (BundleGroup, camera, render
 * context), but shares contexts between targets with matching formats/sample
 * counts while a lighting-resource pass deliberately records different draws,
 * so the target is part of the key as well. Three also executes recorded
 * bundles when the pass ends, i.e. after its directly drawn transparent objects
 * (water, lantern paper, Moon), which would blend them over an incomplete
 * frame; bundles are executed as soon as they are added instead, before the
 * direct draws, and the backend's redundant-state tracking is reset because
 * executeBundles clears the pass state. Relies on three's private RenderBundles
 * and WebGPUBackend.addBundle; idempotent; call after renderer.init(). */
export function installRenderBundleContexts(renderer){
  const bundles=renderer._bundles,backend=renderer.backend;
  if(!bundles?.bundles||typeof backend?.addBundle!=='function'||typeof backend.get!=='function')throw new Error('Render bundle contexts require the initialized WebGPU renderer');
  if(!bundles.get.bundleContexts){
    const keys=[],records=new Set();
    function get(bundleGroup,camera,renderContext=renderer._currentRenderContext){
      if(!renderContext)throw new Error('Render bundle requested outside of a render context');
      const renderTarget=renderer.getRenderTarget();
      keys[0]=bundleGroup;keys[1]=camera;keys[2]=renderContext;keys[3]=renderTarget??renderer;
      let bundle=this.bundles.get(keys);
      // RenderBundle is a plain {bundleGroup, camera, renderContext} record used as a backend data key.
      if(bundle===undefined){bundle={bundleGroup,camera,renderContext,renderTarget};this.bundles.set(keys,bundle);records.add(bundle);}
      keys[0]=keys[1]=keys[2]=keys[3]=null;
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

/** Lens reflection targets use the full display density, independently of
 * raster quality or motion scaling. Scope three's private reflector sizing hook
 * (_updateResolution) to the reflector instances, without resizing the
 * renderer, AO or display targets. */
export function withReflectionPixelRatio(renderer,reflectors,pixelRatio,render){
  const size=renderer.getSize(new THREE.Vector2()).multiplyScalar(pixelRatio).floor();
  const saved=[];
  try{
    for(const reflector of new Set(reflectors)){
      saved.push({reflector,own:Object.hasOwn(reflector,'_updateResolution'),update:reflector._updateResolution});
      reflector._updateResolution=function(target){
        target.setSize(Math.round(size.x*this.resolutionScale),Math.round(size.y*this.resolutionScale));
      };
    }
    return render();
  }finally{
    for(const {reflector,own,update} of saved){
      if(own)reflector._updateResolution=update;else delete reflector._updateResolution;
    }
  }
}

/** Thin three adapter over the framework-free interop (gpu-interop.js): the
 * renderer's own GPUDevice, output images as three StorageTextures (so TSL
 * display graphs can sample the lens image) and the GPU textures of three
 * textures (shadow maps, PMREM, reflector targets for the garden provider).
 * Everything stays on three's one device/queue; nothing goes through the CPU. */
export function createThreeInterop(renderer,{memoryBudget}={}) {
  const backend=renderer.backend,device=backend?.device;
  if(!backend?.isWebGPUBackend||!device||typeof backend.get!=='function')throw new Error('Native WebGPU renderer must be initialized');
  const alive=()=>renderer.backend?.device===device;
  const gpuTexture=texture=>{const resource=backend.get(texture).texture;if(!resource)throw new Error(`Texture not initialized: ${texture.name||texture.uuid}`);return resource;};
  const createImage=(width,height,format,label)=>{
    const texture=new THREE.StorageTexture(width,height);texture.type=format==='rgba32float'?THREE.FloatType:THREE.HalfFloatType;
    texture.colorSpace=THREE.LinearSRGBColorSpace;texture.name=label;texture.generateMipmaps=false;texture.mipmapsAutoUpdate=false;
    try{renderer.initTexture(texture);return {texture,gpu:gpuTexture(texture),dispose(){texture.dispose();}};}
    catch(error){texture.dispose();throw error;}
  };
  const interop=createGPUInterop(device,{memoryBudget,createImage,alive});
  interop.renderer=renderer;
  interop.texture=texture=>{if(!alive())throw new Error('GPU interop lifecycle expired or device lost');return gpuTexture(texture);};
  return interop;
}

/** Camera-to-world pose (column-major, metres) of a three camera for setPose(). */
export function cameraPose(camera){camera.updateMatrixWorld(true);return camera.matrixWorld.elements;}

/** Startup bookkeeping only: never share render states or GPU bindings.
 * Include Three's real attachment/MRT/nesting context, not target identity
 * (private renderer._currentRenderContext and the renderObject argument order). */
export function renderVariantKey(renderer,args){
  const [object,scene,camera,geometry,material,,lights,clipping]=args;
  const context=renderer._currentRenderContext;
  if(!context)throw new Error('No active render context during warmup');
  return [object.id,geometry.id,material.id,material.version,scene.overrideMaterial?.id,scene.overrideMaterial?.version,
    camera.id,context.id,renderer.contextNode.id,renderer.contextNode.version,lights.getCacheKey(),clipping?.cacheKey,object.receiveShadow].join('/');
}
