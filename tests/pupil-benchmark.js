import optical from '../src/optics/optical-core.wgsl?raw';
import pupil from '../src/optics/pupil-sampling.wgsl?raw';
import kernel from './pupil-gpu.wgsl?raw';
import {SAMPLING_WGSL} from '../src/spectral/sampler.js';
import {SPECTRAL_WGSL} from '../src/spectral/reconstruction.js';
import {packLens} from '../src/optics/lens-state.js';
import {buildPupilTable,PUPIL_TABLE_BYTES} from '../src/optics/pupil-sampling.js';
import {buildPupilTable as legacyBuild} from './fixtures/pupil-sampling-legacy.js';
import {sweepIds} from './pupil-sweep.js';
const button=document.querySelector('#run'),progress=document.querySelector('#progress'),output=document.querySelector('#result');
button.onclick=async()=>{
 button.disabled=true;let device;const buffers=[],errors=[],losses=[];let interrupted=false;
 const track=()=>{if(document.hidden||!document.hasFocus())interrupted=true;};
 document.addEventListener('visibilitychange',track);window.addEventListener('blur',track);
 const report={kind:'benchmark',browser:navigator.userAgent,date:new Date().toISOString(),results:[],errors,losses};
 try{
  track();const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('No WebGPU adapter');
  const timestamp=adapter.features.has('timestamp-query');device=await adapter.requestDevice({requiredFeatures:timestamp?['timestamp-query']:[]});
  report.adapter=adapter.info.toJSON?.()??{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device};report.timestamp=timestamp;
  device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.lost.then(e=>{if(e.reason!=='destroyed')losses.push(e.message);});
  const buf=(data,usage)=>{const b=device.createBuffer({size:typeof data==='number'?data:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST});if(typeof data!=='number')device.queue.writeBuffer(b,0,data);buffers.push(b);return b;};
  const storage=data=>buf(data,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC),uniform=data=>buf(data,GPUBufferUsage.UNIFORM);
  const started=performance.now(),module=device.createShaderModule({code:optical+SAMPLING_WGSL+SPECTRAL_WGSL+pupil+kernel});
  const info=await module.getCompilationInfo();if(info.messages.some(x=>x.type==='error'))throw Error(info.messages.map(x=>x.message).join('\n'));
  const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});report.compileMs=performance.now()-started;
  const T=uniform(PUPIL_TABLE_BYTES),Q=uniform(32),O=storage(256*48),read=buf(256*48,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
  let qs,resolve,timeRead;if(timestamp){qs=device.createQuerySet({type:'timestamp',count:2});resolve=buf(16,GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC);timeRead=buf(16,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);}
  const options=new URLSearchParams(location.search),ids=options.has('lens')?[options.get('lens')]:sweepIds;
  for(const id of ids){
   progress.textContent=`预计算 ${id}`;await new Promise(r=>setTimeout(r,0));
   const lens=(await(await fetch(`/lenses/${id}.json`)).json()).configurations[0],p=packLens(lens,{sensorZMm:lens.sensorZMm});
   const baseline=legacyBuild(lens,p),variants=[{name:'legacy32',table:baseline},...[32,64,128,256].map(bins=>({name:'iterative'+bins,table:buildPupilTable(lens,p,{bins})}))];
   const U=uniform(p.parameters),S=storage(p.surfaces),L=storage(p.lut.values);
   const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[[0,U],[1,S],[2,L],[3,Q],[4,O],[20,T]].map(([binding,buffer])=>({binding,resource:{buffer}}))});
   async function run(table,h,nm,seed){
    const data=new Float32Array(PUPIL_TABLE_BYTES/4);data.set(table.data);device.queue.writeBuffer(T,0,data);
    const bytes=new ArrayBuffer(32);new Float32Array(bytes).set([h,0,nm,0]);new Uint32Array(bytes).set([256,seed,0,0],4);device.queue.writeBuffer(Q,0,bytes);
    const start=performance.now(),enc=device.createCommandEncoder(),pass=enc.beginComputePass(timestamp?{timestampWrites:{querySet:qs,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}}:{});
    pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(4);pass.end();
    if(timestamp){enc.resolveQuerySet(qs,0,2,resolve,0);enc.copyBufferToBuffer(resolve,0,timeRead,0,16);}enc.copyBufferToBuffer(O,0,read,0,256*48);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
    const v=new Float32Array(read.getMappedRange());let energy=0,passed=0,sum2=0,numerical=0,omitted=0;
    for(let i=0;i<256;i++){const j=i*12;energy+=v[j+3];passed+=v[j+4];sum2+=v[j+5];numerical+=v[j+7];omitted+=v[j+8];}read.unmap();const wallMs=performance.now()-start;let gpuMs=null;
    if(timestamp){await timeRead.mapAsync(GPUMapMode.READ);const t=new BigUint64Array(timeRead.getMappedRange());gpuMs=Number(t[1]-t[0])/1e6;timeRead.unmap();}
    const N=65536;return {h,nm,seed,attempts:N,energy:energy/N,passRate:passed/N,secondMoment:sum2/N,numerical,omitted:omitted/N,gpuMs,wallMs};
   }
   const rows=[];
   // Warm each variant separately; no warmup dispatch contributes to timings.
   for(const v of variants)await run(v.table,0,550,42);
   for(const fraction of [0,.499,.995])for(const nm of [390,550,770])for(const seed of [11,29,47]){
    for(const v of (seed===29?[...variants].reverse():variants)){
     progress.textContent=`${id} ${v.name} h=${fraction} nm=${nm} seed=${seed}`;track();rows.push({variant:v.name,...await run(v.table,baseline.maxHeight*fraction,nm,seed)});
    }
   }
   report.results.push({id,sensorZMm:p.sensorZMm,region:p.region,builds:variants.map(v=>({variant:v.name,buildMs:v.table.buildMs,probes:v.table.probes,diagnostics:v.table.diagnostics})),rows});
  }
  track();report.interrupted=interrupted;report.foreground=!document.hidden&&document.hasFocus();report.passed=!errors.length&&!losses.length&&!interrupted;
 }catch(e){report.passed=false;report.error=e.stack;}
 finally{
  document.removeEventListener('visibilitychange',track);window.removeEventListener('blur',track);for(const b of buffers)b.destroy();device?.destroy();button.disabled=false;
  output.textContent=JSON.stringify(report,null,2);document.body.dataset.passed=String(report.passed);progress.textContent=report.passed?'完成（保持前台，无 GPU 错误）':'失败／运行被中断';
  await fetch('/__pupil-report',{method:'POST',body:JSON.stringify(report)});
 }
};
if(new URLSearchParams(location.search).has('autorun'))button.click();
