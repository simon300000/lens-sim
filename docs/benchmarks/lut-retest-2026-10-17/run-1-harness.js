import * as THREE from 'three/webgpu';
import {buildSanteiScene} from '../src/scene/santei-scene.js';
import {createDaylight} from '../src/lighting.js';
import {createGPUInterop} from '../src/rendering/three-interop.js';
import {createSceneResources} from '../src/rendering/scene-resources.js';
import {createLightingResources} from '../src/rendering/lighting-resources.js';
import {createOpticalEngine as base} from '../src/rendering/optical-engine-before-lut.js';
import {createOpticalEngine as candidate} from '../src/rendering/optical-engine.js';
import {runOpticalPathProbe as probeBase} from './optical-path-probe-before-lut.js';
import {runOpticalPathProbe as probeCandidate} from './optical-path-probe.js';
import {packLens} from '../src/optics/lens-state.js';
import {warmRender} from '../src/rendering/startup-warmup.js';
const out=document.querySelector('#out'),button=document.querySelector('#run');let active=false,invalid=[];
function check(){if(invalid.length||document.hidden||!document.hasFocus())throw Error(invalid.join('\n')||'Foreground lost');}
window.addEventListener('blur',()=>{if(active)invalid.push('Foreground lost');});document.addEventListener('visibilitychange',()=>{if(active&&document.hidden)invalid.push('Page hidden');});
const step=s=>{out.textContent=s;document.title=s;};
const save=async(name,data)=>{const r=await fetch('/__integration?name='+encodeURIComponent(name),{method:'POST',body:typeof data==='string'?data:JSON.stringify(data)});if(!r.ok)throw Error('Save '+name+' failed');};
const hash=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b))).map(x=>x.toString(16).padStart(2,'0')).join('');
const distribution=a=>{const b=[...a].sort((x,y)=>x-y),n=b.length;return {n,min:b[0],median:n%2?b[n>>1]:(b[n/2-1]+b[n/2])/2,max:b.at(-1),mean:b.reduce((x,y)=>x+y,0)/n};};
button.onclick=async()=>{
 if(active)return;active=true;invalid=[];button.disabled=true;
 const report={valid:false,baseCommit:'7fbb6ad0015fec24e3e6aa1d0a58e49e9e311f76',candidate:'Only LUT-coordinate hoist, adjacent-medium index reuse and post-intersection field loads; all other merged main changes are shared by both versions',baseOpticalCommit:'7bd1b45',candidateOpticalCommit:'2feb99d',image:[480,320],spp:128,seed:77,rounds:9,timing:'Queue-complete wall time, fixed full-image batch 4 spp, no GPU timestamp query; excludes statistics, readback, hashing and preparation',cases:[],errors:invalid};
 let renderer,interop,resources,lighting;const engines=[];
 try{
  check();report.sources=await(await fetch('/__integration')).json();const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
  report.environment={userAgent:navigator.userAgent,adapter:Object.fromEntries(['vendor','architecture','description'].map(k=>[k,adapter.info[k]]))};
  renderer=new THREE.WebGPURenderer({requiredLimits:{maxStorageBufferBindingSize:adapter.limits.maxStorageBufferBindingSize,maxBufferSize:adapter.limits.maxBufferSize,maxStorageBuffersPerShaderStage:adapter.limits.maxStorageBuffersPerShaderStage}});await renderer.init();const device=renderer.backend.device;device.addEventListener('uncapturederror',e=>invalid.push(e.error.message));device.lost.then(e=>{if(active)invalid.push('Device lost '+e.message);});
  renderer.setSize(96,64);renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.toneMapping=THREE.NoToneMapping;
  interop=createGPUInterop(renderer);step('基线光学/f64 探针');report.probeBase=await probeBase(interop);check();step('候选光学/f64 探针');report.probeCandidate=await probeCandidate(interop);check();await save('lut-progress.json',report);
  const {scene,details}=buildSanteiScene(),daylight=createDaylight(scene,renderer,{details});const camera=new THREE.PerspectiveCamera(40,1.5,.15,450);camera.position.set(21,13,27);camera.lookAt(0,2.7,2);camera.updateMatrixWorld();daylight.update({hour:16.5,date:'2026-09-26'},true);
  const target=new THREE.RenderTarget(96,64,{type:THREE.HalfFloatType});renderer.setRenderTarget(target);step('准备完整场景资源');let t=performance.now();report.rasterWarmup=await warmRender({renderer,scene,camera,render:()=>{check();renderer.render(scene,camera);}});await device.queue.onSubmittedWorkDone();report.rasterPreparationMs=performance.now()-t;renderer.setRenderTarget(null);target.dispose();check();
  resources=createSceneResources({interop,scene,camera,starAngularRadius:0});await resources.build();lighting=createLightingResources({interop,renderer,scene,camera,environment:daylight});lighting.refresh();await device.queue.onSubmittedWorkDone();check();if(!lighting.status.ok)throw Error(lighting.status.errors.join('\n'));report.scene=resources.stats;
  async function trace(e){e.reset();await device.queue.onSubmittedWorkDone();check();const start=performance.now();let submissions=0;while(e.spp<report.spp){e.sample({batchSpp:4,targetSpp:report.spp,seed:report.seed,mirrorReuse:true});await device.queue.onSubmittedWorkDone();submissions++;check();}return {wallMs:performance.now()-start,submissions};}
  for(const id of ['canon-fl-50mm-f1-8','sony-fe-600mm-f4-gm-oss']){
   const lens=(await(await fetch('/lenses/'+id+'.json')).json()).configurations[0];
   for(const mode of ['fused','split']){
    const row={lens:id,integration:mode,fNumber:packLens(lens,{sensorZMm:lens.sensorZMm,dispersion:true}).fNumber,sensorZMm:lens.sensorZMm,trials:[],setup:{},parity:{}};report.cases.push(row);const pair={};
    for(const [name,create]of [['baseline',base],['candidate',candidate]]){step('准备 '+id+' '+mode+' '+name);t=performance.now();const e=await create({interop,sceneResources:resources,lighting,width:480,integrationMode:mode,timingEnabled:false});engines.push(e);pair[name]=e;const compileMs=performance.now()-t;t=performance.now();e.setPose(camera);e.setLens(lens,{fNumber:row.fNumber,sensorZMm:lens.sensorZMm,dispersion:true});row.setup[name]={compileMs,lensPreparationMs:performance.now()-t};e.sample({batchSpp:4,targetSpp:4,seed:77,mirrorReuse:true});await device.queue.onSubmittedWorkDone();check();}
    let ref;
    for(let round=0;round<9;round++){
     const order=round%2?['candidate','baseline']:['baseline','candidate'];
     for(const name of order){step(`${id} ${mode} round ${round+1}/9 ${name}`);const e=pair[name],timing=await trace(e),stats=await e.statistics();check();if(stats.numericalErrorRate||stats.bvhErrorRate||stats.radianceInvalidRate||stats.unsupportedRate)throw Error('Invalid statistics '+JSON.stringify(stats));row.trials.push({round,variant:name,...timing,stats});
      if(round===0){const raw=await e.readAccumulation(),sha=await hash(raw);row.parity[name]={sha256:sha,bytes:raw.byteLength};if(name==='baseline')ref=sha;else if(sha!==ref)throw Error('Raw accumulation/counter mismatch');const r=await fetch('/__integration?name='+id+'-'+mode+'-'+name+'.bin',{method:'POST',body:raw});if(!r.ok)throw Error('Raw save failed');}
      await save('lut-progress.json',report);
     }
    }
    row.summary=Object.fromEntries(['baseline','candidate'].map(name=>[name,distribution(row.trials.filter(x=>x.variant===name).map(x=>x.wallMs))]));row.medianTimeReductionPercent=100*(1-row.summary.candidate.median/row.summary.baseline.median);row.parity.bitwiseEqual=row.parity.baseline.sha256===row.parity.candidate.sha256;
    pair.baseline.dispose();pair.candidate.dispose();engines.length=0;
   }
  }
  check();report.valid=true;document.title='COMPLETE LUT review';
 }catch(e){report.error=e.message+'\n'+e.stack;document.title='INVALID LUT review';}
 finally{active=false;await save('lut-report.json',report);out.textContent=JSON.stringify(report,null,2);for(const e of engines)e.dispose();lighting?.dispose();resources?.dispose();interop?.dispose();renderer?.dispose();button.disabled=false;}
};
