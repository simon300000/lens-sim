import * as THREE from 'three/webgpu';
import {stripWorkCounting} from './shader-source.js';
import rawOpticalSource from '../optics/optical-core.wgsl?raw';
import {opticalSourceForLutPolicy} from './optical-source.js';
import { SCENE_INTERSECTOR_WGSL, SCENE_SHADING_WGSL, WORK_COUNTERS_WGSL } from './scene-wgsl.js';
import rawIntegratorSource from './optical-integrator.wgsl?raw';
import resolveSource from './resolve.wgsl?raw';
import targetSource from '../optics/focus-target.wgsl?raw';
import statisticsSource from './statistics.wgsl?raw';
import statisticsReduceSource from './statistics-reduce.wgsl?raw';
import {statisticsConfiguration,specializeStatistics} from './statistics-plan.js';
import { SPECTRAL_WGSL } from '../spectral/reconstruction.js';
import { SAMPLING_WGSL } from '../spectral/sampler.js';
import {createPupilPrecomputer} from '../optics/pupil-precompute.js';
import { buildPupilTable, PUPIL_TABLE_BYTES } from '../optics/pupil-sampling.js';
import pupilSource from '../optics/pupil-sampling.wgsl?raw';
import { packLens } from '../optics/lens-state.js';
import { createComputeTimer,timestampSpanMs } from './three-interop.js';
import { imagePlan, sampleBudget, PIXEL_BYTES, ROUND_SPP_LIMIT, roundSppWGSL } from './sampling-plan.js';
import { WORK_COUNTERS } from './work-model.js';
import { createChunkBudget,chunkDispatch } from './adaptive-chunks.js';
import {stagedIntegratorSources,STAGED_RAY_BYTES,STAGED_HIT_BYTES,STAGED_SCRATCH_BYTES} from './staged-integrator.js';

export const DIAGNOSTIC_MODES=Object.freeze({beauty:0,'scene-error':1,status:2,'geometry-depth':3,'geometry-normal':4,'geometry-material':5});
// Modes >= 3 change what is accumulated (debug RGB), so switching resets accumulation.
export const ACCUMULATING_DIAGNOSTICS=Object.freeze(['geometry-depth','geometry-normal','geometry-material']);
const diagnosticIndex=mode=>DIAGNOSTIC_MODES[mode]??0;
const uniformBinding=(binding,buffer)=>({binding,resource:{buffer}});

export async function createOpticalEngine({interop,sceneResources,lighting,width=480,accumulationBindingBytes=Infinity,stageTiming=false,chunkTiming='timestamp',opticalLutReuse=false,stagedRayBufferBytes=STAGED_SCRATCH_BYTES,roundSppLimit=ROUND_SPP_LIMIT}) {
  const started=performance.now(),{device}=interop;
  const opticalSource=opticalSourceForLutPolicy(rawOpticalSource,opticalLutReuse);
  const statisticsConfig=statisticsConfiguration(device.limits);
  // A smaller binding cap is useful for validating paired bands on small
  // images. It can only reduce, never exceed the actual device limits.
  const imageLimits={maxTextureDimension2D:device.limits.maxTextureDimension2D,maxBufferSize:device.limits.maxBufferSize,
    maxStorageBufferBindingSize:Math.min(device.limits.maxStorageBufferBindingSize,accumulationBindingBytes)};
  const initialPlan=imagePlan(width,imageLimits,{paired:true});
  interop.memoryBudget?.assertAdditional(initialPlan.memoryBytes+(stagedRayBytes(initialPlan)+stagedHitBytes(initialPlan))+PUPIL_TABLE_BYTES+1024,'镜头初始资源');
  const optics=interop.uniform(new Uint8Array(64),'Optics runtime parameters');
  const render=interop.uniform(new Uint8Array(192),'Pixel budgets, pose and diagnostic ray mode');
  const resolve=interop.uniform(new Uint8Array(16),'Display resolve parameters');
  const camera=interop.uniform(new Uint8Array(64),'AF reference ray camera pose');
  const target=interop.storage(32,'AF actual chief-ray world target');
  const pupil=interop.uniform(new Uint8Array(PUPIL_TABLE_BYTES),'Radial exit pupil proposal table');
  const WORK_BYTES=WORK_COUNTERS.length*8,work=interop.storage(WORK_BYTES,'Work tallies (64-bit lo/hi pairs)');
  // While the HUD counts, every WORK_SAMPLE_EVERY-th accumulation round runs the
  // counting variant (about 6% slower than the production passes); the other rounds
  // run untouched. Whole rounds, not every n-th chunk: a chunk stride would keep
  // sampling the same image regions of a multi-chunk round. Totals and timings are
  // kept only for counted chunks, so every per-path figure stays exact.
  const WORK_SAMPLE_EVERY=4;let workRound=0,roundCounted=false;
  // Independent/pinhole rays and explicit quadrant retracing are diagnostic
  // references; production mirror batches always use the three staged passes.
  const sampleSource=roundSppWGSL(roundSppLimit)+WORK_COUNTERS_WGSL+opticalSource+SCENE_INTERSECTOR_WGSL+SCENE_SHADING_WGSL+SPECTRAL_WGSL+SAMPLING_WGSL+pupilSource;
  const stripped=stripWorkCounting(rawIntegratorSource);
  const entry='if(render.debug.x>=2u){integrateMirrors(id);}else{integratePixel(id);}';
  const independentSource=stripped.replace(entry,'integratePixel(id);');
  const validationSource=stripped.replace(entry,'integrateMirrors(id);');
  const stagedSources=stagedIntegratorSources({integrator:rawIntegratorSource,optical:opticalSource,work:WORK_COUNTERS_WGSL,intersector:SCENE_INTERSECTOR_WGSL,shading:SCENE_SHADING_WGSL,spectral:SPECTRAL_WGSL,sampling:SAMPLING_WGSL,pupil:pupilSource,roundSppLimit});
  const jobs=[
    ['sample',sampleSource+independentSource,'Independent/pinhole validation reference'],
    ...Object.entries(stagedSources).map(([name,code])=>['staged_'+name,code,'Staged '+name+' batch']),
    ['resolve',SPECTRAL_WGSL+resolveSource,'XYZ display-only resolve'],
    ['target',WORK_COUNTERS_WGSL+opticalSource+SCENE_INTERSECTOR_WGSL+targetSource,'AF reference ray -> BVH first opaque surface'],
    ['statistics',specializeStatistics(statisticsSource,statisticsConfig),'Attempt statistics partial reduction'],
    ['statisticsReduce',specializeStatistics(statisticsReduceSource,statisticsConfig),'Attempt statistics final reduction'],
  ];
  const compiled=await Promise.allSettled(jobs.map(([,code,label])=>interop.computePipeline(code,label)));
  const startupBuffers=[optics,render,resolve,camera,target,pupil,work];
  const failure=compiled.find(result=>result.status==='rejected');if(failure){for(const b of startupBuffers)interop.release(b);throw failure.reason;}
  const pipelines=Object.fromEntries(jobs.map(([name],i)=>[name,compiled[i].value]));
  const timer=createComputeTimer(interop),pupilPrecomputer=createPupilPrecomputer();
  const stagedPipelines={raygen:pipelines.staged_raygen,trace:pipelines.staged_trace,scene:pipelines.staged_scene};let stagedRays=null,stagedHits=null;
  // 'timestamp': GPU timestamp queries time each chunk (benchmarks). 'queue': the caller reports
  // chunk times from queue completions via completeChunk; no timestamp queries are issued.
  if(!['timestamp','queue'].includes(chunkTiming))throw new RangeError('Unknown chunk timing');
  const useTimestamps=chunkTiming==='timestamp';
  const stageTimer=stageTiming&&useTimestamps?createStageTimer(interop,['lens','trace','scene']):null;
  let pupilTable;
  let surfaces,lut,tiles=[],tileCursor=0,groupCursor=0,chunkBudget=createChunkBudget(),lastSubmission=null,sampleSerial=0,roundBudget=0,roundTarget=0,roundMirror=0,tileGroups=0,image,packed,lens,groups={},spp=0,disposed=false,computeMs=null,statsPending=null,lastTiming=null;
  let dimensions={width:0,height:0},currentRevision=0,resizeRevision=0;
  const pose=new THREE.Matrix4();
  let sceneBound=-1,lightingBound=null;
  // Work counting (diagnostics HUD only): workgroup-samples submitted since the
  // last readback, and GPU (or wall) time of recent counted chunks.
  let workWindow=0,closedWorkWindow=-1,countEpoch=0,stagedCountingPipelines=null,stagedCountingCompile=null;
  let counting=false,workUnits=0,workPending=null,validationCompile=null;const workTimings=[];
  const workSupported=device.limits.maxStorageBuffersPerShaderStage>=9;
  function recordWorkTiming(ms,units,source,window){if(!(ms>0&&units>0)||window<=closedWorkWindow)return;workTimings.push({ms,units,source,window});}

  function group(pipeline,entries){return device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries});}
  function rebuildGroups(){
    if(!surfaces||!image||!sceneResources.ready||!lighting.views)return;
    const lensBindings=[uniformBinding(0,optics),uniformBinding(1,surfaces),uniformBinding(2,lut)];
    const sceneBindings=[...sceneResources.bindings(6),...lighting.bindings(11)];
    for(const tile of tiles){
      const sampleBindings=[...lensBindings,uniformBinding(3,render),uniformBinding(4,tile.buffer),{binding:5,resource:image.gpu.createView()},...sceneBindings,uniformBinding(20,pupil)];
      tile.sampleValidation=pipelines.sampleValidation?group(pipelines.sampleValidation,sampleBindings):null;
      tile.sample=group(pipelines.sample,[...lensBindings,uniformBinding(3,render),uniformBinding(4,tile.buffer),{binding:5,resource:image.gpu.createView()},...sceneBindings,uniformBinding(20,pupil)]);
      if(stagedRays){
        tile.raygen=group(stagedPipelines.raygen,[...lensBindings,uniformBinding(3,render),uniformBinding(4,tile.buffer),uniformBinding(20,pupil),uniformBinding(21,stagedRays)]);
        const hitBindings=[uniformBinding(23,stagedHits)];
        tile.scene=group(stagedPipelines.scene,[uniformBinding(0,optics),uniformBinding(3,render),uniformBinding(4,tile.buffer),{binding:5,resource:image.gpu.createView()},...sceneBindings,uniformBinding(21,stagedRays),...hitBindings]);
        tile.raygenCounting=stagedCountingPipelines?group(stagedCountingPipelines.raygen,[...lensBindings,uniformBinding(3,render),uniformBinding(4,tile.buffer),uniformBinding(20,pupil),uniformBinding(21,stagedRays),uniformBinding(22,work)]):null;
        tile.sceneCounting=stagedCountingPipelines?group(stagedCountingPipelines.scene,[uniformBinding(0,optics),uniformBinding(3,render),uniformBinding(4,tile.buffer),{binding:5,resource:image.gpu.createView()},...sceneBindings,uniformBinding(21,stagedRays),uniformBinding(22,work),...hitBindings]):null;
        const traceBindings=[uniformBinding(3,render),uniformBinding(4,tile.buffer),...sceneResources.bindings(6).slice(0,3),uniformBinding(21,stagedRays),uniformBinding(23,stagedHits)];
        tile.trace=group(stagedPipelines.trace,traceBindings);
        tile.traceCounting=stagedCountingPipelines?group(stagedCountingPipelines.trace,[...traceBindings,uniformBinding(22,work)]):null;
      }
      tile.resolve=group(pipelines.resolve,[uniformBinding(0,resolve),uniformBinding(1,tile.buffer),{binding:2,resource:image.gpu.createView()}]);
    }
    groups.target=group(pipelines.target,[...lensBindings,uniformBinding(3,camera),uniformBinding(4,target),...sceneResources.bindings(6).slice(0,3)]);
    sceneBound=sceneResources.revision;lightingBound=lighting.views;
  }
  /** Rebind after a BVH (re)upload or a change of raster lighting textures. */
  function bindScene(){if(sceneBound!==sceneResources.revision||lightingBound!==lighting.views||sceneResources.tables!==tablesBound){tablesBound=sceneResources.tables;rebuildGroups();}}
  let tablesBound=null;
  function reset({resetTiming=false}={}){
    if(resetTiming)chunkBudget=createChunkBudget();
    currentRevision++;spp=0;tileCursor=0;groupCursor=0;lastSubmission=null;roundBudget=0;tileGroups=0;computeMs=null;lastTiming=null;
    if(tiles.length){const encoder=device.createCommandEncoder();for(const tile of tiles)encoder.clearBuffer(tile.buffer);device.queue.submit([encoder.finish()]);}
  }
  function stagedRayBytes(plan){
    const packetBytes=64*roundSppLimit*STAGED_RAY_BYTES;
    const groups=Math.max(...plan.tiles.map(t=>Math.ceil(Math.ceil(plan.width/2)/8)*Math.ceil(t.halfHeight/8)));
    // A round larger than the scratch is split into chunks, and every chunk pays three
    // kernel launches plus their drain tails, so the scratch bounds throughput on large
    // images (RTX 4090, 4 spp rounds, GPU ms per spp of the whole frame: 2560 px 7.4 at
    // 64 MiB, 6.9 at 128, 6.4 at 256 and flat beyond; 45 MP 76 / 65 / 62 / 60 at 512).
    // Hit records take another 8/3 of the ray bytes; both buffers must fit the device limits.
    const limit=Math.min(device.limits.maxBufferSize,device.limits.maxStorageBufferBindingSize);
    const cap=Math.floor(Math.min(Math.max(packetBytes,stagedRayBufferBytes),limit,limit*3/8)/packetBytes);
    return Math.min(groups,cap)*packetBytes;
  }
  /** Staged mode: 4 quadrant hit records per optical sample. */
  function stagedHitBytes(plan){return stagedRayBytes(plan)/STAGED_RAY_BYTES*4*STAGED_HIT_BYTES;}
  function allocate(nextWidth){
    const plan=imagePlan(nextWidth,imageLimits,{paired:true}),buffers=[];let output,rayBuffer,hitBuffer;
    interop.memoryBudget?.assertAdditional(plan.memoryBytes+(stagedRayBytes(plan)+stagedHitBytes(plan)),'新旧图像并存的分配峰值');
    try{
      for(const t of plan.tiles)buffers.push({...t,buffer:interop.storage(t.bytes,'Tiled XYZ and attempted-path counters')});
      output=interop.storageImage(plan.width,plan.height);
      rayBuffer=interop.storage(stagedRayBytes(plan),'Staged: bounded optical batch packets');
      hitBuffer=interop.storage(stagedHitBytes(plan),'Staged: first-hit records');
      return {plan,tiles:buffers,image:output,stagedRays:rayBuffer,stagedHits:hitBuffer};
    }catch(error){for(const t of buffers)interop.release(t.buffer);if(rayBuffer)interop.release(rayBuffer);if(hitBuffer)interop.release(hitBuffer);output?.texture.dispose();throw error;}
  }
  function releaseCandidate(candidate){for(const t of candidate.tiles)interop.release(t.buffer);if(candidate.stagedRays)interop.release(candidate.stagedRays);if(candidate.stagedHits)interop.release(candidate.stagedHits);candidate.image.texture.dispose();}
  function install(candidate){
    for(const t of tiles)interop.release(t.buffer);image?.texture.dispose();
    if(stagedRays)interop.release(stagedRays);stagedRays=candidate.stagedRays??null;
    if(stagedHits)interop.release(stagedHits);stagedHits=candidate.stagedHits??null;
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
    imagePlan(nextWidth,imageLimits,{paired:true}); // reject unsupported dimensions before GPU allocation
    device.pushErrorScope('out-of-memory');device.pushErrorScope('validation');
    let candidate,error;
    try{candidate=allocate(nextWidth);}catch(e){error=e;}
    const [validation,memory]=await Promise.all([device.popErrorScope(),device.popErrorScope()]);
    if(error||validation||memory||disposed){if(candidate)releaseCandidate(candidate);throw error||new Error(validation?.message||memory?.message||'渲染器已关闭');}
    if(token!==resizeRevision){releaseCandidate(candidate);return false;}
    return install(candidate);
  }
  try{resize(width);}catch(error){pupilPrecomputer.dispose();timer.dispose();stageTimer?.dispose();for(const b of startupBuffers)interop.release(b);throw error;}
  function updatePupil(nextLens,next,state){
    const table=buildPupilTable(nextLens,next,{enabled:state?.pupilSampling!==false,bins:state?.pupilBins,movingCenter:state?.pupilMovingCenter});
    if(table!==pupilTable){device.queue.writeBuffer(pupil,0,table.data);pupilTable=table;}
  }
  function setLens(nextLens,state){
    const next=packLens(nextLens,state);
    // Build the proposal before replacing any live GPU resources.
    const nextPupil=buildPupilTable(nextLens,next,{enabled:state?.pupilSampling!==false,bins:state?.pupilBins,movingCenter:state?.pupilMovingCenter});
    const nextSurfaces=interop.storage(next.surfaces,'Current lens analytic surfaces');let nextLut;
    try{
      nextLut=interop.storage(next.lut.values,'Current lens n(lambda) LUT');
      if(nextPupil!==pupilTable){device.queue.writeBuffer(pupil,0,nextPupil.data);pupilTable=nextPupil;}
    }catch(error){interop.release(nextSurfaces);if(nextLut)interop.release(nextLut);throw error;}
    if(surfaces)interop.release(surfaces);if(lut)interop.release(lut);
    surfaces=nextSurfaces;lut=nextLut;
    packed=next;lens=nextLens;device.queue.writeBuffer(optics,0,next.parameters);rebuildGroups();reset({resetTiming:true});return next;
  }
  function updateOptics(state){
    const next=packLens(lens,state);updatePupil(lens,next,state);packed=next;device.queue.writeBuffer(optics,0,next.parameters);reset({resetTiming:true});return next;
  }
  function setPose(sourceCamera){
    sourceCamera.updateMatrixWorld(true);pose.copy(sourceCamera.matrixWorld);device.queue.writeBuffer(camera,0,new Float32Array(pose.elements));
  }
  function submit(pipeline,bindGroup,x=1,y=1,{timed=false,submission=null}={}){
    if(disposed)throw new Error('Optical engine disposed');
    const encoder=device.createCommandEncoder();const timestamps=timed&&useTimestamps?timer.begin():undefined;
    const pass=encoder.beginComputePass(timestamps?{timestampWrites:timestamps}:{});
    pass.setPipeline(pipeline);pass.setBindGroup(0,bindGroup);pass.dispatchWorkgroups(x,y);pass.end();
    const timingRevision=currentRevision,timingDimensions={...dimensions};
    const collect=timed&&useTimestamps?timer.end(encoder,timestamps,ms=>{if(submission?.counted&&submission.countEpoch===countEpoch)recordWorkTiming(ms,submission.countedWorkUnits,'gpu',submission.workWindow);if(timingRevision===currentRevision){computeMs=ms;lastTiming={...timingDimensions,ms,chunkPixels:submission?.pixels??null,chunkSpp:submission?.spp??null};if(submission){submission.gpuMs=ms;chunkBudget.observe(submission,ms);}}}):null;
    device.queue.submit([encoder.finish()]);collect?.();
  }
  function submitStaged(tile,dispatch,sceneDispatch,submission){
    const encoder=device.createCommandEncoder({label:'Staged optical/scene batch'});
    const stages=stageTimer?.begin(),timestamps=stages||!useTimestamps?null:timer.begin();
    const lensStamp=stages?.lens??(timestamps?{querySet:timestamps.querySet,beginningOfPassWriteIndex:timestamps.beginningOfPassWriteIndex}:undefined);
    const sceneStamp=stages?.scene??(timestamps?{querySet:timestamps.querySet,endOfPassWriteIndex:timestamps.endOfPassWriteIndex}:undefined);
    const selected=submission.counted?stagedCountingPipelines:stagedPipelines;
    const passes=[[selected.raygen,submission.counted?tile.raygenCounting:tile.raygen,dispatch,'Staged lens batch',lensStamp]];
    passes.push([selected.trace,submission.counted?tile.traceCounting:tile.trace,sceneDispatch,'Staged traversal batch',stages?.trace]);
    passes.push([selected.scene,submission.counted?tile.sceneCounting:tile.scene,sceneDispatch,'Staged scene batch',sceneStamp]);
    for(const [pipeline,bind,grid,label,stamp] of passes){
      const pass=encoder.beginComputePass({label,...(stamp?{timestampWrites:stamp}:{})});pass.setPipeline(pipeline);pass.setBindGroup(0,bind);pass.dispatchWorkgroups(grid.x,grid.y);pass.end();
    }
    const revision=currentRevision,timingDimensions={...dimensions};
    const accept=t=>{if(submission.counted&&submission.countEpoch===countEpoch)recordWorkTiming(t.ms,submission.countedWorkUnits,'gpu',submission.workWindow);if(revision===currentRevision){computeMs=t.ms;lastTiming={...timingDimensions,...t,chunkPixels:submission.pixels??null,chunkSpp:submission.spp??null};submission.gpuMs=t.ms;chunkBudget.observe(submission,t.ms);}};
    const collect=stages?stageTimer.end(encoder,stages,accept):timestamps?timer.end(encoder,timestamps,ms=>accept({ms})):null;
    device.queue.submit([encoder.finish()]);collect?.();
  }
  const initializationMs=performance.now()-started;
  return {
    get texture(){return image.texture;},get outputGPU(){return image.gpu;},
    get spp(){return spp;},get dimensions(){return {...dimensions};},get packed(){return packed;},get tileCount(){return tiles.length;},get roundComplete(){return tileCursor===0&&groupCursor===0;},
    get pupilTable(){return pupilTable;},
    get initializationMs(){return initializationMs;},
    get computeMs(){return computeMs;},get timestampSupported(){return useTimestamps&&timer.supported;},
    /** 'gpu' (timestamp queries), 'queue' (caller-reported completion intervals) or 'wall' (no timestamps). */
    get timingSource(){return !useTimestamps?'queue':timer.supported?'gpu':'wall';},
    get lastTiming(){return lastTiming;},
    get lastSubmission(){return lastSubmission;},
    get sampleSerial(){return sampleSerial;},
    // Samples per pixel including the submitted part of the current sweep; CPU-only, for live rate readouts.
    get progress(){return tiles.length&&tileGroups?spp+roundBudget*(tileCursor+groupCursor/tileGroups)/tiles.length:spp;},
    // With timestamp queries, feedback is delivered by timer.end itself, even when
    // the asynchronous map completes after the queue fence callback. Otherwise the
    // caller's completion-based estimate is the chunk time.
    completeChunk(submission,ms){
      if(useTimestamps&&timer.supported)return;
      const source=useTimestamps?'wall':'queue';
      if(submission?.counted&&submission.countEpoch===countEpoch)recordWorkTiming(ms,submission.countedWorkUnits,source,submission.workWindow);
      if(submission?.revision!==currentRevision||!(ms>0))return;
      if(!useTimestamps){computeMs=ms;lastTiming={...dimensions,ms,chunkPixels:submission.pixels??null,chunkSpp:submission.spp??null};submission.gpuMs=ms;}
      chunkBudget.observe(submission,ms);
    },
    get memoryBytes(){return dimensions.width*dimensions.height*(PIXEL_BYTES+8)+[optics,render,resolve,camera,target,surfaces,lut,pupil,work,stagedRays,stagedHits].reduce((sum,buffer)=>sum+(buffer?.size??0),0);},
    async prepareLens(nextLens,state){
      const next=packLens(nextLens,state);
      return pupilPrecomputer.prepare(nextLens,next,{enabled:state?.pupilSampling!==false,bins:state?.pupilBins,movingCenter:state?.pupilMovingCenter});
    },
    reset,resize,resizeChecked,setLens,updateOptics,setPose,bindScene,
    get integrationMode(){return 'staged';},
    get opticalLutReuse(){return opticalLutReuse;},
    async prepareSampling({mirrorReference=false}={}){
      if(!mirrorReference)return;
      validationCompile??=interop.computePipeline(sampleSource+validationSource,'Mirror sampling validation');
      const ready=await validationCompile;if(disposed)throw new Error('Optical engine disposed');pipelines.sampleValidation=ready;rebuildGroups();
    },
    get workCounting(){return counting&&Boolean(stagedCountingPipelines);},
    get workSupported(){return workSupported;},
    /** Resolves to 'counting' | 'off' | 'unsupported'. The counting variant compiles once, on first use. */
    async setWorkCounting(on){
      const epoch=++countEpoch;workWindow=0;closedWorkWindow=-1;counting=Boolean(on)&&workSupported;workUnits=0;workTimings.length=0;
      if(!counting)return workSupported?'off':'unsupported';
      if(!stagedCountingPipelines){
        stagedCountingCompile??=(async()=>{
          const sources=stagedIntegratorSources({integrator:rawIntegratorSource,optical:opticalSource,work:WORK_COUNTERS_WGSL,intersector:SCENE_INTERSECTOR_WGSL,shading:SCENE_SHADING_WGSL,spectral:SPECTRAL_WGSL,sampling:SAMPLING_WGSL,pupil:pupilSource,counting:true,roundSppLimit});
          const results=await Promise.allSettled(Object.entries(sources).map(async([name,code])=>[name,await interop.computePipeline(code,'Staged '+name+' + work counters')]));
          const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;
          return Object.fromEntries(results.map(r=>r.value));
        })();
        const ready=await stagedCountingCompile;if(disposed)return 'off';stagedCountingPipelines=ready;rebuildGroups();
      }
      if(epoch!==countEpoch)return counting?'counting':'off';
      const encoder=device.createCommandEncoder();encoder.clearBuffer(work);device.queue.submit([encoder.finish()]);workUnits=0;
      return counting?'counting':'off';
    },
    /** Copy-and-clear in one submission, so every chunk is counted exactly once. */
    async readWork(){
      if(workPending||!counting)return workPending;
      const staging=interop.buffer(WORK_BYTES,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ,'Work counter readback');
      try{const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(work,0,staging,0,WORK_BYTES);encoder.clearBuffer(work);device.queue.submit([encoder.finish()]);}
      catch(error){interop.release(staging);throw error;}
      const units=workUnits,epoch=countEpoch,window=workWindow++;workUnits=0;
      workPending=(async()=>{
        try{
          await staging.mapAsync(GPUMapMode.READ);if(epoch!==countEpoch)return null;const u=new Uint32Array(staging.getMappedRange());
          const counts=WORK_COUNTERS.map((_,i)=>u[2*i]+u[2*i+1]*4294967296);
          const timings=workTimings.filter(t=>t.window===window),ms=timings.reduce((a,t)=>a+t.ms,0),measured=timings.reduce((a,t)=>a+t.units,0);
          closedWorkWindow=window;for(let i=workTimings.length-1;i>=0;i--)if(workTimings[i].window<=window)workTimings.splice(i,1);
          return {integrationMode:'staged',counts,workUnits:units,measuredWorkUnits:measured,timingCoverage:units>0?measured/units:0,msPerWorkUnit:measured>0?ms/measured:null,timing:timings.at(-1)?.source??null,timedChunks:timings.length};
        }finally{if(staging.mapState==='mapped')staging.unmap();interop.release(staging);workPending=null;}
      })();
      return workPending;
    },
    sample({batchSpp=1,targetSpp=64,seed=1,diagnostic='beauty',constantEnvironment=null,pinhole=null,chunked=false,interactive=false,mirrorReuse=true,mirrorReference=false}={}){
      bindScene();
      if(!tiles[0]?.sample)throw new Error('场景 BVH、光照资源或镜头尚未准备');
      // Complete every storage tile before advancing the global spp counter.
      const budget=(tileCursor||groupCursor)?roundBudget:sampleBudget(spp,targetSpp,batchSpp,roundSppLimit);if(!budget)return false;
      if(tileCursor===0&&groupCursor===0){
        roundTarget=targetSpp;roundCounted=workRound++%WORK_SAMPLE_EVERY===0;
        // Paired storage bands own all four destinations, even on GPUs whose
        // buffer binding limit requires many tiles. Freeze for a full sweep.
        roundMirror=mirrorReuse&&!pinhole?(mirrorReference?4:2):0;
      }
      roundBudget=budget;const tile=tiles[tileCursor];
      const groupsX=roundMirror?Math.ceil(Math.ceil(dimensions.width/2)/8):Math.ceil(dimensions.width/8);
      const groupsY=roundMirror?Math.ceil(tile.halfHeight/8):Math.ceil(tile.height/8);
      const totalGroups=groupsX*groupsY;
      const useStaged=roundMirror===2;
      const plan=chunkBudget.plan(interactive,budget*(roundMirror?4:1),totalGroups-groupCursor);
      const requested=chunked?plan.groups:totalGroups-groupCursor;
      const scratchGroups=useStaged?Math.floor(stagedRays.size/(64*budget*STAGED_RAY_BYTES)):totalGroups;
      const groups=Math.min(requested,scratchGroups);
      const dispatch=(chunked||roundMirror)?chunkDispatch(groups,device.limits.maxComputeWorkgroupsPerDimension):{x:groupsX,y:groupsY};
      if(roundMirror===4&&!pipelines.sampleValidation)throw new Error('Call prepareSampling before requesting mirror validation modes');
      const counted=counting&&useStaged&&Boolean(tile.raygenCounting)&&roundCounted;
      const submission={revision:currentRevision,chunked,interactive,groups,work:groups*budget*(roundMirror?4:1),capacity:Math.min(totalGroups,scratchGroups)*budget*(roundMirror?4:1),tail:plan.tail,targetMs:plan.targetMs,gpuMs:null,counted,mirrorMode:roundMirror,integrationMode:useStaged?'staged':'reference'};
      submission.countEpoch=countEpoch;submission.workWindow=workWindow;submission.countedWorkUnits=submission.work;
      // Pixels this chunk writes (mirror reuse covers four per thread), for the HUD.
      submission.spp=budget;submission.pixels=Math.min(dimensions.width*tile.height,groups*64*(roundMirror?4:1));
      if(useStaged){
        const pixels=mirrorChunkPixels(groupCursor,groups,Math.ceil(dimensions.width/2),tile.halfHeight,dimensions.width%2===1);
        submission.countedWorkUnits=budget*pixels/64;submission.pixels=pixels;
      }
      if(counted)workUnits+=submission.countedWorkUnits;
      lastSubmission=submission;
      const bytes=new ArrayBuffer(192),f=new Float32Array(bytes),u=new Uint32Array(bytes);f.set(pinhole?.cameraToWorld??pose.elements);
      u.set([dimensions.width,dimensions.height,budget,roundTarget,seed,diagnosticIndex(diagnostic),constantEnvironment?1:0,tile.y],16);
      f.set([...(constantEnvironment??[0,0,0]),0],24);u[27]=tile.halfHeight;u.set([pinhole?1:roundMirror,(chunked||roundMirror)?groupCursor:0,(chunked||roundMirror)?dispatch.x:0,(chunked||roundMirror)?groups:0],28);if(pinhole)f.set(pinhole.clipToCamera,32);
      const sceneDispatch=useStaged?chunkDispatch(groups*4,device.limits.maxComputeWorkgroupsPerDimension):null;
      if(useStaged)u[32]=sceneDispatch.x;
      device.queue.writeBuffer(render,0,bytes);
      const pipeline=roundMirror===4?pipelines.sampleValidation:pipelines.sample;
      const bindGroup=roundMirror===4?tile.sampleValidation:tile.sample;
      if(useStaged)submitStaged(tile,dispatch,sceneDispatch,submission);
      else submit(pipeline,bindGroup,dispatch.x,dispatch.y,{timed:true,submission});
      sampleSerial++;groupCursor+=groups;tileGroups=totalGroups;
      if(groupCursor>=totalGroups){groupCursor=0;tileCursor++;if(tileCursor===tiles.length){tileCursor=0;spp+=budget;}}
      return true;
    },
    resolve(diagnostic='beauty'){
      for(const tile of tiles){if(!tile.resolve)return;
        device.queue.writeBuffer(resolve,0,new Uint32Array([dimensions.width,dimensions.height,diagnosticIndex(diagnostic)|(tile.halfHeight<<8),tile.y]));
        submit(pipelines.resolve,tile.resolve,Math.ceil(dimensions.width/8),Math.ceil(tile.height/8));
      }
    },
    async statistics(){
      if(statsPending)return statsPending;if(!tiles[0]?.sample)return null;const revision=currentRevision;
      const snapshot=tiles.slice();
      const pending=(async()=>{let totals;const partials=[];try{const data=new Float64Array(12);
        const partialBytes=snapshot.reduce((sum,t)=>{const n=Math.ceil(t.bytes/(PIXEL_BYTES*statisticsConfig.pixels));return sum+(n>1?n*48:0);},0);
        interop.memoryBudget?.assertAdditional(snapshot.length*512+partialBytes,'统计快照、部分归约与回读');
        totals=interop.storage(snapshot.length*256,'Tile statistics snapshot');
        // Enqueue the entire snapshot before yielding, so subsequent frames
        // cannot mix counters from different accumulation rounds.
        for(let i=0;i<snapshot.length;i++){
          const count=Math.ceil(snapshot[i].bytes/(PIXEL_BYTES*statisticsConfig.pixels));
          const output={binding:1,resource:{buffer:totals,offset:i*256,size:48}};
          if(count===1){submit(pipelines.statistics,group(pipelines.statistics,[uniformBinding(0,snapshot[i].buffer),output]));continue;}
          const partial=interop.storage(count*48,'Parallel statistics partials');partials.push(partial);
          const grid=chunkDispatch(count,device.limits.maxComputeWorkgroupsPerDimension);
          submit(pipelines.statistics,group(pipelines.statistics,[uniformBinding(0,snapshot[i].buffer),uniformBinding(1,partial)]),grid.x,grid.y);
          submit(pipelines.statisticsReduce,group(pipelines.statisticsReduce,[uniformBinding(0,partial),output]));
        }
        const part=new Float32Array(await interop.readBuffer(totals,snapshot.length*256));
        for(let t=0;t<snapshot.length;t++)for(let i=0;i<12;i++)data[i]+=part[t*64+i];
        if(revision!==currentRevision)return null;const n=Math.max(1,data[4]),passed=Math.max(1,data[7]);
        // Rates over ALL attempts unless named *OfPassed (denominator: optical paths that reached the scene).
        return {attemptedSamples:data[4],opticalBlockedRate:data[0]/n,tirRate:data[1]/n,numericalErrorRate:data[2]/n,
          bvhErrorRate:data[3]/passed,hitRate:data[5]/n,backgroundRate:data[6]/n,opticalPassRate:data[7]/n,
          unsupportedRate:data[8]/passed,transparencyLimitRate:data[9]/passed,radianceInvalidRate:data[10]/n,reflectionOutsideRate:data[11]/passed,
          sceneHitOfPassed:data[5]/passed,backgroundOfPassed:data[6]/passed};
      }finally{for(const partial of partials)interop.release(partial);if(totals)interop.release(totals);}})();
      statsPending=pending;const clear=()=>{if(statsPending===pending)statsPending=null;};pending.then(clear,clear);return pending;
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
    async readAccumulation(){
      // Public/debug readbacks retain ordinary image row order. Rendering never
      // copies accumulation through the CPU; only this explicit test API does.
      const result=new Uint8Array(dimensions.width*dimensions.height*PIXEL_BYTES),rowBytes=dimensions.width*PIXEL_BYTES;
      for(const tile of tiles){
        const part=new Uint8Array(await interop.readBuffer(tile.buffer,tile.bytes));
        for(let row=0;row<tile.halfHeight;row++){
          result.set(part.subarray(row*rowBytes,(row+1)*rowBytes),(tile.y+row)*rowBytes);
          const bottom=tile.halfHeight+row;
          result.set(part.subarray(bottom*rowBytes,(bottom+1)*rowBytes),(dimensions.height-1-tile.y-row)*rowBytes);
        }
      }
      return result.buffer;
    },
    dispose(){disposed=true;pupilPrecomputer.dispose();timer.dispose();stageTimer?.dispose();for(const b of [optics,render,resolve,camera,target,surfaces,lut,pupil,work,stagedRays,stagedHits,...tiles.map(t=>t.buffer)])if(b)interop.release(b);image?.texture.dispose();},
  };
}

/** Destination pixels written by mirror packet groups [cursor, cursor+groups): the
 * 8x8 canonical blocks times four quadrants, minus the two x-mirrors of an odd
 * image's central column (those lanes skip). */
function mirrorChunkPixels(cursor,groups,halfWidth,halfHeight,oddWidth){
  const blocksX=Math.ceil(halfWidth/8);let pixels=0;
  for(let g=cursor;g<cursor+groups;g++){
    const bx=g%blocksX,by=Math.floor(g/blocksX),w=Math.min(8,halfWidth-bx*8),h=Math.min(8,halfHeight-by*8);
    if(w<=0||h<=0)continue;
    pixels+=4*w*h;if(oddWidth&&bx*8+w===halfWidth)pixels-=2*h;
  }
  return pixels;
}

function createStageTimer(interop,names){
  const {device}=interop;
  if(!device.features.has('timestamp-query'))return null;
  const count=names.length*2,bytes=count*8;
  const queries=device.createQuerySet({type:'timestamp',count});
  let resolve,read;
  try{resolve=interop.buffer(bytes,GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC,'Split timestamp resolve');read=interop.buffer(bytes,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ,'Split timestamp readback');}
  catch(error){queries.destroy();if(resolve)interop.release(resolve);throw error;}let pending=false;
  return {
    // One begin/end timestamp pair per named stage, in pass order.
    begin(){if(pending)return undefined;pending=true;return Object.fromEntries(names.map((name,k)=>[name,{querySet:queries,beginningOfPassWriteIndex:2*k,endOfPassWriteIndex:2*k+1}]));},
    end(encoder,stamps,callback){encoder.resolveQuerySet(queries,0,count,resolve,0);encoder.copyBufferToBuffer(resolve,0,read,0,bytes);return ()=>read.mapAsync(GPUMapMode.READ).then(()=>{const t=new BigUint64Array(read.getMappedRange()),ms=timestampSpanMs(t[0],t[count-1]),result={ms};names.forEach((name,k)=>{result[name+'Ms']=timestampSpanMs(t[2*k],t[2*k+1]);});read.unmap();pending=false;if(ms!==null)callback(result);},()=>{pending=false;});},
    dispose(){queries.destroy();interop.release(resolve);interop.release(read);},
  };
}
