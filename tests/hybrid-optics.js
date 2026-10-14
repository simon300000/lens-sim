import * as THREE from 'three/webgpu';
import {texture,float,uv,step,vec3,sin} from 'three/tsl';
import {createGPUInterop} from '../src/rendering/three-interop.js';
import {createRasterCache} from '../src/rendering/raster-cache.js';
import {createOpticalEngine} from '../src/rendering/optical-engine.js';
import {paraxialSensorZ} from '../src/optics/lens-state.js';
import {outputRendererOptions,probeHDRCanvas,displayOutputNode} from '../src/hdr-output.js';
import {runSpectralProbe} from './spectral-optical-probe.js';
import {runOpticalPathProbe} from './optical-path-probe.js';

const out=document.querySelector('#result');
function check(condition,message){if(!condition)throw new Error(message);}
try{
  const start=performance.now(),adapter=await navigator.gpu.requestAdapter(),hdr=await probeHDRCanvas(adapter);
  const renderer=new THREE.WebGPURenderer({antialias:false,...outputRendererOptions(hdr.supported)});await renderer.init();renderer.setSize(720,480);
  renderer.toneMapping=THREE.NoToneMapping;renderer.outputColorSpace=THREE.SRGBColorSpace;document.body.appendChild(renderer.domElement);
  const interop=createGPUInterop(renderer),errors=[];interop.device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
  const scene=new THREE.Scene();scene.background=new THREE.Color(.2,.25,.35);
  const camera=new THREE.PerspectiveCamera(40,1.5,.02,450);camera.updateMatrixWorld();
  function panel(x,y,z,w,h,color){
    const m=new THREE.MeshBasicNodeMaterial();const grid=sin(uv().x.mul(180)).mul(sin(uv().y.mul(180))).step(0).mul(.75).add(.25);
    m.colorNode=vec3(...color).mul(grid);const p=new THREE.Mesh(new THREE.PlaneGeometry(w,h),m);p.position.set(x,y,z);scene.add(p);
  }
  panel(-1.2,0,-5,1.5,2,[2,.15,.05]);panel(0,0,-10,1.5,2,[.1,1.5,.2]);panel(2,0,-15,1.5,2,[.1,.2,3]);
  // Asymmetric top-left yellow / bottom-right cyan marker, finite emitter patch.
  panel(-1,1.5,-10,.5,.5,[4,4,.05]);panel(2,-1,-10,.4,.4,[.05,3,3]);
  const emitter=new THREE.Mesh(new THREE.PlaneGeometry(.025,.025),new THREE.MeshBasicMaterial({color:new THREE.Color(20,20,20)}));emitter.position.set(.4,.4,-10);scene.add(emitter);
  const cache=createRasterCache({renderer,scene,interop,width:384});
  const id=new URLSearchParams(location.search).get('lens')??'zemax-55';
  const asset=await(await fetch(`/lenses/${id}.json`)).json(),lens=asset.configurations.find(Boolean);
  cache.capture({sourceCamera:camera,sceneRevision:1,focalLengthMm:55});
  const engine=await createOpticalEngine({interop,cache,width:96});
  const spectralProbe=await runSpectralProbe(interop);
  const opticalPathProbe=await runOpticalPathProbe(interop);
  engine.setLens(lens,{fNumber:2.8,sensorZMm:paraxialSensorZ(lens,10),dispersion:false});engine.updateCapture({sourceCamera:camera});
  const initialCompilations=interop.compilations;
  const pipeline=new THREE.RenderPipeline(renderer);pipeline.outputNode=displayOutputNode(texture(engine.texture),float(1),hdr.supported);
  for(let i=0;i<8;i++)engine.sample({targetSpp:8,batchSpp:1,constantEnvironment:[1,1,1]});
  const a=await engine.readAccumulation();engine.reset();
  for(let i=0;i<2;i++)engine.sample({targetSpp:8,batchSpp:4,constantEnvironment:[1,1,1]});
  const b=await engine.readAccumulation(),af=new Float32Array(a),bf=new Float32Array(b),au=new Uint32Array(a),bu=new Uint32Array(b);
  let prefixError=0;
  for(let p=0;p<96*64;p++){
    check(au[p*12+3]===8&&bu[p*12+3]===8,'attempted budget mismatch');
    for(let c=0;c<3;c++)prefixError=Math.max(prefixError,Math.abs(af[p*12+c]-bf[p*12+c]));
    for(let c=3;c<12;c++)check(au[p*12+c]===bu[p*12+c],'batched integer/status prefix changed');
  }
  check(prefixError<1e-5,'batch prefix XYZ mismatch');
  const stats=await engine.statistics();check(stats.numericalErrorRate===0,'Numerical errors are not physical vignetting');
  async function uniformEnergy(fNumber,samplingScale=1){
    engine.setLens(lens,{fNumber,sensorZMm:paraxialSensorZ(lens,10),dispersion:false,samplingScale});engine.updateCapture({sourceCamera:camera});
    for(let i=0;i<128;i++)engine.sample({targetSpp:512,batchSpp:4,constantEnvironment:[16,16,16]});
    const raw=await engine.readAccumulation(),f=new Float32Array(raw);let y=0;
    for(let p=0;p<96*64;p++)y+=f[p*12+1]/512;
    const pixels=await interop.readTexture(engine.outputGPU);let peak=0;for(let i=0;i<pixels.length;i++)if(i%4!==3)peak=Math.max(peak,pixels[i]);
    return {meanY:y/(96*64),...(await engine.statistics()),peak};
  }
  const open=await uniformEnergy(2.8),stopped=await uniformEnergy(5.6),expanded=await uniformEnergy(2.8,2);
  check(stopped.meanY<open.meanY*.5&&stopped.opticalPassRate<open.opticalPassRate,'Blocked paths were normalized away');
  check(Math.abs(expanded.meanY/open.meanY-1)<.025,'Sampling area/PDF changed converged radiance');
  check(open.peak>1,'Optical HDR output lost values above one');
  const energy={open,stopped,expanded,pdfRatio:expanded.meanY/open.meanY};
  engine.setLens(lens,{fNumber:2.8,sensorZMm:paraxialSensorZ(lens,10),dispersion:false});engine.updateCapture({sourceCamera:camera});
  const target=await engine.referenceTarget();check(target.status===4&&Math.abs(target.distanceM-10)<.3,'AF reference target mapping failed: '+JSON.stringify({target,stats}));
  const focusNear=await engine.focusPoint([0,0,-5000]),focusFar=await engine.focusPoint([0,0,-15000]);
  check(focusNear.sensorZMm>focusFar.sensorZMm,'AF sensor position must change with target distance');
  check(focusNear.afterRmsMm<=focusNear.beforeRmsMm+1e-5&&focusFar.afterRmsMm<=focusFar.beforeRmsMm+1e-5,'AF quadratic did not improve fixed beam merit');
  engine.updateOptics({fNumber:2.8,sensorZMm:focusNear.sensorZMm,dispersion:true});
  for(let i=0;i<16;i++)engine.sample({batchSpp:4,targetSpp:64});pipeline.render();
  const image=await interop.readTexture(engine.outputGPU);check(image.every(Number.isFinite),'Nonfinite optical output');
  check(cache.captures===1,'Static accumulation recaptures scene');check(interop.compilations===initialCompilations,'Optics parameter caused recompile');
  check(errors.length===0,'GPU validation errors: '+errors.join('\n'));
  const result={passed:true,lens:id,surfaces:lens.surfaces.length,width:96,height:64,spp:engine.spp,prefixError,stats,energy,target,focusNear,focusFar,spectralProbe,opticalPathProbe,captures:cache.captures,pipelines:interop.compilations,memoryBytes:engine.memoryBytes,computeMs:engine.computeMs,timestampSupported:engine.timestampSupported,initializationAndTestsMs:performance.now()-start,finite:true,imagePeak:Math.max(...image),errors};
  out.textContent=JSON.stringify(result,null,2);document.body.dataset.passed='true';window.__opticalTest={result,engine,cache,renderer,interop};
}catch(error){out.textContent=error.stack||String(error);document.body.dataset.passed='false';console.error(error);}
