import partialSource from '../src/rendering/statistics.wgsl?raw';
import reduceSource from '../src/rendering/statistics-reduce.wgsl?raw';
import {statisticsConfiguration,specializeStatistics} from '../src/rendering/statistics-plan.js';
const out=document.querySelector('#out');
document.querySelector('#run').onclick=async()=>{
document.querySelector('#run').disabled=true;const errors=[];
let device;
try{
 const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});device=await adapter.requestDevice();
 device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
 const pipeline=async code=>device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:'main'}});
 const config=statisticsConfiguration(device.limits);
 const partialPipeline=await pipeline(specializeStatistics(partialSource,config)),reducePipeline=await pipeline(specializeStatistics(reduceSource,config)),runs=[];
 for(const count of [1,4095,4096,4097,100003,24000000]){
  const expected=new Float64Array(12),values=new Uint32Array(count*16);
  for(let i=0;i<count;i++){
   const counters=[i%2,i%3===0?1:0,0,i%1009===0?1:0,17,i%5,i%7,13,i%11===0?1:0,i%13===0?1:0,0,i%17===0?1:0];
   values[i*16+3]=counters[4];values.set(counters.slice(0,4),i*16+4);values.set([counters[5],counters[6],counters[7],counters[8]],i*16+8);values.set([counters[9],counters[10],counters[11],2],i*16+12);
   counters.forEach((v,k)=>expected[k]+=v);
  }
  // The default WebGPU storage-binding limit can be 128 MiB. The production
  // engine has larger requested limits; split this synthetic image into tiles.
  const cap=Math.min(device.limits.maxStorageBufferBindingSize,64*1024**2),tilePixels=Math.floor(cap/64);
  const actual=new Float64Array(12),started=performance.now();
  for(let base=0;base<count;base+=tilePixels){
   const n=Math.min(tilePixels,count-base),groups=Math.ceil(n/4096),resources=[];
   const buffer=(size,usage)=>{const b=device.createBuffer({size,usage});resources.push(b);return b;};
   const input=buffer(n*64,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),partials=buffer(groups*48,GPUBufferUsage.STORAGE),totals=buffer(48,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC),read=buffer(48,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
   device.queue.writeBuffer(input,0,values.buffer,base*64,n*64);
   const bind=(p,a,b)=>device.createBindGroup({layout:p.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:a}},{binding:1,resource:{buffer:b}}]});
   const encoder=device.createCommandEncoder();
   let pass=encoder.beginComputePass();pass.setPipeline(partialPipeline);pass.setBindGroup(0,bind(partialPipeline,input,partials));pass.dispatchWorkgroups(groups);pass.end();
   pass=encoder.beginComputePass();pass.setPipeline(reducePipeline);pass.setBindGroup(0,bind(reducePipeline,partials,totals));pass.dispatchWorkgroups(1);pass.end();
   encoder.copyBufferToBuffer(totals,0,read,0,48);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
   const result=new Float32Array(read.getMappedRange());for(let k=0;k<12;k++)actual[k]+=result[k];read.unmap();resources.forEach(b=>b.destroy());
  }
  for(let k=0;k<12;k++)if(Math.abs(actual[k]-expected[k])>Math.max(1,expected[k]*2e-7))throw Error(`Counter ${k}, pixels ${count}: ${actual[k]} != ${expected[k]}`);
  runs.push({count,expected:[...expected],actual:[...actual],wallMs:performance.now()-started});
 }
 if(errors.length)throw Error(errors.join('\n'));
 window.__statisticsReport={passed:true,runs,errors};document.body.dataset.passed='true';
}catch(e){window.__statisticsReport={passed:false,error:e.stack,errors};document.body.dataset.passed='false';}
finally{out.textContent=JSON.stringify(window.__statisticsReport,null,2);device?.destroy();document.querySelector('#run').disabled=false;if(new URLSearchParams(location.search).has('save'))await fetch('/__integration?name=statistics.json',{method:'POST',body:JSON.stringify(window.__statisticsReport)});}
};
