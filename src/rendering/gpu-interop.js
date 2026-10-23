import {computeConfiguration,createGPUMemoryBudget} from './gpu-policy.js';
import {HALF_TO_FLOAT} from './half-float.js';

/** Framework-free GPU resource layer of the lens tracer, on a raw GPUDevice:
 * managed buffers (budgeted), output images, compute pipelines and readbacks.
 * Raw WGSL is used because the staged optical kernels have heterogeneous
 * storage/texture bindings. A host renderer adapter (three-interop.js) may
 * replace the output-image factory and add texture lookups; nothing here
 * depends on a rendering framework.
 *   createImage(width,height,format,label) -> {gpu:GPUTexture, texture?, dispose()}
 *   alive() -> false once the host has replaced or lost the device
 *   resources: the radiance provider's per-stage resources (limits check; garden by default) */
export const OUTPUT_FORMATS=Object.freeze(['rgba16float','rgba32float']);
export function createGPUInterop(device,{memoryBudget,createImage=null,alive=()=>true,resources:providerResources}={}) {
  if(!device?.limits)throw new TypeError('createGPUInterop requires a GPUDevice');
  const configuration=computeConfiguration(device.limits,{resources:providerResources}),budget=createGPUMemoryBudget(memoryBudget);
  let disposed=false,lost=false,compilations=0;
  device.lost?.then(()=>{lost=true;});
  const resources=new Set(),reservations=new Map(),images=new Set();
  function check(){if(disposed||lost||!alive())throw new Error('GPU interop lifecycle expired or device lost');}
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
  const rawImage=(width,height,format,label)=>{
    const gpu=device.createTexture({label,size:[width,height],format,usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC});
    return {gpu,texture:null,dispose(){gpu.destroy();}};
  };
  return {
    device,
    configuration,memoryBudget:budget,
    get compilations(){return compilations;},
    get liveBuffers(){return resources.size;},
    buffer,
    uniform(data,label){return buffer(data.byteLength,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,label,data);},
    storage(dataOrSize,label){const size=typeof dataOrSize==='number'?dataOrSize:dataOrSize.byteLength;return buffer(size,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC,label,typeof dataOrSize==='number'?null:dataOrSize);},
    /** Budgeted storage image ({gpu, texture?, dispose}); the host adapter decides what `texture` is. */
    storageImage(width,height,{format='rgba16float',label='Lens HDR mean'}={}){
      check();if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||Math.max(width,height)>device.limits.maxTextureDimension2D)throw new RangeError(`${label}: unsupported GPU texture dimensions`);
      if(!OUTPUT_FORMATS.includes(format))throw new RangeError(`${label}: unsupported output format ${format}`);
      const token=budget.reserve(width*height*(format==='rgba32float'?16:8),label);let image;
      try{image=(createImage??rawImage)(width,height,format,label);}catch(error){budget.release(token);throw error;}
      const dispose=image.dispose.bind(image);images.add(image);
      image.dispose=()=>{if(images.delete(image)){budget.release(token);dispose();}};
      return image;
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
    /** Linear float readback of a 2D texture (rgba16float, rgba32float or 8-bit), row order. */
    async readTexture(texture,{x=0,y=0,width=texture.width,height=texture.height}={}){
      const half=texture.format==='rgba16float',bpp=half?8:texture.format.includes('rgba32')?16:4;
      const bytesPerRow=Math.ceil(width*bpp/256)*256;
      const staging=buffer(bytesPerRow*height,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ,'GPU texture readback staging');
      try{
        const enc=device.createCommandEncoder();enc.copyTextureToBuffer({texture,origin:{x,y}},{buffer:staging,bytesPerRow},{width,height});device.queue.submit([enc.finish()]);
        await staging.mapAsync(GPUMapMode.READ);const raw=staging.getMappedRange(),values=half?new Uint16Array(raw):bpp===16?new Float32Array(raw):new Uint8Array(raw),channels=bpp/(half?2:bpp===16?4:1);
        const out=new Float32Array(width*height*channels),stride=bytesPerRow/(half?2:bpp===16?4:1);
        for(let row=0;row<height;row++)for(let i=0;i<width*channels;i++){const v=values[row*stride+i];out[row*width*channels+i]=half?HALF_TO_FLOAT[v]:bpp===16?v:v/255;}
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
