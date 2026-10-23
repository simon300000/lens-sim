import {cameraPose} from '../src/rendering/three-interop.js';
import * as THREE from 'three/webgpu';
import { createOpticalEngine } from '../src/rendering/optical-engine.js';
import { createLensRig, emissivePanel } from './gpu-fixtures.js';
const result=document.querySelector('#result'),errors=[];
const check=(condition,message)=>{if(!condition)throw new Error(message);};
let renderer,interop,rig,engine,tiled;
try{
  const adapter=await navigator.gpu.requestAdapter();
  renderer=new THREE.WebGPURenderer({requiredLimits:{maxTextureDimension2D:adapter.limits.maxTextureDimension2D}});
  await renderer.init();renderer.setSize(96,64);
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(40,1.5,.02,450);camera.updateMatrixWorld();
  emissivePanel(scene,{z:-6,w:4,h:3,color:[.2,.3,.4]});
  rig=await createLensRig({renderer,scene,camera,width:96});interop=rig.interop;engine=rig.engine;const device=interop.device;
  device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
  const asset=await(await fetch('/lenses/canon-fl-50mm-f1-8.json')).json(),lens=asset.configurations[0];
  const limitedDevice=new Proxy(device,{get(target,key){if(key==='limits')return {...device.limits,maxTextureDimension2D:device.limits.maxTextureDimension2D,maxStorageBufferBindingSize:96*8*64,maxBufferSize:device.limits.maxBufferSize};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
  tiled=await createOpticalEngine({interop:{...interop,device:limitedDevice},sceneResources:rig.sceneResources,provider:rig.provider,width:96});tiled.setPose(cameraPose(camera));
  for(const e of [engine,tiled]){e.setLens(lens,{fNumber:2.8,sensorZMm:lens.sensorZMm,dispersion:true});
    do{e.sample({batchSpp:4,targetSpp:4,seed:7});}while(e.spp<4); // real BVH scene, not a constant environment
  }
  const a=new Uint32Array(await engine.readAccumulation()),b=new Uint32Array(await tiled.readAccumulation());
  check(a.length===b.length&&a.every((v,i)=>v===b[i]),'Tiled accumulation or random sequence differs');
  for(const mode of ['beauty','scene-error','status']){
    engine.resolve(mode);tiled.resolve(mode);
    const full=await interop.readTexture(engine.outputGPU),parts=await interop.readTexture(tiled.outputGPU);
    check(full.every((v,i)=>v===parts[i]),'Tile resolve seam or diagnostic mismatch');
  }
  tiled.dispose();tiled=null;
  engine.reset();for(let i=0;i<1030;i++){engine.sample({batchSpp:4,targetSpp:0,constantEnvironment:[1,1,1]});if(i%32===0)await device.queue.onSubmittedWorkDone();}
  check(engine.spp===4120,'Continuous sampling stopped at the former cap');
  const continuous=new Uint32Array(await engine.readAccumulation());
  for(let i=3;i<continuous.length;i+=16)check(continuous[i]===4120,'Per-pixel continuous counter mismatch');
  const sizes=[];
  for(const width of (new URLSearchParams(location.search).get('sizes')??'6000,9504').split(',').map(Number)){
    if(width>device.limits.maxTextureDimension2D){
      // Adapter limit: must be an explicit rejection that keeps the old image.
      const before=engine.dimensions;let message='';try{await engine.resizeChecked(width);}catch(e){message=e.message;}
      check(message&&engine.dimensions.width===before.width,'Over-limit size was not rejected explicitly');
      sizes.push({width,rejected:message,adapterMaxTexture:device.limits.maxTextureDimension2D});continue;
    }
    await engine.resizeChecked(width);
    do{engine.sample({batchSpp:1,targetSpp:1,constantEnvironment:[1,1,1]});await device.queue.onSubmittedWorkDone();}while(engine.spp<1);
    const stats=await engine.statistics(),dims=engine.dimensions;
    check(stats.attemptedSamples===dims.width*dims.height,'Some sensor rows were missed');
    check(stats.numericalErrorRate===0,'Nonfinite high resolution sample');
    const crop=await interop.readTexture(engine.outputGPU,{x:0,y:dims.height-8,width:8,height:8});check(crop.every(Number.isFinite),'Nonfinite bottom tile output');
    sizes.push({...dims,tiles:engine.tileCount,spp:engine.spp,memoryBytes:engine.memoryBytes,stats});
  }
  const before=engine.dimensions;let rejected=false;try{await engine.resizeChecked(16000);}catch{rejected=true;}
  check(rejected&&engine.dimensions.width===before.width,'Rejected size destroyed the previous image');
  check(errors.length===0,errors.join('\n'));
  const data={passed:true,tiledBitwiseParity:true,parityScene:'real BVH emissive panel',continuousSpp:4120,sizes,errors};
  result.textContent=JSON.stringify(data,null,2);document.body.dataset.passed='true';window.__samplingTest=data;
}catch(error){result.textContent=error.stack||String(error);document.body.dataset.passed='false';window.__samplingTest={passed:false,error:String(error),errors};}
finally{tiled?.dispose();engine?.dispose();rig?.sceneResources.dispose();rig?.lighting.dispose();interop?.dispose();renderer?.dispose();}
