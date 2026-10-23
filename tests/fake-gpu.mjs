/** A recording stand-in for a GPUDevice: buffers hold real bytes (writeBuffer,
 * clearBuffer, copyBufferToBuffer and mapAsync work), shader modules,
 * pipelines, bind groups and compute passes are recorded, nothing executes. */
import {gpuLimits} from './gpu-limits-fixture.mjs';

export function installGPUGlobals(){
  globalThis.GPUBufferUsage??={MAP_READ:1,MAP_WRITE:2,COPY_SRC:4,COPY_DST:8,INDEX:16,VERTEX:32,UNIFORM:64,STORAGE:128,INDIRECT:256,QUERY_RESOLVE:512};
  globalThis.GPUTextureUsage??={COPY_SRC:1,COPY_DST:2,TEXTURE_BINDING:4,STORAGE_BINDING:8,RENDER_ATTACHMENT:16};
  globalThis.GPUMapMode??={READ:1,WRITE:2};
}

export function createFakeDevice({limits=gpuLimits}={}){
  installGPUGlobals();
  const log={modules:[],pipelines:[],bindGroups:[],passes:[],submits:0,buffers:new Set()};
  const buffer=({size,usage,label})=>{
    const data=new Uint8Array(size),b={size,usage,label,data,mapState:'unmapped',destroyed:false,
      destroy(){b.destroyed=true;log.buffers.delete(b);},
      mapAsync(){b.mapState='mapped';return Promise.resolve();},
      getMappedRange(offset=0,length=size-offset){return data.buffer.slice(offset,offset+length);},
      unmap(){b.mapState='unmapped';}};
    log.buffers.add(b);return b;
  };
  const device={
    limits,features:new Set(),lost:new Promise(()=>{}),log,
    queue:{writeBuffer(target,offset,source,sourceOffset=0,size){const bytes=ArrayBuffer.isView(source)?new Uint8Array(source.buffer,source.byteOffset,source.byteLength):new Uint8Array(source);target.data.set(bytes.subarray(sourceOffset,size===undefined?undefined:sourceOffset+size),offset);},
      submit(){log.submits++;},onSubmittedWorkDone:()=>Promise.resolve()},
    createBuffer:buffer,
    createTexture({size,format,label}){const [width,height]=size;return {width,height,format,label,createView:()=>({texture:label}),destroy(){}};},
    createSampler:()=>({}),
    createShaderModule({code,label}){log.modules.push({code,label});return {getCompilationInfo:()=>Promise.resolve({messages:[]})};},
    createComputePipelineAsync({label}){const pipeline={label,getBindGroupLayout:()=>({pipeline:label})};log.pipelines.push(pipeline);return Promise.resolve(pipeline);},
    createBindGroup({layout,entries}){const group={layout,entries};log.bindGroups.push(group);return group;},
    pushErrorScope(){},popErrorScope:()=>Promise.resolve(null),
    createCommandEncoder(){
      return {
        beginComputePass({label}={}){const pass={label,dispatches:[]};log.passes.push(pass);return {setPipeline(p){pass.pipeline=p.label;},setBindGroup(i,g){pass.group=g;},dispatchWorkgroups(x,y=1){pass.dispatches.push([x,y]);},end(){}};},
        clearBuffer(b){b.data.fill(0);},
        copyBufferToBuffer(source,sourceOffset,target,targetOffset,size){target.data.set(source.data.subarray(sourceOffset,sourceOffset+size),targetOffset);},
        copyTextureToBuffer(){},resolveQuerySet(){},
        finish:()=>({}),
      };
    },
  };
  return device;
}
