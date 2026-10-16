import pupil from '../src/optics/pupil-sampling.wgsl?raw';
import {SAMPLING_WGSL} from '../src/spectral/sampler.js';
import {buildPupilTable,PUPIL_TABLE_BYTES,pupilBox,samplePupil} from '../src/optics/pupil-sampling.js';
import {packLens} from '../src/optics/lens-state.js';
let device;const errors=[],out=document.querySelector('#result');const report={kind:'layout',browser:navigator.userAgent};
try{
 const adapter=await navigator.gpu.requestAdapter();device=await adapter.requestDevice();report.limit=device.limits.maxUniformBufferBindingSize;report.bytes=PUPIL_TABLE_BYTES;
 if(PUPIL_TABLE_BYTES>report.limit)throw Error('Uniform too large');device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
 const lens=(await(await fetch('/lenses/7artisans-af-135mm-f1-8-max.json')).json()).configurations[0],p=packLens(lens,{sensorZMm:lens.sensorZMm});
 const code='struct TinyOptics { geometry:vec4f }; @group(0) @binding(0) var<uniform> optics:TinyOptics;'+SAMPLING_WGSL+pupil+`@group(0) @binding(1) var<storage,read> input:array<vec4f>;@group(0) @binding(2) var<storage,read_write> output:array<vec4f>;@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){let a=input[id.x];let q=sampleExitPupil(a.xy,a.zw);output[id.x*2u]=vec4f(q.point,q.pdf,select(0.0,1.0,q.inGlobal));output[id.x*2u+1u]=pupilBounds(a.xy);}`;
 const module=device.createShaderModule({code});const info=await module.getCompilationInfo();if(info.messages.some(x=>x.type==='error'))throw Error(info.messages.map(x=>x.message).join('\n'));
 const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
 const make=(data,usage)=>{const b=device.createBuffer({size:typeof data==='number'?data:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST});if(typeof data!=='number')device.queue.writeBuffer(b,0,data);return b;};
 const cases=[];for(const f of [0,.12345,.499,.995,1,1.1])for(const axis of [[1,0],[0,1],[.6,.8]])for(const u of [.0125,.7])cases.push([f,axis,u]);
 const inputs=new Float32Array(cases.flatMap(([f,a,u])=>[f*Math.hypot(36,24)/2*a[0],f*Math.hypot(36,24)/2*a[1],u,.371]));
 const U=make(new Float32Array([0,0,p.region.radiusMm,0]),GPUBufferUsage.UNIFORM),T=make(PUPIL_TABLE_BYTES,GPUBufferUsage.UNIFORM),I=make(inputs,GPUBufferUsage.STORAGE),O=make(cases.length*32,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC),R=make(cases.length*32,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
 const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[[0,U],[1,I],[2,O],[20,T]].map(([binding,buffer])=>({binding,resource:{buffer}}))});
 let maxPoint=0,maxPDF=0,maxBound=0;
 for(const movingCenter of [false,true]){
  const table=buildPupilTable(lens,p,{bins:8,movingCenter});device.queue.writeBuffer(T,0,table.data);const enc=device.createCommandEncoder(),pass=enc.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(cases.length);pass.end();enc.copyBufferToBuffer(O,0,R,0,cases.length*32);device.queue.submit([enc.finish()]);await R.mapAsync(GPUMapMode.READ);const v=new Float32Array(R.getMappedRange());
  for(let i=0;i<cases.length;i++){const a=Array.from(inputs.slice(i*4,i*4+4)),s=a.slice(0,2),q=samplePupil(table,s,p.region.radiusMm,a[2],a[3]),b=pupilBox(table,s);maxPoint=Math.max(maxPoint,Math.abs(q.reference[0]-v[i*8]),Math.abs(q.reference[1]-v[i*8+1]));maxPDF=Math.max(maxPDF,Math.abs(q.pdf-v[i*8+2])/q.pdf);for(let j=0;j<4;j++)maxBound=Math.max(maxBound,Math.abs(b[j]-v[i*8+4+j]));}
  R.unmap();
 }
 report.maxPoint=maxPoint;report.maxPDF=maxPDF;report.maxBound=maxBound;report.cases=cases.length*2;report.errors=errors;report.passed=maxPoint<1e-4&&maxPDF<1e-3&&maxBound<1e-4&&!errors.length;
 for(const b of [U,T,I,O,R])b.destroy();
}catch(e){report.passed=false;report.error=e.stack;report.errors=errors;}
finally{device?.destroy();out.textContent=JSON.stringify(report,null,2);document.body.dataset.passed=String(report.passed);await fetch('/__pupil-report',{method:'POST',body:JSON.stringify(report)});}
