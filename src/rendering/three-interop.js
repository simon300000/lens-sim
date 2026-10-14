import * as THREE from 'three/webgpu';

/** The ONLY new module touching Three's private backend. Pinned r183 ABI.
 * Raw WGSL is used because the testable fused optical kernel has heterogeneous
 * storage/texture bindings. Textures stay on Three's one device/queue; no copy
 * through CPU and no second rendering device. Public StorageTexture owns output.
 */
export function createGPUInterop(renderer) {
  if(THREE.REVISION!=='183')throw new Error(`Interop requires tested Three r183; got ${THREE.REVISION}`);
  const backend=renderer.backend,device=backend?.device;
  if(!backend?.isWebGPUBackend||!device||typeof backend.get!=='function')throw new Error('Native WebGPU renderer must be initialized');
  let disposed=false,lost=false,compilations=0;
  device.lost.then(()=>{lost=true;});
  const resources=new Set();
  function check(){if(disposed||lost||renderer.backend?.device!==device)throw new Error('GPU interop lifecycle expired or device lost');}
  function buffer(size,usage,label,data){
    check();const b=device.createBuffer({size:Math.max(4,Math.ceil(size/4)*4),usage,label});resources.add(b);
    if(data)device.queue.writeBuffer(b,0,data);return b;
  }
  return {
    device,
    get compilations(){return compilations;},
    buffer,
    uniform(data,label){return buffer(data.byteLength,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,label,data);},
    storage(dataOrSize,label){const size=typeof dataOrSize==='number'?dataOrSize:dataOrSize.byteLength;return buffer(size,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC,label,typeof dataOrSize==='number'?null:dataOrSize);},
    texture(texture){
      check();const resource=backend.get(texture).texture;
      if(!resource)throw new Error(`Texture not initialized: ${texture.name||texture.uuid}`);
      return resource;
    },
    storageImage(width,height,label='Lens HDR mean'){
      const texture=new THREE.StorageTexture(width,height);texture.type=THREE.HalfFloatType;
      texture.colorSpace=THREE.LinearSRGBColorSpace;texture.name=label;texture.generateMipmaps=false;
      texture.mipmapsAutoUpdate=false;renderer.initTexture(texture);
      return {texture,gpu:this.texture(texture)};
    },
    async computePipeline(code,label){
      check();device.pushErrorScope('validation');
      const module=device.createShaderModule({code,label});
      const info=await module.getCompilationInfo();
      const errors=info.messages.filter(m=>m.type==='error');
      if(errors.length){await device.popErrorScope();throw new Error(`${label}: `+errors.map(m=>`${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));}
      const pipeline=await device.createComputePipelineAsync({label,layout:'auto',compute:{module,entryPoint:'main'}});
      const error=await device.popErrorScope();if(error)throw new Error(`${label}: ${error.message}`);
      compilations++;return pipeline;
    },
    release(resource){if(resources.delete(resource))resource.destroy();},
    async readBuffer(source,size,offset=0){
      check();const staging=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(source,offset,staging,0,size);device.queue.submit([encoder.finish()]);
      try{await staging.mapAsync(GPUMapMode.READ);return staging.getMappedRange().slice(0);}finally{staging.unmap();staging.destroy();}
    },
    async readTexture(texture,{x=0,y=0,width=texture.width,height=texture.height}={}){
      const half=texture.format==='rgba16float',bpp=half?8:texture.format.includes('rgba32')?16:4;
      const bytesPerRow=Math.ceil(width*bpp/256)*256;
      const staging=device.createBuffer({size:bytesPerRow*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      const enc=device.createCommandEncoder();enc.copyTextureToBuffer({texture,origin:{x,y}},{buffer:staging,bytesPerRow},{width,height});device.queue.submit([enc.finish()]);
      try{
        await staging.mapAsync(GPUMapMode.READ);const raw=staging.getMappedRange(),values=half?new Uint16Array(raw):bpp===16?new Float32Array(raw):new Uint8Array(raw),channels=bpp/(half?2:bpp===16?4:1);
        const out=new Float32Array(width*height*channels),stride=bytesPerRow/(half?2:bpp===16?4:1);
        for(let row=0;row<height;row++)for(let i=0;i<width*channels;i++){const v=values[row*stride+i];out[row*width*channels+i]=half?THREE.DataUtils.fromHalfFloat(v):bpp===16?v:v/255;}
        return out;
      }finally{staging.unmap();staging.destroy();}
    },
    dispose(){if(disposed)return;disposed=true;for(const r of resources)r.destroy();resources.clear();},
  };
}

/** Optional real GPU timestamps. One pending read, never stalls each batch. */
export function createComputeTimer(interop) {
  const {device}=interop;
  if(!device.features.has('timestamp-query'))return {supported:false,begin(){return undefined;},end(){},dispose(){}};
  const querySet=device.createQuerySet({type:'timestamp',count:2});
  const resolve=device.createBuffer({size:16,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});
  const read=device.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  let pending=false;
  return {
    supported:true,
    begin(){if(pending)return undefined;pending=true;return {querySet,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1};},
    end(encoder,measured,onResult){if(!measured)return;encoder.resolveQuerySet(querySet,0,2,resolve,0);encoder.copyBufferToBuffer(resolve,0,read,0,16);
      return ()=>read.mapAsync(GPUMapMode.READ).then(()=>{const t=new BigUint64Array(read.getMappedRange());onResult(Number(t[1]-t[0])/1e6);read.unmap();pending=false;},()=>{pending=false;});},
    dispose(){querySet.destroy();resolve.destroy();read.destroy();},
  };
}
