import * as THREE from 'three/webgpu';
import {uniform,vec4} from 'three/tsl';
import {createHybridRuntime} from '../src/rendering/hybrid-runtime.js';
import {probeHDRCanvas,outputRendererOptions} from '../src/hdr-output.js';
import {emitter} from './gpu-fixtures.js';
/** Test E: scheduling and lifecycle of the geometry-first-hit runtime.
 * What each change may (and may not) rebuild or refresh is asserted with the
 * runtime's own counters. */
const out=document.querySelector('#result'),errors=[];
const check=(c,m)=>{if(!c)throw new Error(m);};
try{
  const adapter=await navigator.gpu.requestAdapter(),hdr=await probeHDRCanvas(adapter);
  const renderer=new THREE.WebGPURenderer({antialias:false,...outputRendererOptions(hdr.supported)});await renderer.init();renderer.setSize(300,200);
  renderer.toneMapping=THREE.NoToneMapping;renderer.outputColorSpace=THREE.SRGBColorSpace;document.body.appendChild(renderer.domElement);
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  const scene=new THREE.Scene();
  const plane=new THREE.Mesh(new THREE.PlaneGeometry(8,8),emitter([8,2,.5]));plane.position.z=-10;scene.add(plane);
  const blocker=new THREE.InstancedMesh(new THREE.BoxGeometry(.3,.3,.3),new THREE.MeshStandardNodeMaterial({color:0x777777}),2);
  const o=new THREE.Object3D();o.position.set(-1,0,-6);o.updateMatrix();blocker.setMatrixAt(0,o.matrix);o.position.set(1,0,-6);o.updateMatrix();blocker.setMatrixAt(1,o.matrix);scene.add(blocker);
  const sun=new THREE.DirectionalLight(0xffffff,2);sun.position.set(2,5,3);sun.castShadow=true;scene.add(sun,sun.target);
  const camera=new THREE.PerspectiveCamera(40,1.5,.02,450);camera.updateMatrixWorld();
  const raster=new THREE.RenderPipeline(renderer);raster.outputNode=vec4(.1,.1,.1,1);
  let wakes=0;
  const runtime=await createHybridRuntime({renderer,scene,camera,rasterPipeline:raster,cameraExposure:uniform(1),hdr,requestFrame:()=>wakes++});
  runtime.interop.device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
  await runtime.initialize();const store=runtime.store,res=runtime.sceneResources,light=runtime.lighting;
  check(store.getState().renderModel.id==='geometry-first-hit-realtime-lighting','render model not exposed');
  check(store.getState().scene.status==='ready'&&store.getState().scene.summary.instances===3,'scene summary missing');
  await store.dispatch('setResolution',240);await store.dispatch('setTargetSpp',4);await store.dispatch('setMode','lens');
  for(let i=0;i<4;i++){runtime.frame();await runtime.interop.device.queue.onSubmittedWorkDone();await new Promise(r=>setTimeout(r,0));}
  const builds=()=>{const {fullBuilds,tlasRebuilds,blasBuilt,blasReused}=res.counters;return JSON.stringify({fullBuilds,tlasRebuilds,blasBuilt,blasReused});};
  const after=store.getState(),revision=after.revisions.accumulation,refreshes=light.refreshes,built=builds();
  check(runtime.engine.spp===4,'real samples not accumulated');
  // Static accumulation: no BVH work, no raster resource refresh per batch.
  await store.dispatch('setTargetSpp',8);for(let i=0;i<4;i++){runtime.frame();await runtime.interop.device.queue.onSubmittedWorkDone();await new Promise(r=>setTimeout(r,0));}check(runtime.engine.spp===8,'raising spp did not continue prefix');
  check(light.refreshes===refreshes&&builds()===built,'static accumulation re-rendered raster resources or rebuilt BVH');
  // Display-only changes.
  await store.dispatch('setExposureEV',1);await store.dispatch('setBloom',false);await store.dispatch('setOutput','sdr');runtime.frame();
  check(runtime.engine.spp===8&&store.getState().revisions.accumulation===revision,'display change reset optics');
  check(light.refreshes===refreshes&&builds()===built,'display change refreshed resources or rebuilt BVH');
  await store.dispatch('setDiagnostic','scene-error');runtime.frame();check(runtime.engine.spp===8,'resolve-only diagnostic reset accumulation');
  await store.dispatch('setDiagnostic','geometry-normal');check(runtime.engine.spp===0,'accumulating diagnostic did not restart samples');
  await store.dispatch('setDiagnostic','beauty');
  await store.dispatch('setPaused',true);const beforePause=runtime.engine.spp;runtime.frame();check(runtime.engine.spp===beforePause,'pause dispatched samples');
  await store.dispatch('reset');runtime.frame();
  const empty=await runtime.interop.readTexture(runtime.engine.outputGPU);
  check(runtime.engine.spp===0&&empty.every((v,i)=>i%4===3||v===0),'paused reset displays stale image');
  const opticsBefore=JSON.stringify(store.getState().optics);let rejected=false;
  try{await store.dispatch('setImageDistance',-1);}catch{rejected=true;}
  check(rejected&&JSON.stringify(store.getState().optics)===opticsBefore,'invalid optical update not transactional');
  // AF on the REAL scene: chief ray hits the blocker? No: it is at x=+-1. It hits the plane at 10 m.
  await store.dispatch('autofocus');
  const af=store.getState().af.lastResult;check(af.target&&!af.target.infinity&&Math.abs(af.target.distanceM-10)<.05,'AF did not use the real BVH target: '+JSON.stringify(af.target));
  const pending=store.dispatch('autofocus');await store.dispatch('setFNumber',4);await pending.catch(()=>{});
  check(store.getState().af.status!=='busy','stale autofocus permanently blocked sampling');
  await store.dispatch('setFocusDistance',5);const near=store.getState().optics.imageDistanceMm;
  await store.dispatch('setFocusDistance',15);const far=store.getState().optics.imageDistanceMm;
  check(near>far,'manual distance did not use real shared focus model');
  await store.dispatch('setFNumber',22);await store.dispatch('setFocusDistance',null);
  const infinity=store.getState().af.lastResult;
  check(infinity.beams>=16&&infinity.beamBudget===65536,'small-aperture infinity focus did not use its fixed budget');
  await store.dispatch('setFNumber',4);
  check(light.refreshes===refreshes&&builds()===built,'aperture/focus changes refreshed raster resources or rebuilt BVH');
  await store.dispatch('setPaused',false);
  // Drive frames like requestAnimationFrame would: a batch in flight blocks the next submission.
  for(let i=0;i<64&&runtime.needsFrame();i++){runtime.frame();await runtime.interop.device.queue.onSubmittedWorkDone();await new Promise(r=>setTimeout(r,0));}
  check(!runtime.needsFrame()&&runtime.engine.spp===8,'target did not stop scheduler at 8 spp: '+runtime.engine.spp);
  const stats=await runtime.engine.statistics();check(stats.numericalErrorRate===0&&stats.bvhErrorRate===0,'runtime numerical/BVH errors');
  // Camera pose: lighting resources refresh once (reflector/pose), BVH untouched.
  camera.position.x+=.01;camera.updateMatrixWorld();runtime.cameraChanged();runtime.frame();
  check(light.refreshes===refreshes+1&&builds()===built,'camera move rebuilt BVH or skipped resource refresh');
  check(store.getState().revisions.camera===1&&runtime.engine.spp<=4,'camera move did not reset accumulation');
  // Lighting/time: refresh, no BVH work.
  sun.intensity=3;runtime.lightingChanged();runtime.frame();
  check(light.refreshes===refreshes+2&&builds()===built,'lighting change rebuilt BVH');
  // Instance transform: TLAS-only rebuild, BLAS reused; AF sees the moved surface.
  o.position.set(0,0,-6);o.updateMatrix();blocker.setMatrixAt(0,o.matrix);blocker.instanceMatrix.needsUpdate=true;blocker.instanceMatrix.version++;
  const tlasResult=await runtime.sceneChanged();
  check(tlasResult?.reason==='tlas'&&res.counters.tlasRebuilds===1&&res.counters.blasBuilt===JSON.parse(built).blasBuilt,'instance move did not do a TLAS-only rebuild: '+JSON.stringify(res.counters));
  await store.dispatch('autofocus');const moved=store.getState().af.lastResult.target;
  check(Math.abs(moved.distanceM-(6-.15))<.05,'AF did not see the moved instance: '+JSON.stringify(moved));
  // Material-only edit: table upload only.
  const uploads=res.counters.materialUploads;plane.material.emissive.setRGB(1,1,1);plane.material.version++;
  const materialResult=await runtime.sceneChanged();
  check(materialResult?.reason==='material'&&res.counters.materialUploads===uploads+1&&res.counters.tlasRebuilds===1,'material edit triggered BVH work');
  // Geometry topology: rebuild only that BLAS.
  const blasBefore=res.counters.blasBuilt;plane.geometry.dispose();plane.geometry=new THREE.PlaneGeometry(4,4,2,2);
  await runtime.sceneChanged();
  check(res.counters.blasBuilt===blasBefore+1,'topology change rebuilt more than the changed BLAS: '+JSON.stringify(res.counters));
  // Lens switch and native configuration retain old behaviour.
  await store.dispatch('selectLens','7artisans-af-135mm-f1-8-max');await store.dispatch('selectConfiguration',1);
  const finiteNative=store.getState().optics;
  check(finiteNative.focusDistanceM===6.4&&Math.abs(finiteNative.imageDistanceMm-1)<1e-6,'finite configuration lost native image plane/conjugate');
  let focusFailure='';try{await store.dispatch('setFocusDistance',.1);}catch(error){focusFailure=error.message;}
  check(focusFailure&&JSON.stringify(store.getState().optics)===JSON.stringify(finiteNative)&&store.getState().af.status==='error','invalid focus must visibly preserve native optical state');
  const nativeSensor=runtime.engine.packed.sensorZMm,nativeSurfaces=Array.from(runtime.engine.packed.surfaces),nativeStop=runtime.engine.packed.stopRadiusMm;
  const motionPipelines=runtime.interop.compilations,motionBuilds=builds();
  await store.dispatch('setFocusDistance',20);
  check(store.getState().af.status==='success'&&store.getState().optics.focusModel.includes('cfgs.thi'),'configuration motion was not used');
  check(runtime.engine.packed.sensorZMm===nativeSensor,'configuration focus moved sensor');
  check(JSON.stringify(Array.from(runtime.engine.packed.surfaces))!==JSON.stringify(nativeSurfaces),'configuration focus did not upload moved surfaces');
  check(Math.abs(runtime.engine.packed.stopRadiusMm-nativeStop)<1e-5,'focus changed physical stop opening');
  await store.dispatch('autofocus');check(store.getState().af.lastResult.source==='cfgs.thi / cfgs.obj','AF did not use group motion');
  const configurationMotion=store.getState().af.lastResult;
  await store.dispatch('selectLens','sony-fe-16-35mm-f2-8-gm-ii');
  const camSensor=runtime.engine.packed.sensorZMm;
  await store.dispatch('setFocusDistance',null);const camInfinity=Array.from(runtime.engine.packed.surfaces);
  await store.dispatch('setFocusDistance',1);
  check(store.getState().af.lastResult.source==='zoomcam.focus'&&runtime.engine.packed.sensorZMm===camSensor,'explicit table focus moved sensor / used fallback');
  check(JSON.stringify(Array.from(runtime.engine.packed.surfaces))!==JSON.stringify(camInfinity),'explicit table did not upload moved surfaces');
  const tableMotion=store.getState().af.lastResult;
  check(runtime.interop.compilations===motionPipelines&&builds()===motionBuilds,'focus motion rebuilt pipelines or BVH');
  await store.dispatch('setMode','lens');runtime.frame();await runtime.interop.device.queue.onSubmittedWorkDone();
  await store.dispatch('selectLens','hasselblad-xcd-65mm-f2-8');
  const contactNative=store.getState().optics;
  check(contactNative.imageDistanceMm===0&&runtime.engine.packed.region.directional,'native zero-gap lens did not initialize');
  await store.dispatch('setImageDistance',.026);
  check(Math.abs(store.getState().optics.imageDistanceMm-.026)<1e-12,'short manual image distance is still restricted');
  await store.dispatch('setImageDistance',0);
  check(store.getState().optics.imageDistanceMm===0,'manual zero-gap image plane rejected');

  // Camera/light invalidation must not strand a CPU-worker lens request in loading.
  const originalPrepare=runtime.engine.prepareLens;
  let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  runtime.engine.prepareLens=async(...args)=>{enter();await gate;return originalPrepare(...args);};
  const changingLens=store.dispatch('selectLens','canon-fl-50mm-f1-8');
  await entered;let invalidLensRejected=false;try{await store.dispatch('selectLens','missing-lens-fixture');}catch{invalidLensRejected=true;}
  check(invalidLensRejected,'Invalid lens was accepted');
  runtime.cameraChanged();runtime.lightingChanged();release();await changingLens;
  runtime.engine.prepareLens=originalPrepare;
  check(store.getState().status==='ready','Camera/light change stranded worker lens loading');
  await store.dispatch('setTargetSpp',64);await store.dispatch('setPaused',false);await store.dispatch('reset');
  await runtime.interop.device.queue.onSubmittedWorkDone();
  runtime.frame();runtime.frame();const submitted=runtime.engine.spp;runtime.frame();
  check(submitted===8&&runtime.engine.spp===submitted,'Render submission escaped two-batch bound');
  await store.dispatch('reset');check(runtime.engine.spp===0,'In-flight reset did not clear sample count');
  await runtime.interop.device.queue.onSubmittedWorkDone();runtime.frame();
  await runtime.interop.device.queue.onSubmittedWorkDone();
  const boundedSubmission={submittedBeforeReset:submitted,afterReset:runtime.engine.spp,loadingRecovered:store.getState().status==='ready'};

  // Repeated lens switching / resize / pause: no GPU errors, no leaked tiles.
  const cycle=async()=>{await store.dispatch('selectLens','canon-fl-50mm-f1-8');await store.dispatch('setResolution',480);await store.dispatch('setResolution',240);await store.dispatch('setPaused',true);await store.dispatch('setPaused',false);runtime.frame();};
  await cycle();await runtime.interop.device.queue.onSubmittedWorkDone();
  const memoryBefore=runtime.engine.memoryBytes,buffersBefore=runtime.interop.liveBuffers;
  for(let i=0;i<3;i++){await store.dispatch('selectLens','canon-fl-50mm-f1-8');await store.dispatch('setResolution',480);await store.dispatch('setResolution',240);await store.dispatch('setPaused',true);await store.dispatch('setPaused',false);runtime.frame();}
  await runtime.interop.device.queue.onSubmittedWorkDone();
  check(runtime.engine.memoryBytes===memoryBefore&&runtime.interop.liveBuffers===buffersBefore,`GPU buffers leaked across lens/resize cycles: ${buffersBefore} -> ${runtime.interop.liveBuffers}`);
  await runtime.interop.readTexture(runtime.engine.outputGPU);check(errors.length===0,'GPU validation: '+errors.join('\n'));
  const result={passed:true,boundedSubmission,counters:res.counters,lightingRefreshes:light.refreshes,lightingStatus:light.status,scene:store.getState().scene.summary,
    afRealTarget:af.target,afMovedTarget:moved,manualFocus:{nearMm:near,farMm:far},smallApertureInfinity:infinity,
    nativeFiniteConfiguration:{focusDistanceM:finiteNative.focusDistanceM,imageDistanceMm:finiteNative.imageDistanceMm,failedFocusReason:focusFailure},configurationMotion,tableMotion,
    contactNativeConfiguration:contactNative,stats,liveBuffers:runtime.interop.liveBuffers,pipelines:runtime.interop.compilations,wakes,errors};
  out.textContent=JSON.stringify(result,null,2);document.body.dataset.passed='true';window.__runtimeTest={runtime,result};
  await fetch('http://127.0.0.1:5175/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'runtime-gpu',...result})}).catch(()=>{});
}catch(error){out.textContent=error.stack||String(error);document.body.dataset.passed='false';console.error(error);
 await fetch('http://127.0.0.1:5175/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'runtime-gpu',passed:false,error:error.stack,errors})}).catch(()=>{});}
