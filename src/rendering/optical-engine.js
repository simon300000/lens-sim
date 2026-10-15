import * as THREE from 'three/webgpu';
import opticalSource from '../optics/optical-core.wgsl?raw';
import sceneSource from './scene-radiance.wgsl?raw';
import integratorSource from './optical-integrator.wgsl?raw';
import resolveSource from './resolve.wgsl?raw';
import focusSource from '../optics/focus.wgsl?raw';
import targetSource from '../optics/focus-target.wgsl?raw';
import reduceSource from '../optics/focus-reduce.wgsl?raw';
import statisticsSource from './statistics.wgsl?raw';
import { SPECTRAL_WGSL } from '../spectral/reconstruction.js';
import { SAMPLING_WGSL } from '../spectral/sampler.js';
import { packLens } from '../optics/lens-state.js';
import { createComputeTimer } from './three-interop.js';
import { imagePlan, sampleBudget } from './sampling-plan.js';

const diagnosticIndex=mode=>({beauty:0,'cache-miss':1,status:2}[mode]??0);
const uniformBinding=(binding,buffer)=>({binding,resource:{buffer}});

export async function createOpticalEngine({interop,cache,width=480}) {
  const started=performance.now(),{device}=interop;
  const optics=interop.uniform(new Uint8Array(64),'Optics runtime parameters');
  const scene=interop.uniform(new Uint8Array(272),'Aligned scene capture matrices');
  const render=interop.uniform(new Uint8Array(112),'Pixel budgets and pose');
  const resolve=interop.uniform(new Uint8Array(16),'Display resolve parameters');
  const focus=interop.uniform(new Uint8Array(96),'AF target and fixed beam budget');
  const camera=interop.uniform(new Uint8Array(64),'AF reference ray camera pose');
  const beams=interop.storage(65536*32,'AF cached a/b beams (bounded maximum)');
  const summary=interop.storage(48,'AF reduced quadratic moments');
  const target=interop.storage(16,'AF actual chief-ray world target');
  const pipelines={};
  pipelines.sample=await interop.computePipeline(opticalSource+sceneSource+SPECTRAL_WGSL+SAMPLING_WGSL+integratorSource,'Real lens spectral fused integrate');
  pipelines.resolve=await interop.computePipeline(SPECTRAL_WGSL+resolveSource,'XYZ display-only resolve');
  pipelines.focus=await interop.computePipeline(opticalSource+SAMPLING_WGSL+focusSource,'AF physical forward beam trace');
  pipelines.target=await interop.computePipeline(opticalSource+sceneSource+targetSource,'AF actual reverse reference ray target');
  pipelines.reduce=await interop.computePipeline(reduceSource,'AF cross-workgroup quadratic reduction');
  pipelines.statistics=await interop.computePipeline(statisticsSource,'Attempt statistics reduction');
  const timer=createComputeTimer(interop);
  let surfaces,lut,tiles=[],tileCursor=0,roundBudget=0,roundTarget=0,image,packed,lens,groups={},spp=0,disposed=false,computeMs=null,statsPending=null,lastTiming=null;
  let dimensions={width:0,height:0},currentRevision=0,resizeRevision=0,focusBudget=2048;
  const pose=new THREE.Matrix4(),worldToClip=new THREE.Matrix4(),clipToWorld=new THREE.Matrix4();

  function group(pipeline,entries){return device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries});}
  function focusGroups(){
    const beamBinding=binding=>({binding,resource:{buffer:beams,size:focusBudget*32}});
    groups.focus=group(pipelines.focus,[uniformBinding(0,optics),uniformBinding(1,surfaces),uniformBinding(2,lut),uniformBinding(3,focus),beamBinding(4)]);
    groups.reduce=group(pipelines.reduce,[beamBinding(0),uniformBinding(1,summary)]);
  }
  function rebuildGroups(){
    if(!surfaces||!image||cache.revision<0)return;
    const textures=cache.textures();
    const lensBindings=[uniformBinding(0,optics),uniformBinding(1,surfaces),uniformBinding(2,lut)];
    const sceneBindings=[uniformBinding(3,scene),{binding:4,resource:textures.color.createView()},{binding:5,resource:textures.depth.createView()}];
    for(const tile of tiles){
      tile.sample=group(pipelines.sample,[...lensBindings,...sceneBindings,uniformBinding(6,render),uniformBinding(7,tile.buffer),{binding:8,resource:image.gpu.createView()}]);
      tile.resolve=group(pipelines.resolve,[uniformBinding(0,resolve),uniformBinding(1,tile.buffer),{binding:2,resource:image.gpu.createView()}]);
    }
    groups.target=group(pipelines.target,[...lensBindings,...sceneBindings,uniformBinding(6,camera),uniformBinding(7,target)]);
    focusGroups();
  }
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
  function setLens(nextLens,state){
    const next=packLens(nextLens,state);
    if(surfaces)interop.release(surfaces);if(lut)interop.release(lut);
    surfaces=interop.storage(next.surfaces,'Current lens analytic surfaces');lut=interop.storage(next.lut.values,'Current lens n(lambda) LUT');
    packed=next;lens=nextLens;device.queue.writeBuffer(optics,0,next.parameters);rebuildGroups();reset();return next;
  }
  function updateOptics(state){
    const next=packLens(lens,state);packed=next;device.queue.writeBuffer(optics,0,next.parameters);reset();return next;
  }
  function updateCapture({sourceCamera,sky={zenith:[.01,.02,.04],horizon:[.04,.04,.04],ground:[.008,.01,.008]}}){
    const c=cache.camera;c.updateMatrixWorld(true);
    worldToClip.multiplyMatrices(c.projectionMatrix,c.matrixWorldInverse);clipToWorld.copy(worldToClip).invert();
    const params=new Float32Array(68);
    params.set(worldToClip.elements,0);params.set(clipToWorld.elements,16);params.set(c.matrixWorldInverse.elements,32);
    params.set([cache.target.width,cache.target.height,c.near,c.far,450,.12,2,128],48);
    params.set([...sky.zenith,0,...sky.horizon,0,...sky.ground,0],56);device.queue.writeBuffer(scene,0,params);
    sourceCamera.updateMatrixWorld(true);pose.copy(sourceCamera.matrixWorld);device.queue.writeBuffer(camera,0,new Float32Array(pose.elements));
    rebuildGroups();
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
    get initializationMs(){return initializationMs;},
    get computeMs(){return computeMs;},get timestampSupported(){return timer.supported;},
    get lastTiming(){return lastTiming;},
    get memoryBytes(){return dimensions.width*dimensions.height*56+(surfaces?.size??0)+(lut?.size??0)+beams.size+48+16+64+272+112+16+96+64;},
    reset,resize,resizeChecked,setLens,updateOptics,updateCapture,
    sample({batchSpp=1,targetSpp=64,seed=1,diagnostic='beauty',constantEnvironment=null}={}){
      if(!tiles[0]?.sample)throw new Error('光栅缓存或镜头尚未准备');
      // One bounded tile per frame keeps large sensor sizes responsive to pause.
      const budget=tileCursor?roundBudget:sampleBudget(spp,targetSpp,batchSpp);if(!budget)return false;
      if(tileCursor===0)roundTarget=targetSpp;
      roundBudget=budget;const tile=tiles[tileCursor];
      const bytes=new ArrayBuffer(112),f=new Float32Array(bytes),u=new Uint32Array(bytes);f.set(pose.elements);
      u.set([dimensions.width,dimensions.height,budget,roundTarget,seed,diagnosticIndex(diagnostic),constantEnvironment?1:0,tile.y],16);
      f.set([...(constantEnvironment??[0,0,0]),0],24);device.queue.writeBuffer(render,0,bytes);
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
      statsPending=(async()=>{const totals=interop.storage(snapshot.length*256,'Tile statistics snapshot');try{const data=new Float64Array(8);
        // Enqueue the entire snapshot before yielding, so subsequent frames
        // cannot mix counters from different accumulation rounds.
        for(let i=0;i<snapshot.length;i++)submit(pipelines.statistics,group(pipelines.statistics,[uniformBinding(0,snapshot[i].buffer),{binding:1,resource:{buffer:totals,offset:i*256,size:32}}]));
        const part=new Float32Array(await interop.readBuffer(totals,snapshot.length*256));
        for(let t=0;t<snapshot.length;t++)for(let i=0;i<8;i++)data[i]+=part[t*64+i];
        if(revision!==currentRevision)return null;const n=Math.max(1,data[4]);
        return {attemptedSamples:data[4],opticalBlockedRate:data[0]/n,tirRate:data[1]/n,numericalErrorRate:data[2]/n,
          cacheMissRate:data[3]/Math.max(1,data[7]),cacheMissAttemptRate:data[3]/n,hitRate:data[5]/n,backgroundRate:data[6]/n,opticalPassRate:data[7]/n};
      }finally{interop.release(totals);statsPending=null;}})();return statsPending;
    },
    async referenceTarget(){
      if(!groups.target)throw new Error('场景缓存不可用');submit(pipelines.target,groups.target);
      const result=new Float32Array(await interop.readBuffer(target,16));
      const status=Math.round(result[3]);
      if(status===5)return {infinity:true,status};
      if(status!==4)throw new Error(status===6?'准星场景查询超出单层缓存':'参考主光线无法通过当前镜头');
      const world=new THREE.Vector3(...result.slice(0,3));
      const local=world.clone().applyMatrix4(pose.clone().invert()).multiplyScalar(1000);
      return {world:world.toArray(),local:local.toArray(),distanceM:-local.z*.001,status};
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
      const delta=-B/A,z=referenceSensorZ+delta,min=lens.lastVertexZMm+.05,max=lens.lastVertexZMm+Math.max(200,Math.abs(packed.limits.focalLengthMm)*4);
      if(!Number.isFinite(z)||z<=min||z>=max)throw new Error('最佳像面超出可调范围，保留原焦点');
      const merit=position=>{const q=position-referenceSensorZ;return Math.max(0,C+2*B*q+A*q*q);};
      const rmsResolutionMm=Math.max(1e-5,Math.sqrt((Math.abs(C)+Math.abs(2*B*delta)+Math.abs(A*delta*delta))*5e-5));
      return {sensorZMm:z,imageDistanceMm:z-lens.lastVertexZMm,beams:count,beamBudget:focusBudget,beforeRmsMm:Math.sqrt(merit(previousSensorZ)),afterRmsMm:Math.sqrt(merit(z)),rmsResolutionMm,quadratic:{A,B,C,originSensorZMm:referenceSensorZ},target:localTarget};
    },
    async readAccumulation(){const result=new Uint8Array(dimensions.width*dimensions.height*48);let offset=0;for(const tile of tiles){const part=new Uint8Array(await interop.readBuffer(tile.buffer,tile.bytes));result.set(part,offset);offset+=part.length;}return result.buffer;},
    dispose(){disposed=true;timer.dispose();for(const b of [optics,scene,render,resolve,focus,camera,beams,summary,target,surfaces,lut,...tiles.map(t=>t.buffer)])if(b)interop.release(b);image?.texture.dispose();},
  };
}
