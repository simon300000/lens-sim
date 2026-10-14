import * as THREE from 'three/webgpu';
import {uniform,vec4} from 'three/tsl';
import {createHybridRuntime} from '../src/rendering/hybrid-runtime.js';
import {probeHDRCanvas,outputRendererOptions} from '../src/hdr-output.js';
const out=document.querySelector('#result');
const check=(c,m)=>{if(!c)throw new Error(m);};
try{
  const adapter=await navigator.gpu.requestAdapter(),hdr=await probeHDRCanvas(adapter),errors=[];
  const renderer=new THREE.WebGPURenderer({antialias:false,...outputRendererOptions(hdr.supported)});await renderer.init();renderer.setSize(300,200);
  renderer.toneMapping=THREE.NoToneMapping;renderer.outputColorSpace=THREE.SRGBColorSpace;document.body.appendChild(renderer.domElement);
  const scene=new THREE.Scene();scene.background=new THREE.Color(.1,.1,.1);
  const plane=new THREE.Mesh(new THREE.PlaneGeometry(8,8),new THREE.MeshBasicNodeMaterial({color:new THREE.Color(8,2,.5)}));plane.position.z=-10;scene.add(plane);
  const camera=new THREE.PerspectiveCamera(40,1.5,.02,450);camera.updateMatrixWorld();
  const raster=new THREE.RenderPipeline(renderer);raster.outputNode=vec4(.1,.1,.1,1);
  let wakes=0;
  const runtime=await createHybridRuntime({renderer,scene,camera,rasterPipeline:raster,cameraExposure:uniform(1),hdr,requestFrame:()=>wakes++});
  runtime.interop.device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
  await runtime.initialize();const store=runtime.store;
  await store.dispatch('setResolution',240);await store.dispatch('setTargetSpp',4);await store.dispatch('setMode','lens');
  for(let i=0;i<4;i++)runtime.frame();
  const after=store.getState(),captured=after.diagnostics.captures,revision=after.revisions.accumulation;
  check(runtime.engine.spp===4,'real samples not accumulated');
  await store.dispatch('setExposureEV',1);await store.dispatch('setBloom',false);await store.dispatch('setOutput','sdr');runtime.frame();
  check(runtime.engine.spp===4&&store.getState().revisions.accumulation===revision,'display change reset/retraced optics');
  check(store.getState().diagnostics.captures===captured,'display caused capture');
  await store.dispatch('setTargetSpp',8);for(let i=0;i<4;i++)runtime.frame();check(runtime.engine.spp===8,'raising spp did not continue prefix');
  await store.dispatch('setPaused',true);const beforePause=runtime.engine.spp;runtime.frame();check(runtime.engine.spp===beforePause,'pause dispatched samples');
  await store.dispatch('reset');runtime.frame();
  const empty=await runtime.interop.readTexture(runtime.engine.outputGPU);
  check(runtime.engine.spp===0&&empty.every((v,i)=>i%4===3||v===0),'paused reset displays stale image');
  check(store.getState().diagnostics.attemptedSamples===0,'reset kept stale statistics');
  const opticsBefore=JSON.stringify(store.getState().optics);let rejected=false;
  try{await store.dispatch('setImageDistance',.05);}catch{rejected=true;}
  check(rejected&&JSON.stringify(store.getState().optics)===opticsBefore,'invalid optical update not transactional');
  const pending=store.dispatch('autofocus');await store.dispatch('setFNumber',4);await pending.catch(()=>{});
  check(store.getState().af.status!=='busy','stale autofocus permanently blocked sampling');
  await store.dispatch('setFocusDistance',5);const near=store.getState().optics.imageDistanceMm;
  await store.dispatch('setFocusDistance',15);const far=store.getState().optics.imageDistanceMm;
  check(near>far,'manual distance did not use real shared focus model');
  await store.dispatch('setFNumber',22);await store.dispatch('setFocusDistance',null);
  const infinity=store.getState().af.lastResult;
  check(infinity.beams>=16&&infinity.beamBudget===65536,'small-aperture infinity focus did not use its fixed budget');
  await store.dispatch('setFNumber',4);
  await store.dispatch('setPaused',false);for(let i=0;i<8;i++)runtime.frame();
  check(store.getState().diagnostics.captures===captured,'aperture or focus recaptured static scene');
  check(!runtime.needsFrame(),'target did not stop scheduler');
  const stats=await runtime.engine.statistics();check(stats.numericalErrorRate===0,'runtime numerical errors');check(stats.cacheMissRate<.001,'Frustum-entry artefacts masquerade as cache misses');
  const beforeScene=runtime.cache.captures;runtime.invalidateScene();runtime.frame();check(runtime.cache.captures===beforeScene+1,'scene change did not recapture');
  const sceneChangeCaptures=runtime.cache.captures;
  await store.dispatch('selectLens','7artisans-af-135mm-f1-8-max');await store.dispatch('selectConfiguration',1);
  const finiteNative=store.getState().optics;
  check(finiteNative.focusDistanceM===6.4&&Math.abs(finiteNative.imageDistanceMm-1)<1e-6,'finite configuration lost native image plane/conjugate');
  let focusFailure='';try{await store.dispatch('setFocusDistance',20);}catch(error){focusFailure=error.message;}
  check(focusFailure&&JSON.stringify(store.getState().optics)===JSON.stringify(finiteNative)&&store.getState().af.status==='error','invalid focus must visibly preserve native optical state');
  await runtime.interop.readTexture(runtime.engine.outputGPU);check(errors.length===0,'GPU validation: '+errors.join('\n'));
  const result={passed:true,displayPreservesSamples:true,higherSppContinues:true,pausedResetClearsImage:true,invalidChangeTransactional:true,staleAFDoesNotLock:true,manualFocus:{nearMm:near,farMm:far},smallApertureInfinity:infinity,
    nativeFiniteConfiguration:{focusDistanceM:finiteNative.focusDistanceM,imageDistanceMm:finiteNative.imageDistanceMm,failedFocusReason:focusFailure,failurePreservesState:true},
    staticCaptureCount:captured,sceneChangeCaptures,pipelines:runtime.interop.compilations,stats,wakes,errors};
  out.textContent=JSON.stringify(result,null,2);document.body.dataset.passed='true';window.__runtimeTest={runtime,result};
}catch(error){out.textContent=error.stack||String(error);document.body.dataset.passed='false';console.error(error);}
