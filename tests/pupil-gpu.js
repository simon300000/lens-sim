import optical from '../src/optics/optical-core.wgsl?raw';
import pupil from '../src/optics/pupil-sampling.wgsl?raw';
import kernel from './pupil-gpu.wgsl?raw';
import {SAMPLING_WGSL} from '../src/spectral/sampler.js';
import {SPECTRAL_WGSL,xyzToRGB,spectralXYZContribution} from '../src/spectral/reconstruction.js';
import {packLens} from '../src/optics/lens-state.js';
import {buildPupilTable} from '../src/optics/pupil-sampling.js';
import {pupilReference} from './pupil-reference.js';
const button=document.querySelector('#run'),progress=document.querySelector('#progress'),result=document.querySelector('#result');
const check=(x,m)=>{if(!x)throw new Error(m);};
button.onclick=async function runTest(){
 button.disabled=true;const errors=[],resources=[];let device;
 try{
  const adapter=await navigator.gpu.requestAdapter();check(adapter,'WebGPU unavailable');
  const timestamp=adapter.features.has('timestamp-query');device=await adapter.requestDevice({requiredFeatures:timestamp?['timestamp-query']:[]});
  device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
  const buffer=(data,usage)=>{const b=device.createBuffer({size:typeof data==='number'?data:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST});if(typeof data!=='number')device.queue.writeBuffer(b,0,data);resources.push(b);return b;};
  const storage=data=>buffer(data,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC),uniform=data=>buffer(data,GPUBufferUsage.UNIFORM);
  const module=device.createShaderModule({code:optical+SAMPLING_WGSL+SPECTRAL_WGSL+pupil+kernel});
  const info=await module.getCompilationInfo();check(!info.messages.some(m=>m.type==='error'),info.messages.map(m=>m.message).join('\n'));
  const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
  const options=new URLSearchParams(location.search),id=options.get('lens')??'zeiss-otus-55mm-f1-4';
  const lens=(await(await fetch(`/lenses/${id}.json`)).json()).configurations[Number(options.get('config')??0)];
  const p=packLens(lens,{sensorZMm:id==='zeiss-otus-55mm-f1-4'?lens.lastVertexZMm+1.373:lens.sensorZMm}),table=buildPupilTable(lens,p);
  const U=uniform(p.parameters),S=storage(p.surfaces),L=storage(p.lut.values),T=uniform(table.data),Q=uniform(new Uint8Array(32));
  const lanes=256,count=256,N=lanes*count,O=storage(lanes*48);
  const read=buffer(lanes*48,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
  let qs,timeResolve,timeRead;
  if(timestamp){qs=device.createQuerySet({type:'timestamp',count:2});timeResolve=buffer(16,GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC);timeRead=buffer(16,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);}
  const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[[0,U],[1,S],[2,L],[3,Q],[4,O],[20,T]].map(([binding,buffer])=>({binding,resource:{buffer}}))});
  let interrupted=false;const track=()=>{if(document.visibilityState!=='visible'||!document.hasFocus())interrupted=true;};

  async function run(enabled,h,nm,seed,offset=0,blockCount=count){
    const samples=blockCount*lanes;
    const data=table.data.slice();if(!enabled)data[3]=0;device.queue.writeBuffer(T,0,data);
    const bytes=new ArrayBuffer(32);new Float32Array(bytes).set([h,0,nm,0]);new Uint32Array(bytes).set([blockCount,seed,offset,0],4);device.queue.writeBuffer(Q,0,bytes);
    const wall=performance.now(),e=device.createCommandEncoder(),pass=e.beginComputePass(timestamp?{timestampWrites:{querySet:qs,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}}:{});
    pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(lanes/64);pass.end();
    if(timestamp){e.resolveQuerySet(qs,0,2,timeResolve,0);e.copyBufferToBuffer(timeResolve,0,timeRead,0,16);}
    e.copyBufferToBuffer(O,0,read,0,lanes*48);device.queue.submit([e.finish()]);
    await read.mapAsync(GPUMapMode.READ);const values=new Float32Array(read.getMappedRange());
    let energy=0,passCount=0,sum2=0,maxWeight=0,numerical=0,omitted=0;const xyz=[0,0,0];
    for(let i=0;i<lanes;i++){const j=i*12;for(let k=0;k<3;k++)xyz[k]+=values[j+k];energy+=values[j+3];passCount+=values[j+4];sum2+=values[j+5];maxWeight=Math.max(maxWeight,values[j+6]);numerical+=values[j+7];omitted+=values[j+8];}
    read.unmap();let ms=performance.now()-wall;
    if(timestamp){await timeRead.mapAsync(GPUMapMode.READ);const t=new BigUint64Array(timeRead.getMappedRange());ms=Number(t[1]-t[0])/1e6;timeRead.unmap();}
    return {attempts:samples,energy:energy/samples,rgb:xyzToRGB(xyz.map(x=>x/samples)),passRate:passCount/samples,secondMoment:sum2/samples,maxWeight,numerical,omitted:omitted/samples,ms,wallMs:performance.now()-wall};
  }
  progress.textContent='独立 f64 全域参考积分…';await new Promise(r=>setTimeout(r,0));
  const reference=pupilReference(lens,p,0,550,{fine:384});
  const whiteXYZ=[0,0,0];
  // Spectral reference uses independent f64 quadrature at 32 wavelengths.
  // The refined support comes from the independent GLOBAL scan, not our table.
  for(let i=0;i<32;i++){
    progress.textContent=`独立光谱参考 ${i+1}/32…`;await new Promise(r=>setTimeout(r,0));
    const nm=380+(i+.5)*400/32,ref=pupilReference(lens,p,0,nm,{fine:192,box:reference.box});
    const xyz=spectralXYZContribution([1,1,1],nm,1/400,ref.energy);
    for(let k=0;k<3;k++)whiteXYZ[k]+=xyz[k]/32;
  }
  const referenceRGB=xyzToRGB(whiteXYZ);
  if(!options.has('autorun')){
    progress.textContent='参考计算完成，点击开始 GPU 计时。';button.disabled=false;button.textContent='开始 GPU 计时';
    await new Promise(resolve=>{button.onclick=()=>{button.disabled=true;resolve();};});
    button.onclick=runTest;button.textContent='开始出瞳 GPU 对比';
  }
  interrupted=false;track();document.addEventListener('visibilitychange',track);window.addEventListener('blur',track);
  const comparisons=[];
  // Warm both branches; compile/warmup excluded from all reported timings.
  await run(false,0,550,42);await run(true,0,550,42);
  for(const h of [0,5,15])for(const nm of [390,550,770]){
    progress.textContent=`像高 ${h}mm / ${nm}nm：全域与混合分布对比…`;
    const original=await run(false,h,nm,123),importance=await run(true,h,nm,123);
    comparisons.push({h,nm,original,importance});
    const error=Math.abs(original.energy-importance.energy);
    const sigma=Math.sqrt((original.secondMoment-original.energy**2+importance.secondMoment-importance.energy**2)/N);
    check(error<5*sigma+.005*Math.max(original.energy,importance.energy),'Original/importance radiometry mismatch');
  }
  const trials=[];
  for(let seed=1;seed<=12;seed++){
    progress.textContent=`等 GPU 时间白色环境 / 光谱色彩误差 ${seed}/12…`;
    // Equal measured GPU budgets. Actual work (rather than pass-rate alone)
    // determines the sample count. The last dispatch may overshoot; save it.
    const pair={};
    for(const enabled of (seed%2?[false,true]:[true,false])){
      let ms=0,energy=0,attempts=0,nextCount=64;const rgb=[0,0,0];
      do{const a=await run(enabled,0,0,seed,attempts,nextCount);ms+=a.ms;energy+=a.energy*a.attempts;for(let k=0;k<3;k++)rgb[k]+=a.rgb[k]*a.attempts;attempts+=a.attempts;
        nextCount=Math.max(1,Math.min(count,Math.floor((40-ms)/a.ms*nextCount)));
      }while(ms<40);
      pair[enabled?'importance':'original']={ms,attempts,energy:energy/attempts,rgb:rgb.map(x=>x/attempts)};
    }
    trials.push(pair);
  }
  const convergence=[];
  if(new URLSearchParams(location.search).has('curve')){
    for(let seed=21;seed<=28;seed++)for(const enabled of (seed%2?[false,true]:[true,false])){
      let ms=0,energy=0,attempts=0,nextCount=8;const rgb=[0,0,0];
      for(const budget of [2,8,32,128,512]){
        progress.textContent=`实际收敛时间 ${enabled?'混合':'全域'} / seed ${seed} / ${budget}ms…`;
        while(ms<budget){
          const a=await run(enabled,0,0,seed,attempts,nextCount);ms+=a.ms;energy+=a.energy*a.attempts;
          for(let k=0;k<3;k++)rgb[k]+=a.rgb[k]*a.attempts;attempts+=a.attempts;
          nextCount=Math.max(1,Math.min(count,Math.floor((budget-ms)/a.ms*nextCount)));
        }
        convergence.push({seed,enabled,budget,ms,attempts,rgb:rgb.map(x=>x/attempts),energy:energy/attempts});
        nextCount=Math.min(count,Math.max(8,nextCount));
      }
    }
  }
  const convergenceSummary=[];
  for(const enabled of [false,true])for(const budget of [2,8,32,128,512]){
    const r=convergence.filter(x=>x.enabled===enabled&&x.budget===budget);if(!r.length)continue;
    const mse=r.reduce((s,x)=>s+x.rgb.reduce((t,v,k)=>t+(v-referenceRGB[k])**2,0)/3,0)/r.length;
    convergenceSummary.push({enabled,budget,meanMs:r.reduce((s,x)=>s+x.ms,0)/r.length,mse,relativeRGBRMSE:Math.sqrt(mse)/(referenceRGB.reduce((s,x)=>s+x,0)/3)});
  }
  track();document.removeEventListener('visibilitychange',track);window.removeEventListener('blur',track);
  const mse=key=>trials.reduce((s,r)=>s+r[key].rgb.reduce((q,c,k)=>q+(c-referenceRGB[k])**2,0)/3,0)/trials.length;
  const originalMSE=mse('original'),importanceMSE=mse('importance');
  const meanRGB=[0,1,2].map(k=>trials.reduce((s,t)=>s+t.importance.rgb[k],0)/trials.length);
  for(let k=0;k<3;k++){
    const variance=trials.reduce((s,t)=>s+(t.importance.rgb[k]-meanRGB[k])**2,0)/(trials.length-1);
    check(Math.abs(meanRGB[k]-referenceRGB[k])<5*Math.sqrt(variance/trials.length)+.01*Math.abs(referenceRGB[k]),'White spectral reference mismatch');
  }
  if(id==='zeiss-otus-55mm-f1-4')check(importanceMSE<originalMSE*.2,'Equal-time RGB error did not improve');check(!errors.length,errors.join('\n'));
  const report={passed:true,lens:id,fNumber:p.fNumber,sensorZMm:p.sensorZMm,region:p.region,browser:navigator.userAgent,adapter:adapter.info.toJSON?.()??{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device},timestamp,interrupted,foreground:document.visibilityState==='visible'&&document.hasFocus(),buildMs:table.buildMs,reference,referenceRGB,meanRGB,comparisons,trials,convergence,convergenceSummary,originalMSE,importanceMSE,equalTimeMSEGain:originalMSE/importanceMSE,errors};
  result.textContent=JSON.stringify(report,null,2);
  const reports=JSON.parse(sessionStorage.getItem('pupilReports')??'[]');reports.push(report);sessionStorage.setItem('pupilReports',JSON.stringify(reports));
  const link=document.createElement('a');link.textContent='下载完整 JSON 报告';link.download='pupil-gpu.json';link.href=URL.createObjectURL(new Blob([JSON.stringify(reports,null,2)],{type:'application/json'}));document.body.appendChild(link);progress.textContent='完成';document.body.dataset.passed='true';
 }catch(error){result.textContent=JSON.stringify({passed:false,error:error.stack,errors});progress.textContent='失败';document.body.dataset.passed='false';}
 finally{for(const b of resources)b.destroy();device?.destroy();button.disabled=false;}
};

if(new URLSearchParams(location.search).has("autorun"))button.click();
