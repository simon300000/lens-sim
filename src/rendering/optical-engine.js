import * as THREE from 'three/webgpu';
import opticalSource from '../optics/optical-core.wgsl?raw';
import { SCENE_INTERSECTOR_WGSL, SCENE_SHADING_WGSL } from './scene-wgsl.js';
import integratorSource from './optical-integrator.wgsl?raw';
import resolveSource from './resolve.wgsl?raw';
import focusSource from '../optics/focus.wgsl?raw';
import targetSource from '../optics/focus-target.wgsl?raw';
import reduceSource from '../optics/focus-reduce.wgsl?raw';
import statisticsSource from './statistics.wgsl?raw';
import { SPECTRAL_WGSL } from '../spectral/reconstruction.js';
import { SAMPLING_WGSL } from '../spectral/sampler.js';
import { buildPupilTable } from '../optics/pupil-sampling.js';
import pupilSource from '../optics/pupil-sampling.wgsl?raw';
import { packLens } from '../optics/lens-state.js';
import { createComputeTimer } from './three-interop.js';
import { imagePlan, sampleBudget, PIXEL_BYTES } from './sampling-plan.js';

export const DIAGNOSTIC_MODES=Object.freeze({beauty:0,'scene-error':1,status:2,'geometry-depth':3,'geometry-normal':4,'geometry-material':5});
// Modes >= 3 change what is accumulated (debug RGB), so switching resets accumulation.
export const ACCUMULATING_DIAGNOSTICS=Object.freeze(['geometry-depth','geometry-normal','geometry-material']);
const diagnosticIndex=mode=>DIAGNOSTIC_MODES[mode]??0;
const uniformBinding=(binding,buffer)=>({binding,resource:{buffer}});

export async function createOpticalEngine({interop,sceneResources,lighting,width=480}) {
  const started=performance.now(),{device}=interop;
  const optics=interop.uniform(new Uint8Array(64),'Optics runtime parameters');
  const render=interop.uniform(new Uint8Array(192),'Pixel budgets, pose and diagnostic ray mode');
  const resolve=interop.uniform(new Uint8Array(16),'Display resolve parameters');
  const focus=interop.uniform(new Uint8Array(96),'AF target and fixed beam budget');
  const camera=interop.uniform(new Uint8Array(64),'AF reference ray camera pose');
  const beams=interop.storage(65536*32,'AF cached a/b beams (bounded maximum)');
  const summary=interop.storage(48,'AF reduced quadratic moments');
  const target=interop.storage(32,'AF actual chief-ray world target');
  const pupil=interop.uniform(new Uint8Array(16+32*16),'Radial exit pupil proposal table');
  const pipelines={};
  pipelines.sample=await interop.computePipeline(opticalSource+SCENE_INTERSECTOR_WGSL+SCENE_SHADING_WGSL+SPECTRAL_WGSL+SAMPLING_WGSL+pupilSource+integratorSource,'Real lens + BVH first hit + shading fused integrate');
  pipelines.resolve=await interop.computePipeline(SPECTRAL_WGSL+resolveSource,'XYZ display-only resolve');
  pipelines.focus=await interop.computePipeline(opticalSource+SAMPLING_WGSL+focusSource,'AF physical forward beam trace');
  pipelines.target=await interop.computePipeline(opticalSource+SCENE_INTERSECTOR_WGSL+targetSource,'AF reference ray -> BVH first opaque surface');
  pipelines.reduce=await interop.computePipeline(reduceSource,'AF cross-workgroup quadratic reduction');
  pipelines.statistics=await interop.computePipeline(statisticsSource,'Attempt statistics reduction');
  const timer=createComputeTimer(interop);
  let pupilTable;
  let surfaces,lut,tiles=[],tileCursor=0,roundBudget=0,roundTarget=0,image,packed,lens,groups={},spp=0,disposed=false,computeMs=null,statsPending=null,lastTiming=null;
  let dimensions={width:0,height:0},currentRevision=0,resizeRevision=0,focusBudget=2048;
  const pose=new THREE.Matrix4();
  let sceneBound=-1,lightingBound=null;

  function group(pipeline,entries){return device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries});}
  function focusGroups(){
    const beamBinding=binding=>({binding,resource:{buffer:beams,size:focusBudget*32}});
    groups.focus=group(pipelines.focus,[uniformBinding(0,optics),uniformBinding(1,surfaces),uniformBinding(2,lut),uniformBinding(3,focus),beamBinding(4)]);
    groups.reduce=group(pipelines.reduce,[beamBinding(0),uniformBinding(1,summary)]);
  }
  function rebuildGroups(){
    if(!surfaces||!image||!sceneResources.ready||!lighting.views)return;
    const lensBindings=[uniformBinding(0,optics),uniformBinding(1,surfaces),uniformBinding(2,lut)];
    const sceneBindings=[...sceneResources.bindings(6),...lighting.bindings(11)];
    for(const tile of tiles){
      tile.sample=group(pipelines.sample,[...lensBindings,uniformBinding(3,render),uniformBinding(4,tile.buffer),{binding:5,resource:image.gpu.createView()},...sceneBindings,uniformBinding(20,pupil)]);
      tile.resolve=group(pipelines.resolve,[uniformBinding(0,resolve),uniformBinding(1,tile.buffer),{binding:2,resource:image.gpu.createView()}]);
    }
    groups.target=group(pipelines.target,[...lensBindings,uniformBinding(3,camera),uniformBinding(4,target),...sceneResources.bindings(6).slice(0,3)]);
    sceneBound=sceneResources.revision;lightingBound=lighting.views;
    focusGroups();
  }
  /** Rebind after a BVH (re)upload or a change of raster lighting textures. */
  function bindScene(){if(sceneBound!==sceneResources.revision||lightingBound!==lighting.views||sceneResources.tables!==tablesBound){tablesBound=sceneResources.tables;rebuildGroups();}}
  let tablesBound=null;
  function reset(){
    currentRevision++;spp=0;tileCursor=0;roundBudget=0;computeMs=null;lastTiming=null;
    if(tiles.length){const encoder=device.createCommandEncoder();for(const tile of tiles)encoder.clearBuffer(tile.buffer);device.queue.submit([encoder.finish()]);}
  }
  function allocate(nextWidth){
    const plan=imagePlan(nextWidth,device.limits),buffers=[];let output;
    try{
      for(const t of plan.tiles)buffers.push({...t,buffer:interop.storage(t.bytes,'Tiled XYZ and attempted-path counters')});
      output=interop.storageImage(plan.width,plan.height);
      return {plan,tiles:buffers,image:output};
    }catch(error){for(const t of buffers)interop.release(t.buffer);output?.texture.dispose();throw error;}
  }
  function releaseCandidate(candidate){for(const t of candidate.tiles)interop.release(t.buffer);candidate.image.texture.dispose();}
  function install(candidate){
    for(const t of tiles)interop.release(t.buffer);image?.texture.dispose();
    dimensions={width:candidate.plan.width,height:candidate.plan.height};tiles=candidate.tiles;image=candidate.image;
    rebuildGroups();reset();return true;
  }
  function resize(nextWidth){
    resizeRevision++;
    if(Math.max(48,Math.round(nextWidth/3)*3)===dimensions.width)return false;
    return install(allocate(nextWidth));
  }
  async function resizeChecked(nextWidth){
    const token=++resizeRevision;
    if(Math.max(48,Math.round(nextWidth/3)*3)===dimensions.width)return false;
    imagePlan(nextWidth,device.limits); // reject unsupported dimensions before GPU allocation
    device.pushErrorScope('out-of-memory');device.pushErrorScope('validation');
    let candidate,error;
    try{candidate=allocate(nextWidth);}catch(e){error=e;}
    const validation=await device.popErrorScope(),memory=await device.popErrorScope();
    if(error||validation||memory||disposed){if(candidate)releaseCandidate(candidate);throw error||new Error(validation?.message||memory?.message||'渲染器已关闭');}
    if(token!==resizeRevision){releaseCandidate(candidate);return false;}
    return install(candidate);
  }
  resize(width);
  function updatePupil(nextLens,next,state){
    const table=buildPupilTable(nextLens,next,{enabled:state?.pupilSampling!==false});
    if(table!==pupilTable){device.queue.writeBuffer(pupil,0,table.data);pupilTable=table;}
  }
  function setLens(nextLens,state){
    const next=packLens(nextLens,state);
    // Build the proposal before replacing any live GPU resources.
    const nextPupil=buildPupilTable(nextLens,next,{enabled:state?.pupilSampling!==false});
    const nextSurfaces=interop.storage(next.surfaces,'Current lens analytic surfaces');let nextLut;
    try{
      nextLut=interop.storage(next.lut.values,'Current lens n(lambda) LUT');
      if(nextPupil!==pupilTable){device.queue.writeBuffer(pupil,0,nextPupil.data);pupilTable=nextPupil;}
    }catch(error){interop.release(nextSurfaces);if(nextLut)interop.release(nextLut);throw error;}
    if(surfaces)interop.release(surfaces);if(lut)interop.release(lut);
    surfaces=nextSurfaces;lut=nextLut;
    packed=next;lens=nextLens;device.queue.writeBuffer(optics,0,next.parameters);rebuildGroups();reset();return next;
  }
  function updateOptics(state){
    const next=packLens(lens,state);updatePupil(lens,next,state);packed=next;device.queue.writeBuffer(optics,0,next.parameters);reset();return next;
  }
  function setPose(sourceCamera){
    sourceCamera.updateMatrixWorld(true);pose.copy(sourceCamera.matrixWorld);device.queue.writeBuffer(camera,0,new Float32Array(pose.elements));
  }
  function submit(pipeline,bindGroup,x=1,y=1,{timed=false}={}){
    if(disposed)throw new Error('Optical engine disposed');
    const encoder=device.createCommandEncoder();const timestamps=timed?timer.begin():undefined;
    const pass=encoder.beginComputePass(timestamps?{timestampWrites:timestamps}:{});
    pass.setPipeline(pipeline);pass.setBindGroup(0,bindGroup);pass.dispatchWorkgroups(x,y);pass.end();
    const timingRevision=currentRevision,timingDimensions={...dimensions};
    const collect=timed?timer.end(encoder,timestamps,ms=>{if(timingRevision===currentRevision){computeMs=ms;lastTiming={...timingDimensions,ms};}}):null;
    device.queue.submit([encoder.finish()]);collect?.();
  }
  const initializationMs=performance.now()-started;
  return {
    get texture(){return image.texture;},get outputGPU(){return image.gpu;},
    get spp(){return spp;},get dimensions(){return {...dimensions};},get packed(){return packed;},get tileCount(){return tiles.length;},get roundComplete(){return tileCursor===0;},
    get pupilTable(){return pupilTable;},
    get initializationMs(){return initializationMs;},
    get computeMs(){return computeMs;},get timestampSupported(){return timer.supported;},
    get lastTiming(){return lastTiming;},
    get memoryBytes(){return dimensions.width*dimensions.height*(PIXEL_BYTES+8)+(surfaces?.size??0)+(lut?.size??0)+pupil.size+beams.size+48+32+64+192+16+96+64;},
    reset,resize,resizeChecked,setLens,updateOptics,setPose,bindScene,
    sample({batchSpp=1,targetSpp=64,seed=1,diagnostic='beauty',constantEnvironment=null,pinhole=null}={}){
      bindScene();
      if(!tiles[0]?.sample)throw new Error('场景 BVH、光照资源或镜头尚未准备');
      // One bounded tile per frame keeps large sensor sizes responsive to pause.
      const budget=tileCursor?roundBudget:sampleBudget(spp,targetSpp,batchSpp);if(!budget)return false;
      if(tileCursor===0)roundTarget=targetSpp;
      roundBudget=budget;const tile=tiles[tileCursor];
      const bytes=new ArrayBuffer(192),f=new Float32Array(bytes),u=new Uint32Array(bytes);f.set(pinhole?.cameraToWorld??pose.elements);
      u.set([dimensions.width,dimensions.height,budget,roundTarget,seed,diagnosticIndex(diagnostic),constantEnvironment?1:0,tile.y],16);
      f.set([...(constantEnvironment??[0,0,0]),0],24);u.set([pinhole?1:0,0,0,0],28);if(pinhole)f.set(pinhole.clipToCamera,32);
      device.queue.writeBuffer(render,0,bytes);
      submit(pipelines.sample,tile.sample,Math.ceil(dimensions.width/8),Math.ceil(tile.height/8),{timed:true});
      tileCursor++;if(tileCursor===tiles.length){tileCursor=0;spp+=budget;}return true;
    },
    resolve(diagnostic='beauty'){
      for(const tile of tiles){if(!tile.resolve)return;
        device.queue.writeBuffer(resolve,0,new Uint32Array([dimensions.width,dimensions.height,diagnosticIndex(diagnostic),tile.y]));
        submit(pipelines.resolve,tile.resolve,Math.ceil(dimensions.width/8),Math.ceil(tile.height/8));
      }
    },
    async statistics(){
      if(statsPending)return statsPending;if(!tiles[0]?.sample)return null;const revision=currentRevision;
      const snapshot=tiles.slice();
      statsPending=(async()=>{const totals=interop.storage(snapshot.length*256,'Tile statistics snapshot');try{const data=new Float64Array(12);
        // Enqueue the entire snapshot before yielding, so subsequent frames
        // cannot mix counters from different accumulation rounds.
        for(let i=0;i<snapshot.length;i++)submit(pipelines.statistics,group(pipelines.statistics,[uniformBinding(0,snapshot[i].buffer),{binding:1,resource:{buffer:totals,offset:i*256,size:48}}]));
        const part=new Float32Array(await interop.readBuffer(totals,snapshot.length*256));
        for(let t=0;t<snapshot.length;t++)for(let i=0;i<12;i++)data[i]+=part[t*64+i];
        if(revision!==currentRevision)return null;const n=Math.max(1,data[4]),passed=Math.max(1,data[7]);
        // Rates over ALL attempts unless named *OfPassed (denominator: optical paths that reached the scene).
        return {attemptedSamples:data[4],opticalBlockedRate:data[0]/n,tirRate:data[1]/n,numericalErrorRate:data[2]/n,
          bvhErrorRate:data[3]/passed,hitRate:data[5]/n,backgroundRate:data[6]/n,opticalPassRate:data[7]/n,
          unsupportedRate:data[8]/passed,transparencyLimitRate:data[9]/passed,radianceInvalidRate:data[10]/n,reflectionOutsideRate:data[11]/passed,
          sceneHitOfPassed:data[5]/passed,backgroundOfPassed:data[6]/passed};
      }finally{interop.release(totals);statsPending=null;}})();return statsPending;
    },
    async referenceTarget(){
      bindScene();if(!groups.target)throw new Error('场景 BVH 不可用');submit(pipelines.target,groups.target);
      const result=new Float32Array(await interop.readBuffer(target,32));
      const status=Math.round(result[3]),layers=Math.round(result[5]);
      if(status===5)return {infinity:true,status,transparentLayers:layers};
      if(status===8)throw new Error(`准星 BVH 遍历错误（代码 ${Math.round(result[6])}），未修改焦点`);
      if(status===9)throw new Error('准星穿过的透明层超过上限，未修改焦点');
      if(status!==4)throw new Error('参考主光线无法通过当前镜头');
      const world=new THREE.Vector3(...result.slice(0,3));
      const local=world.clone().applyMatrix4(pose.clone().invert()).multiplyScalar(1000);
      return {world:world.toArray(),local:local.toArray(),distanceM:-local.z*.001,hitDistanceM:result[4],transparentLayers:layers,status};
    },
    async focusPoint(localTarget,{previousSensorZ=packed.sensorZMm,infinity=false}={}){
      if(!groups.focus)throw new Error('镜头未准备');
      if(!(localTarget[2]<-1)||localTarget.some(x=>!Number.isFinite(x)))throw new Error('目标必须位于镜头物方');
      // Select a fixed bounded attempt budget BEFORE tracing. Small stops need
      // more deterministic first-plane beams; failures never trigger replacement.
      const nextBudget=Math.min(65536,Math.ceil(Math.max(2048,2048*(packed.fNumber/2.8)**2)/64)*64);
      if(nextBudget!==focusBudget){focusBudget=nextBudget;focusGroups();}
      const revision=currentRevision,referenceSensorZ=packed.sensorZMm,bytes=new ArrayBuffer(96),f=new Float32Array(bytes),u=new Uint32Array(bytes);
      f.set([...localTarget,0]);u.set([focusBudget,infinity?1:0,0,0],4);f.set(pose.elements,8);device.queue.writeBuffer(focus,0,bytes);
      submit(pipelines.focus,groups.focus,focusBudget/64);submit(pipelines.reduce,groups.reduce);
      const moments=new Float32Array(await interop.readBuffer(summary,48));
      if(revision!==currentRevision)throw new Error('对焦结果已过期');
      const count=moments[7];if(count<16)throw new Error(`有效对焦光束不足 (${count}/${focusBudget})`);
      if(moments[8]>0)throw new Error(`对焦出现 ${moments[8]} 条数值错误，未修改焦点`);
      const ax=moments[0]/count,ay=moments[1]/count,bx=moments[2]/count,by=moments[3]/count;
      const A=moments[6]/count-bx*bx-by*by,B=moments[5]/count-ax*bx-ay*by,C=moments[4]/count-ax*ax-ay*ay;
      if(!(A>1e-12))throw new Error('像方光束退化，无有限最佳焦点');
      const delta=-B/A,z=referenceSensorZ+delta,min=lens.lastVertexZMm,max=lens.lastVertexZMm+Math.max(200,Math.abs(packed.limits.focalLengthMm)*4);
      if(!Number.isFinite(z)||z<min||z>=max)throw new Error('最佳像面超出可调范围，保留原焦点');
      const merit=position=>{const q=position-referenceSensorZ;return Math.max(0,C+2*B*q+A*q*q);};
      const rmsResolutionMm=Math.max(1e-5,Math.sqrt((Math.abs(C)+Math.abs(2*B*delta)+Math.abs(A*delta*delta))*5e-5));
      return {sensorZMm:z,imageDistanceMm:z-lens.lastVertexZMm,beams:count,beamBudget:focusBudget,beforeRmsMm:Math.sqrt(merit(previousSensorZ)),afterRmsMm:Math.sqrt(merit(z)),rmsResolutionMm,quadratic:{A,B,C,originSensorZMm:referenceSensorZ},target:localTarget};
    },
    async readAccumulation(){const result=new Uint8Array(dimensions.width*dimensions.height*PIXEL_BYTES);let offset=0;for(const tile of tiles){const part=new Uint8Array(await interop.readBuffer(tile.buffer,tile.bytes));result.set(part,offset);offset+=part.length;}return result.buffer;},
    dispose(){disposed=true;timer.dispose();for(const b of [optics,render,resolve,focus,camera,beams,summary,target,surfaces,lut,pupil,...tiles.map(t=>t.buffer)])if(b)interop.release(b);image?.texture.dispose();},
  };
}
