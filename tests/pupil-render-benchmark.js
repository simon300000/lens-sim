import './pupil-test-focus.js';
// Equal queue-complete render time through the full production BVH/material/
// spectrum integrator. Table construction, compilation and readback are separate.
import * as THREE from 'three/webgpu';
import {createLensRig,stripedPanel,emissivePanel} from './gpu-fixtures.js';
import {xyzToRGB} from '../src/spectral/reconstruction.js';
import {sweepIds} from './pupil-sweep.js';
import {experimentCases,experimentVariants,prescriptionSummary} from './pupil-diverse-cases.js';
const options=new URLSearchParams(location.search);
const button=document.querySelector('#run'),progress=document.querySelector('#progress'),output=document.querySelector('#result');
const variants=[128,256,512,1024].flatMap(bins=>[false,true].map(movingCenter=>({name:(movingCenter?'moving':'fixed')+bins,bins,movingCenter})));
const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
button.onclick=async()=>{
 button.disabled=true;const width=Math.max(48,Math.round(Number(options.get('width')??48)/3)*3),height=width*2/3,referenceSpp=Number(options.get('refSpp')??16384);let renderer,rig,device,interrupted=false;const errors=[],losses=[];
 const track=()=>{if(document.hidden||!document.hasFocus())interrupted=true;};
 const report={startForeground:!document.hidden&&document.hasFocus(),kind:'render-benchmark',date:new Date().toISOString(),browser:navigator.userAgent,width,height,scene:'32 physical emissive stripes plus finite defocused emissive point; full BVH/material/spectral path',timingKind:'equal queue-complete render wall time; excludes precompute, warmup, reset, readback and resolve',results:[],errors,losses};
 document.addEventListener('visibilitychange',track);window.addEventListener('blur',track);
 try{
  track();renderer=new THREE.WebGPURenderer();await renderer.init();renderer.setSize(96,64);device=renderer.backend.device;
  device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.lost.then(e=>{if(e.reason!=='destroyed')losses.push(e.message);});
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(40,1.5,.01,100);camera.updateMatrixWorld();
  stripedPanel(scene,{z:-1,w:2,h:2,color:[1,.7,.4],stripes:32,dim:.08});
  emissivePanel(scene,{x:.12,y:.04,z:-.7,w:.03,h:.03,color:[5,2,1]});
  const compileStart=performance.now();progress.textContent='编译生产场景积分器…';
  rig=await createLensRig({renderer,scene,camera,width});report.compileAndSceneInitMs=performance.now()-compileStart;report.enginePipelineInitMs=rig.engine.initializationMs;
  const {engine,interop}=rig;report.timestamp=engine.timestampSupported;report.limits={maxUniformBufferBindingSize:device.limits.maxUniformBufferBindingSize};
  const cases=experimentCases(options,sweepIds),diverse=options.get('suite')==='diverse';report.suite=diverse?'diverse':'resolution';
  const budgets=options.has('budget')?[Number(options.get('budget'))]:(diverse?[240]:[80,240]),seeds=[11,29,47,71];report.budgets=budgets;report.seeds=seeds;
  async function image(){
   const raw=await engine.readAccumulation(),f=new Float32Array(raw),u=new Uint32Array(raw),rgb=[];let attempts=0,passed=0;
   for(let i=0;i<f.length;i+=16){attempts+=u[i+3];passed+=u[i+10];rgb.push(...xyzToRGB(Array.from(f.slice(i,i+3)).map(x=>x/Math.max(1,u[i+3]))));}
   if(!rgb.every(Number.isFinite))throw Error('Nonfinite production RGB');
   return {rgb,attempts,passRate:passed/attempts};
  }
  function thumbnail(rgb){const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d'),a=ctx.createImageData(width,height);for(let i=0;i<rgb.length;i++){const v=Math.max(0,rgb[i]);a.data[Math.floor(i/3)*4+i%3]=255*(v/(1+v))**(1/2.2);}for(let i=3;i<a.data.length;i+=4)a.data[i]=255;ctx.putImageData(a,0,0);return canvas.toDataURL('image/png');}
  async function select(lens,v,sensorMm){engine.setLens(lens,{sensorZMm:lens.sensorZMm,sensorMm,pupilBins:v.bins,pupilMovingCenter:v.movingCenter});engine.bindScene();await device.queue.onSubmittedWorkDone();}
  async function warm(){for(let i=0;i<64;i+=4)engine.sample({batchSpp:4,targetSpp:64,seed:42});await device.queue.onSubmittedWorkDone();engine.reset();await device.queue.onSubmittedWorkDone();}
  async function reference(seed){engine.reset();await device.queue.onSubmittedWorkDone();const started=performance.now();for(let i=0;i<referenceSpp;i+=4){engine.sample({batchSpp:4,targetSpp:referenceSpp,seed});if(i%128===0)await device.queue.onSubmittedWorkDone();}await device.queue.onSubmittedWorkDone();const renderMs=performance.now()-started;return {...await image(),renderMs,spp:engine.spp};}
  async function trial(seed,budget){
   engine.reset();await device.queue.onSubmittedWorkDone();const started=performance.now();let batches=0,batchCalls=8;const sampleBatch=width>=192?1:4;
   do{const chunkStart=performance.now();for(let i=0;i<batchCalls;i++){engine.sample({batchSpp:sampleBatch,targetSpp:0,seed});batches++;}await device.queue.onSubmittedWorkDone();const elapsed=performance.now()-started,chunkMs=performance.now()-chunkStart;batchCalls=Math.max(1,Math.min(16,Math.floor((budget-elapsed)/Math.max(.01,chunkMs)*batchCalls)));}while(performance.now()-started<budget);
   const renderMs=performance.now()-started,spp=engine.spp,lastGpuBatchMs=engine.computeMs;track();const readStart=performance.now(),im=await image();
   return {...im,seed,budget,renderMs,spp,batches,lastGpuBatchMs,readbackMs:performance.now()-readStart};
  }
  for(const spec of cases){const {id}=spec,variants=experimentVariants(spec,diverse).filter(v=>!options.has('variants')||options.get('variants').split(',').includes(v.name));
   const lens=(await(await fetch(`/lenses/${id}.json`)).json()).configurations[spec.config],builds=[];
   for(const v of variants){progress.textContent=`预计算 ${id} ${v.name}`;await new Promise(r=>setTimeout(r,0));const started=performance.now();await select(lens,v,spec.sensorMm);const t=engine.pupilTable;builds.push({variant:v.name,selectWallMs:performance.now()-started,buildMs:t.buildMs,precomputeMs:t.precomputeMs,deriveMs:t.deriveMs,coldBuildMs:t.coldBuildMs,physicalCacheHit:t.physicalCacheHit,probes:t.probes});await warm();}
   const referenceVariant=[...variants].reverse().find(x=>x.movingCenter);await select(lens,referenceVariant,spec.sensorMm);await warm();
   progress.textContent=`${id} 独立高采样参考 A…`;const a=await reference(101);progress.textContent=`${id} 独立高采样参考 B…`;const b=await reference(303);
   const ref=a.rgb.map((x,i)=>(x+b.rgb[i])/2),referenceNoiseMSE=mean(a.rgb.map((x,i)=>(x-b.rgb[i])**2))/4;
   const normalization=mean(ref.map(x=>x*x)),rows=[],previews={reference:thumbnail(ref)};
   for(const budget of budgets)for(const seed of seeds){
    const order=seeds.indexOf(seed)%2?[...variants].reverse():variants;
    for(const v of order){
     progress.textContent=`${id} ${v.name} seed=${seed} ${budget}ms`;await select(lens,v,spec.sensorMm);await warm();const row=await trial(seed,budget),mse=mean(row.rgb.map((x,i)=>(x-ref[i])**2));
     if(seed===seeds[0]&&budget===budgets.at(-1)&&['fixed128','fixed1024','moving128','moving1024'].includes(v.name))previews[v.name]=thumbnail(row.rgb);
     delete row.rgb;rows.push({variant:v.name,...row,mse,relativeRMSE:Math.sqrt(mse/normalization)});
    }
   }
   // A high-spp independent seed check at fixed128 tests for estimator drift.
   await select(lens,variants[0],spec.sensorMm);progress.textContent=`${id} 固定128高采样能量复核…`;const fixedReference=await reference(509);
   let angularIdentityMaxError=null;if(diverse&&engine.packed.region.directional){await select(lens,variants.find(v=>v.movingCenter),spec.sensorMm);const angularMoving=await reference(509);angularIdentityMaxError=Math.max(...angularMoving.rgb.map((x,i)=>Math.abs(x-fixedReference.rgb[i])));}
   const energyRatio=mean(fixedReference.rgb)/mean(ref),referenceAgreementRMSE=Math.sqrt(mean(fixedReference.rgb.map((x,i)=>(x-ref[i])**2))/normalization);
   report.results.push({id,...spec,prescription:prescriptionSummary(lens),sensorZMm:lens.sensorZMm,fNumber:engine.packed.fNumber,directional:!!engine.packed.region.directional,angularIdentityMaxError,builds,referenceVariant:referenceVariant.name,reference:{spp:referenceSpp*2,seeds:[101,303],referenceNoiseMSE,normalization,meanRGB:mean(ref),renderMs:a.renderMs+b.renderMs,fixed128EnergyRatio:energyRatio,fixed128RelativeRMSE:referenceAgreementRMSE},rows,previews});
   const div=document.createElement('div');div.textContent=id;for(const [name,url]of Object.entries(previews)){const img=document.createElement('img');img.src=url;img.width=192;img.height=128;img.title=name;div.appendChild(img);}document.querySelector('#images').appendChild(div);if(diverse)await fetch('/__pupil-report',{method:'POST',body:JSON.stringify({...report,partial:true})});
  }
  track();report.partial=false;report.interrupted=interrupted;report.foreground=!document.hidden&&document.hasFocus();report.passed=!errors.length&&!losses.length&&!interrupted;
 }catch(e){report.passed=false;report.error=e.stack;}
 finally{
  document.removeEventListener('visibilitychange',track);window.removeEventListener('blur',track);
  if(rig){rig.engine.dispose();rig.sceneResources.dispose();rig.lighting.dispose();rig.interop.dispose();}renderer?.dispose();button.disabled=false;
  output.textContent=JSON.stringify(report,null,2);document.body.dataset.passed=String(report.passed);progress.textContent=report.passed?'完成（前台，无 GPU API 错误）':'失败／中断';await fetch('/__pupil-report',{method:'POST',body:JSON.stringify(report)});
 }
};
if(new URLSearchParams(location.search).has('autorun'))button.click();
