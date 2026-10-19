import * as THREE from 'three/webgpu';
import {requiredGPULimits} from '../src/rendering/gpu-policy.js';
import {createLensRig,emissivePanel} from './gpu-fixtures.js';
import {xyzToRGB} from '../src/spectral/reconstruction.js';
import {createOpticalEngine} from '../src/rendering/optical-engine.js';
const out=document.querySelector('#result'),check=(v,m)=>{if(!v)throw new Error(m);};
let rig,renderer;const errors=[],runs=[];
const params=new URLSearchParams(location.search),width=Number(params.get('width')??99),spp=Number(params.get('spp')??64);
const engineOptions={...(params.has('scratchBytes')?{stagedRayBufferBytes:Number(params.get('scratchBytes'))}:{})};
try{
  const started=performance.now();
  const adapter=await navigator.gpu.requestAdapter();
  const device=await adapter.requestDevice({requiredFeatures:[...adapter.features],requiredLimits:requiredGPULimits(adapter.limits)});
  renderer=new THREE.WebGPURenderer({device});await renderer.init();renderer.setSize(120,80);
  const dev=renderer.backend.device,compile=dev.createComputePipelineAsync.bind(dev);
  dev.createComputePipelineAsync=desc=>compile(desc).catch(async error=>{
    const info=await desc.compute.module.getCompilationInfo();
    throw new Error(desc.label+' '+String(error)+' '+JSON.stringify(Array.from(info.messages,m=>({type:m.type,line:m.lineNum,text:m.message}))));
  });
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(40,1.5,.01,100);camera.updateMatrixWorld();
  // Asymmetric coloured geometry, ensuring a mirrored final picture cannot pass.
  emissivePanel(scene,{x:-1,y:.5,z:-6,w:2,h:3,color:[1,.2,.1]});
  emissivePanel(scene,{x:1,y:-.5,z:-5,w:2,h:3,color:[.1,.3,1]});
  rig=await createLensRig({renderer,scene,camera,width,engineOptions});
  const {interop}=rig;
  device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
  const lens=(await(await fetch('/lenses/'+(params.get('lens')??'canon-fl-50mm-f1-8')+'.json')).json()).configurations[0];
  const state={sensorZMm:lens.sensorZMm,dispersion:true};
  const compilationMs=performance.now()-started;
  const original=rig.engine;
  async function render(engine,mirrorReuse,seed=77,constantEnvironment=[1,1,1],mirrorReference=false){
    await engine.prepareSampling({mirrorReference});
    engine.setLens(lens,state);engine.setPose(camera);engine.bindScene();engine.reset();
    let dispatches=0;const begin=performance.now();
    while(engine.spp<spp){engine.sample({batchSpp:4,targetSpp:spp,seed,constantEnvironment,mirrorReuse,mirrorReference,chunked:params.has('chunked')});dispatches++;if(dispatches%16===0)await device.queue.onSubmittedWorkDone();}
    await device.queue.onSubmittedWorkDone();const renderMs=performance.now()-begin;
    const raw=await engine.readAccumulation(),u=new Uint32Array(raw),f=new Float32Array(raw),rgb=[];
    let attempts=0,finite=true,flux=0;
    for(let i=0;i<u.length;i+=16){check(u[i+3]===spp,'missing/duplicated pixel '+i/16+': '+u[i+3]);attempts+=u[i+3];for(let k=0;k<3;k++)finite&&=Number.isFinite(f[i+k]);flux+=f[i+1]/spp;rgb.push(f[i]/spp,f[i+1]/spp,f[i+2]/spp);}
    check(finite,'nonfinite accumulation');
    const stats=await engine.statistics();engine.resolve();await device.queue.onSubmittedWorkDone();
    const texture=await interop.readTexture(engine.outputGPU);check(texture.every(Number.isFinite),'nonfinite resolve');
    for(let pixel=0;pixel<rgb.length/3;pixel++){
      const expected=xyzToRGB(rgb.slice(pixel*3,pixel*3+3)).map(v=>Math.max(0,Math.min(65000,v)));
      for(let c=0;c<3;c++)check(Math.abs(texture[pixel*4+c]-expected[c])<.001*Math.max(1,expected[c]),'resolve/readback row mismatch at '+pixel);
    }
    return {mirrorReuse,seed,tiles:engine.tileCount,size:engine.dimensions,attempts,flux,renderMs,dispatches,stats,raw:u,rgb};
  }
  for(const mirror of [false,true]){out.textContent='Single buffer, mirror='+mirror;const r=await render(original,mirror);runs.push(r);}
  // Force multiple storage buffers without a huge image/readback.
  const tiled=await createOpticalEngine({interop,sceneResources:rig.sceneResources,lighting:rig.lighting,width,...engineOptions,accumulationBindingBytes:width*64*16});
  for(const mirror of [false,true]){
    out.textContent='Paired buffers, mirror='+mirror;
    const r=await render(tiled,mirror);check(r.tiles>1,'multi-tile probe did not tile');
    const ref=runs.find(x=>x.mirrorReuse===mirror);check(r.raw.length===ref.raw.length&&r.raw.every((v,i)=>v===ref.raw[i]),'tile boundaries changed pixel samples');runs.push(r);
  }
  for(const env of [[1,1,1],null]){
    out.textContent='Matched four-ray reference '+(env?'white':'asymmetric scene');
    const reused=await render(original,true,81,env),retraced=await render(original,true,81,env,true);
    let maxRelative=0,maxAbsolute=0;
    for(let i=0;i<reused.rgb.length;i++){
      const delta=Math.abs(reused.rgb[i]-retraced.rgb[i]);maxAbsolute=Math.max(maxAbsolute,delta);
      maxRelative=Math.max(maxRelative,delta/Math.max(1,Math.abs(retraced.rgb[i])));
    }
    check(maxRelative<1e-4,'reflected output differs from explicit four-ray tracing: '+maxRelative);
    for(let i=0;i<reused.raw.length;i++)if(i%16>=3)check(reused.raw[i]===retraced.raw[i],'matched path status differs at '+i);
    runs.push({...reused,referenceComparison:{maxRelative,maxAbsolute}});
  }
  // Same low-level kernel, no cross-group phase assumptions or CPU ray transport.
  const workStatus=await original.setWorkCounting(true);original.reset();original.setPose(camera);
  while(original.spp<4){original.sample({batchSpp:4,targetSpp:4,mirrorReuse:true,constantEnvironment:[1,1,1]});await device.queue.onSubmittedWorkDone();}
  const work=await original.readWork();if(workStatus==='counting')check(work.counts[0]===original.dimensions.width*original.dimensions.height*4,'work path count changed');
  if(workStatus==='counting'){
    check(original.lastSubmission.integrationMode==='staged','diagnostics changed integration mode');
    check(work.integrationMode==='staged','wrong reported work mode');
    check(work.counts[14]===Math.ceil(original.dimensions.width/2)*original.dimensions.height/2*4,'shared optical launch counted more than once');
    const raw=new Uint32Array(await original.readAccumulation());let passed=0;for(let i=10;i<raw.length;i+=16)passed+=raw[i];
    check(work.counts[15]===passed,'camera transforms should only count passed rays');
    const empty=await original.readWork();check(empty.counts.every(v=>v===0)&&empty.workUnits===0&&empty.timedChunks===0&&empty.msPerWorkUnit===null,'previous timing window leaked into empty read');
    await original.setWorkCounting(false);
  }
  check(!errors.length,errors.join('\n'));tiled.dispose();
  window.__mirrorRuns=runs;
  const report={passed:true,integrationMode:original.integrationMode,lens:params.get('lens')??'canon-fl-50mm-f1-8',summary:runs.map(r=>({mirror:r.mirrorReuse,tiles:r.tiles,attempts:r.attempts,reference:r.referenceComparison})),compilationMs,userAgent:navigator.userAgent,foreground:!document.hidden,runs:runs.map(({raw,rgb,...r})=>r),workStatus,work,errors};
  out.textContent=JSON.stringify(report,null,2);document.body.dataset.passed='true';
}catch(error){out.textContent=JSON.stringify({passed:false,error:error.message,stack:error.stack,errors},null,2);document.body.dataset.passed='false';}
finally{rig?.engine.dispose();rig?.sceneResources.dispose();rig?.lighting.dispose();rig?.interop.dispose();renderer?.dispose();}
