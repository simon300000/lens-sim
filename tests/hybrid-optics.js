import * as THREE from 'three/webgpu';
import {texture,float} from 'three/tsl';
import {createLensRig,stripedPanel,emissivePanel,focusTestLens} from './gpu-fixtures.js';
import {paraxialSensorZ} from '../src/optics/lens-state.js';
import {outputRendererOptions,probeHDRCanvas,displayOutputNode} from '../src/hdr-output.js';
import {runSpectralProbe} from './spectral-optical-probe.js';
import {runOpticalPathProbe} from './optical-path-probe.js';

const out=document.querySelector('#result');
function check(condition,message){if(!condition)throw new Error(message);}
const step=label=>{console.log('[step] '+label+' '+performance.now().toFixed(0));out.textContent=label;};
try{
  const start=performance.now(),adapter=await navigator.gpu.requestAdapter(),hdr=await probeHDRCanvas(adapter);
  const renderer=new THREE.WebGPURenderer({antialias:false,...outputRendererOptions(hdr.supported)});await renderer.init();renderer.setSize(720,480);
  renderer.toneMapping=THREE.NoToneMapping;renderer.outputColorSpace=THREE.SRGBColorSpace;document.body.appendChild(renderer.domElement);
  const scene=new THREE.Scene();
  const camera=new THREE.PerspectiveCamera(40,1.5,.02,450);camera.updateMatrixWorld();
  // Registered emissive geometry only (striped panels are real strips).
  stripedPanel(scene,{x:-1.2,z:-5,w:1.5,h:2,color:[2,.15,.05]});stripedPanel(scene,{z:-10,w:1.5,h:2,color:[.1,1.5,.2]});stripedPanel(scene,{x:2,z:-15,w:1.5,h:2,color:[.1,.2,3]});
  // Asymmetric top-left yellow / bottom-right cyan marker, finite emitter patch.
  emissivePanel(scene,{x:-1,y:1.5,z:-9.99,w:.5,h:.5,color:[4,4,.05]});emissivePanel(scene,{x:2,y:-1,z:-9.99,w:.4,h:.4,color:[.05,3,3]});
  emissivePanel(scene,{x:.4,y:.4,z:-9.98,w:.025,h:.025,color:[20,20,20]});
  const id=new URLSearchParams(location.search).get('lens')??'zemax-55';
  const asset=await(await fetch(`/lenses/${id}.json`)).json(),lens=asset.configurations.find(Boolean);
  const {interop,sceneResources,lighting,engine}=await createLensRig({renderer,scene,camera,width:96}),errors=[];interop.device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
  step('rig ready');
  const spectralProbe=await runSpectralProbe(interop);
  step('spectral probe done');
  const opticalPathProbe=await runOpticalPathProbe(interop);
  step('optical path probe done');
  engine.setLens(lens,{fNumber:2.8,sensorZMm:paraxialSensorZ(lens,10),dispersion:false});
  const initialCompilations=interop.compilations;
  const pipeline=new THREE.RenderPipeline(renderer);pipeline.outputNode=displayOutputNode(texture(engine.texture),float(1),hdr.supported);
  for(let i=0;i<8;i++)engine.sample({targetSpp:8,batchSpp:1,constantEnvironment:[1,1,1]});
  step('prefix sampled');
  const a=await engine.readAccumulation();engine.reset();
  for(let i=0;i<2;i++)engine.sample({targetSpp:8,batchSpp:4,constantEnvironment:[1,1,1]});
  const b=await engine.readAccumulation(),af=new Float32Array(a),bf=new Float32Array(b),au=new Uint32Array(a),bu=new Uint32Array(b);
  let prefixError=0;
  for(let p=0;p<96*64;p++){
    check(au[p*16+3]===8&&bu[p*16+3]===8,'attempted budget mismatch');
    for(let c=0;c<3;c++)prefixError=Math.max(prefixError,Math.abs(af[p*16+c]-bf[p*16+c]));
    for(let c=3;c<16;c++)check(au[p*16+c]===bu[p*16+c],'batched integer/status prefix changed');
  }
  check(prefixError<1e-5,'batch prefix XYZ mismatch');
  const stats=await engine.statistics();check(stats.numericalErrorRate===0,'Numerical errors are not physical vignetting');
  async function uniformEnergy(fNumber,samplingScale=1){
    engine.setLens(lens,{fNumber,sensorZMm:paraxialSensorZ(lens,10),dispersion:false,samplingScale});
    for(let i=0;i<128;i++)engine.sample({targetSpp:512,batchSpp:4,constantEnvironment:[16,16,16]});
    const raw=await engine.readAccumulation(),f=new Float32Array(raw);let y=0;
    for(let p=0;p<96*64;p++)y+=f[p*16+1]/512;
    const pixels=await interop.readTexture(engine.outputGPU);let peak=0;for(let i=0;i<pixels.length;i++)if(i%4!==3)peak=Math.max(peak,pixels[i]);
    return {meanY:y/(96*64),...(await engine.statistics()),peak};
  }
  step('prefix compared');
  const open=await uniformEnergy(2.8),stopped=await uniformEnergy(5.6),expanded=await uniformEnergy(2.8,2);
  check(stopped.meanY<open.meanY*.5&&stopped.opticalPassRate<open.opticalPassRate,'Blocked paths were normalized away');
  check(Math.abs(expanded.meanY/open.meanY-1)<.025,'Sampling area/PDF changed converged radiance');
  check(open.peak>1,'Optical HDR output lost values above one');
  const energy={open,stopped,expanded,pdfRatio:expanded.meanY/open.meanY};
  engine.setLens(lens,{fNumber:2.8,sensorZMm:paraxialSensorZ(lens,10),dispersion:false});
  step('energy done');
  const target=await engine.referenceTarget();check(target.status===4&&Math.abs(target.distanceM-10)<.3,'AF reference target mapping failed: '+JSON.stringify({target,stats}));
  const focusNear=focusTestLens(engine,lens,5),focusFar=focusTestLens(engine,lens,15);
  check(focusNear.lens.sensorZMm>focusFar.lens.sensorZMm,'AF sensor position must change with target distance');
  check(focusNear.afterRmsMm<=focusNear.beforeRmsMm+1e-5&&focusFar.afterRmsMm<=focusFar.beforeRmsMm+1e-5,'AF search did not improve pupil-grid RMS');
  step('af done');
  engine.setLens(focusNear.lens,{sensorZMm:focusNear.lens.sensorZMm,fNumber:2.8,dispersion:true});
  for(let i=0;i<16;i++){engine.sample({batchSpp:4,targetSpp:64});await interop.device.queue.onSubmittedWorkDone();}
  step('scene samples done');pipeline.render();await interop.device.queue.onSubmittedWorkDone();step('display rendered');
  const image=await interop.readTexture(engine.outputGPU);check(image.every(Number.isFinite),'Nonfinite optical output');
  check(lighting.refreshes===1&&sceneResources.counters.fullBuilds===1,'Static accumulation rebuilt BVH or refreshed raster resources');check(interop.compilations===initialCompilations,'Optics parameter caused recompile');
  check(errors.length===0,'GPU validation errors: '+errors.join('\n'));
  const result={passed:true,lens:id,surfaces:lens.surfaces.length,width:96,height:64,spp:engine.spp,prefixError,stats,energy,target,focusNear,focusFar,spectralProbe,opticalPathProbe,lightingRefreshes:lighting.refreshes,bvh:sceneResources.stats,pipelines:interop.compilations,memoryBytes:engine.memoryBytes,computeMs:engine.computeMs,timestampSupported:engine.timestampSupported,initializationAndTestsMs:performance.now()-start,finite:true,imagePeak:Math.max(...image),errors};
  out.textContent=JSON.stringify(result,null,2);document.body.dataset.passed='true';window.__opticalTest={result,engine,renderer,interop};
}catch(error){out.textContent=error.message+'\n'+(error.stack||String(error));document.body.dataset.passed='false';console.error(error);}
