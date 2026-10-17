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
import { imagePlan, sampleBudget, PIXEL_BYTES } from './sampling-plan.js';
import { WORK_COUNTERS } from './work-model.js';
import { createChunkBudget,chunkDispatch } from './adaptive-chunks.js';
import {splitMirrorSources,linearMirrorGroups,SPLIT_RAY_BYTES} from './split-mirror.js';

export const DIAGNOSTIC_MODES=Object.freeze({beauty:0,'scene-error':1,status:2,'geometry-depth':3,'geometry-normal':4,'geometry-material':5});
// Modes >= 3 change what is accumulated (debug RGB), so switching resets accumulation.
export const ACCUMULATING_DIAGNOSTICS=Object.freeze(['geometry-depth','geometry-normal','geometry-material']);
const diagnosticIndex=mode=>DIAGNOSTIC_MODES[mode]??0;
const uniformBinding=(binding,buffer)=>({binding,resource:{buffer}});

export async function createOpticalEngine({interop,sceneResources,lighting,width=480,accumulationBindingBytes=Infinity,integrationMode='fused',splitStageTiming=false,opticalLutReuse=false,splitRayBufferBytes=128*1024**2}) {
  const started=performance.now(),{device}=interop;
  const opticalSource=opticalSourceForLutPolicy(rawOpticalSource,opticalLutReuse);
  if(!['fused','split'].includes(integrationMode))throw new RangeError('Unknown integration mode');
  const statisticsConfig=statisticsConfiguration(device.limits);
  const integratorSource=integrationMode==='split'?linearMirrorGroups(rawIntegratorSource):rawIntegratorSource;
  // A smaller binding cap is useful for validating paired bands on small
  // images. It can only reduce, never exceed the actual device limits.
  const imageLimits={maxTextureDimension2D:device.limits.maxTextureDimension2D,maxBufferSize:device.limits.maxBufferSize,
    maxStorageBufferBindingSize:Math.min(device.limits.maxStorageBufferBindingSize,accumulationBindingBytes)};
  const initialPlan=imagePlan(width,imageLimits,{paired:true});
  interop.memoryBudget?.assertAdditional(initialPlan.memoryBytes+(integrationMode==='split'?splitRayBytes(initialPlan):0)+PUPIL_TABLE_BYTES+1024,'镜头初始资源');
  const optics=interop.uniform(new Uint8Array(64),'Optics runtime parameters');
  const render=interop.uniform(new Uint8Array(192),'Pixel budgets, pose and diagnostic ray mode');
  const resolve=interop.uniform(new Uint8Array(16),'Display resolve parameters');
  const camera=interop.uniform(new Uint8Array(64),'AF reference ray camera pose');
  const target=interop.storage(32,'AF actual chief-ray world target');
  const pupil=interop.uniform(new Uint8Array(PUPIL_TABLE_BYTES),'Radial exit pupil proposal table');
  const WORK_BYTES=WORK_COUNTERS.length*8,work=interop.storage(WORK_BYTES,'Work tallies (64-bit lo/hi pairs)');
  // The integrator ships in two variants: the normal one strips the work
  // reduction (its private tallies are dead code), the diagnostics one keeps it.
  const sampleSource=WORK_COUNTERS_WGSL+opticalSource+SCENE_INTERSECTOR_WGSL+SCENE_SHADING_WGSL+SPECTRAL_WGSL+SAMPLING_WGSL+pupilSource;
  const countingSource=sampleSource+integratorSource;
  const stripped=stripWorkCounting(integratorSource);
  const entry='if(render.debug.x>=2u){integrateMirrors(id);}else{integratePixel(id);}';
  const independentSource=stripped.replace(entry,'integratePixel(id);');
  const validationSource=stripped.replace(entry,'integrateMirrors(id);');
  // Compile-time specialization lets the driver drop the other large control
  // flow graph and its register lifetimes. Validation is compiled on demand.
  const mirrorSource=validationSource.replaceAll('render.debug.x==4u','false').replaceAll('render.debug.x!=4u','true');
  const splitSources=integrationMode==='split'?splitMirrorSources({integrator:integratorSource,optical:opticalSource,work:WORK_COUNTERS_WGSL,intersector:SCENE_INTERSECTOR_WGSL,shading:SCENE_SHADING_WGSL,spectral:SPECTRAL_WGSL,sampling:SAMPLING_WGSL,pupil:pupilSource}):null;
  const jobs=[
    ['sample',sampleSource+independentSource,'Independent real lens + scene integrate'],
    ...(splitSources?Object.entries(splitSources).map(([name,code])=>['split_'+name,code,'Split mirror '+name+' batch']):[['sampleMirror',sampleSource+mirrorSource,'Four-quadrant real lens + scene integrate']]),
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
  const splitPipelines=splitSources?{raygen:pipelines.split_raygen,scene:pipelines.split_scene}:null;let splitRays=null;
  const stageTimer=splitStageTiming?createSplitStageTimer(interop):null;
  let pupilTable;
  let surfaces,lut,tiles=[],tileCursor=0,groupCursor=0,chunkBudget=createChunkBudget(),lastSubmission=null,sampleSerial=0,roundBudget=0,roundTarget=0,roundMirror=0,tileGroups=0,image,packed,lens,groups={},spp=0,disposed=false,computeMs=null,statsPending=null,lastTiming=null;
  let dimensions={width:0,height:0},currentRevision=0,resizeRevision=0;
  const pose=new THREE.Matrix4();
  let sceneBound=-1,lightingBound=null;
  // Work counting (diagnostics HUD only): workgroup-samples submitted since the
  // last readback, and GPU (or wall) time of recent counted chunks.
  let workWindow=0,closedWorkWindow=-1,countEpoch=0,splitCountingPipelines=null,splitCountingCompile=null;
  let counting=false,workUnits=0,workPending=null,countingPipeline=null,countingCompile=null,validationCompile=null;const workTimings=[];
  const workSupported=device.limits.maxStorageBuffersPerShaderStage>=(integrationMode==='split'?8:9);
  function recordWorkTiming(ms,units,source,window){if(!(ms>0&&units>0)||window<=closedWorkWindow)return;workTimings.push({ms,units,source,window});}

  function group(pipeline,entries){return device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries});}
  function rebuildGroups(){
    if(!surfaces||!image||!sceneResources.ready||!lighting.views)return;
    const lensBindings=[uniformBinding(0,optics),uniformBinding(1,surfaces),uniformBinding(2,lut)];
    const sceneBindings=[...sceneResources.bindings(6),...lighting.bindings(11)];
    for(const tile of tiles){
      const sampleBindings=[...lensBindings,uniformBinding(3,render),uniformBinding(4,tile.buffer),{binding:5,resource:image.gpu.createView()},...sceneBindings,uniformBinding(20,pupil)];
      tile.sampleMirror=pipelines.sampleMirror?group(pipelines.sampleMirror,sampleBindings):null;
      tile.sampleValidation=pipelines.sampleValidation?group(pipelines.sampleValidation,sampleBindings):null;
      tile.sample=group(pipelines.sample,[...lensBindings,uniformBinding(3,render),uniformBinding(4,tile.buffer),{binding:5,resource:image.gpu.createView()},...sceneBindings,uniformBinding(20,pupil)]);
      tile.sampleCounting=countingPipeline?group(countingPipeline,[...lensBindings,uniformBinding(3,render),uniformBinding(4,tile.buffer),{binding:5,resource:image.gpu.createView()},...sceneBindings,uniformBinding(20,pupil),uniformBinding(21,work)]):null;
      if(splitPipelines&&splitRays){
        tile.raygen=group(splitPipelines.raygen,[...lensBindings,uniformBinding(3,render),uniformBinding(4,tile.buffer),uniformBinding(20,pupil),uniformBinding(21,splitRays)]);
        tile.scene=group(splitPipelines.scene,[uniformBinding(0,optics),uniformBinding(3,render),uniformBinding(4,tile.buffer),{binding:5,resource:image.gpu.createView()},...sceneBindings,uniformBinding(21,splitRays)]);
        tile.raygenCounting=splitCountingPipelines?group(splitCountingPipelines.raygen,[...lensBindings,uniformBinding(3,render),uniformBinding(4,tile.buffer),uniformBinding(20,pupil),uniformBinding(21,splitRays),uniformBinding(22,work)]):null;
        tile.sceneCounting=splitCountingPipelines?group(splitCountingPipelines.scene,[uniformBinding(0,optics),uniformBinding(3,render),uniformBinding(4,tile.buffer),{binding:5,resource:image.gpu.createView()},...sceneBindings,uniformBinding(21,splitRays),uniformBinding(22,work)]):null;
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
  function splitRayBytes(plan){
    const packetBytes=64*4*SPLIT_RAY_BYTES;
    const groups=Math.max(...plan.tiles.map(t=>Math.ceil(Math.ceil(plan.width/2)*t.halfHeight/64)));
    const cap=Math.floor(Math.min(Math.max(64*4*SPLIT_RAY_BYTES,splitRayBufferBytes),device.limits.maxBufferSize,device.limits.maxStorageBufferBindingSize)/packetBytes);
    return Math.min(groups,cap)*packetBytes;
  }
  function allocate(nextWidth){
    const plan=imagePlan(nextWidth,imageLimits,{paired:true}),buffers=[];let output,rayBuffer;
    interop.memoryBudget?.assertAdditional(plan.memoryBytes+(integrationMode==='split'?splitRayBytes(plan):0),'新旧图像并存的分配峰值');
    try{
      for(const t of plan.tiles)buffers.push({...t,buffer:interop.storage(t.bytes,'Tiled XYZ and attempted-path counters')});
      output=interop.storageImage(plan.width,plan.height);
      if(integrationMode==='split')rayBuffer=interop.storage(splitRayBytes(plan),'Split mirror: bounded optical batch packets');
      return {plan,tiles:buffers,image:output,splitRays:rayBuffer};
    }catch(error){for(const t of buffers)interop.release(t.buffer);if(rayBuffer)interop.release(rayBuffer);output?.texture.dispose();throw error;}
  }
  function releaseCandidate(candidate){for(const t of candidate.tiles)interop.release(t.buffer);if(candidate.splitRays)interop.release(candidate.splitRays);candidate.image.texture.dispose();}
  function install(candidate){
    for(const t of tiles)interop.release(t.buffer);image?.texture.dispose();
    if(splitRays)interop.release(splitRays);splitRays=candidate.splitRays??null;
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
    const encoder=device.createCommandEncoder();const timestamps=timed?timer.begin():undefined;
    const pass=encoder.beginComputePass(timestamps?{timestampWrites:timestamps}:{});
    pass.setPipeline(pipeline);pass.setBindGroup(0,bindGroup);pass.dispatchWorkgroups(x,y);pass.end();
    const timingRevision=currentRevision,timingDimensions={...dimensions};
    const collect=timed?timer.end(encoder,timestamps,ms=>{if(submission?.counted&&submission.countEpoch===countEpoch)recordWorkTiming(ms,submission.countedWorkUnits,'gpu',submission.workWindow);if(timingRevision===currentRevision){computeMs=ms;lastTiming={...timingDimensions,ms,chunkPixels:submission?.pixels??null,chunkSpp:submission?.spp??null};if(submission){submission.gpuMs=ms;chunkBudget.observe(submission,ms);}}}):null;
    device.queue.submit([encoder.finish()]);collect?.();
  }
  function submitSplit(tile,dispatch,sceneDispatch,submission){
    const encoder=device.createCommandEncoder({label:'Split mirror optical/scene batch'});
    const stages=stageTimer?.begin(),timestamps=stages?null:timer.begin();
    const lensStamp=stages?.lens??(timestamps?{querySet:timestamps.querySet,beginningOfPassWriteIndex:timestamps.beginningOfPassWriteIndex}:undefined);
    const sceneStamp=stages?.scene??(timestamps?{querySet:timestamps.querySet,endOfPassWriteIndex:timestamps.endOfPassWriteIndex}:undefined);
    const selected=submission.counted?splitCountingPipelines:splitPipelines;
    for(const [pipeline,bind,grid,label,stamp] of [[selected.raygen,submission.counted?tile.raygenCounting:tile.raygen,dispatch,'Split mirror lens batch',lensStamp],[selected.scene,submission.counted?tile.sceneCounting:tile.scene,sceneDispatch,'Split mirror scene batch',sceneStamp]]){
      const pass=encoder.beginComputePass({label,...(stamp?{timestampWrites:stamp}:{})});pass.setPipeline(pipeline);pass.setBindGroup(0,bind);pass.dispatchWorkgroups(grid.x,grid.y);pass.end();
    }
    const revision=currentRevision,timingDimensions={...dimensions};
    const accept=t=>{if(submission.counted&&submission.countEpoch===countEpoch)recordWorkTiming(t.ms,submission.countedWorkUnits,'gpu',submission.workWindow);if(revision===currentRevision){computeMs=t.ms;lastTiming={...timingDimensions,...t,chunkPixels:submission.pixels??null,chunkSpp:submission.spp??null};submission.gpuMs=t.ms;chunkBudget.observe(submission,t.ms);}};
    const collect=stages?stageTimer.end(encoder,stages,accept):timer.end(encoder,timestamps,ms=>accept({ms}));
    device.queue.submit([encoder.finish()]);collect?.();
  }
  const initializationMs=performance.now()-started;
  return {
    get texture(){return image.texture;},get outputGPU(){return image.gpu;},
    get spp(){return spp;},get dimensions(){return {...dimensions};},get packed(){return packed;},get tileCount(){return tiles.length;},get roundComplete(){return tileCursor===0&&groupCursor===0;},
    get pupilTable(){return pupilTable;},
    get initializationMs(){return initializationMs;},
    get computeMs(){return computeMs;},get timestampSupported(){return timer.supported;},
    get lastTiming(){return lastTiming;},
    get lastSubmission(){return lastSubmission;},
    get sampleSerial(){return sampleSerial;},
    // Samples per pixel including the submitted part of the current sweep; CPU-only, for live rate readouts.
    get progress(){return tiles.length&&tileGroups?spp+roundBudget*(tileCursor+groupCursor/tileGroups)/tiles.length:spp;},
    // If timestamps are supported, feedback is delivered by timer.end itself,
    // even when the asynchronous map completes after the queue fence callback.
    completeChunk(submission,wallMs){
      if(submission?.counted&&submission.countEpoch===countEpoch&&!timer.supported)recordWorkTiming(wallMs,submission.countedWorkUnits,'wall',submission.workWindow);
      if(!timer.supported&&submission?.revision===currentRevision)chunkBudget.observe(submission,wallMs);
    },
    get memoryBytes(){return dimensions.width*dimensions.height*(PIXEL_BYTES+8)+[optics,render,resolve,camera,target,surfaces,lut,pupil,work,splitRays].reduce((sum,buffer)=>sum+(buffer?.size??0),0);},
    async prepareLens(nextLens,state){
      const next=packLens(nextLens,state);
      return pupilPrecomputer.prepare(nextLens,next,{enabled:state?.pupilSampling!==false,bins:state?.pupilBins,movingCenter:state?.pupilMovingCenter});
    },
    reset,resize,resizeChecked,setLens,updateOptics,setPose,bindScene,
    get integrationMode(){return integrationMode;},
    get opticalLutReuse(){return opticalLutReuse;},
    async prepareSampling({mirrorReference=false}={}){
      if(!mirrorReference)return;
      validationCompile??=interop.computePipeline(sampleSource+validationSource,'Mirror sampling validation');
      const ready=await validationCompile;if(disposed)throw new Error('Optical engine disposed');pipelines.sampleValidation=ready;rebuildGroups();
    },
    get workCounting(){return counting&&Boolean(integrationMode==='split'?splitCountingPipelines:countingPipeline);},
    get workSupported(){return workSupported;},
    /** Resolves to 'counting' | 'off' | 'unsupported'. The counting variant compiles once, on first use. */
    async setWorkCounting(on){
      const epoch=++countEpoch;workWindow=0;closedWorkWindow=-1;counting=Boolean(on)&&workSupported;workUnits=0;workTimings.length=0;
      if(!counting)return workSupported?'off':'unsupported';
      if(integrationMode==='split'){
        if(!splitCountingPipelines){
          splitCountingCompile??=(async()=>{
            const sources=splitMirrorSources({integrator:integratorSource,optical:opticalSource,work:WORK_COUNTERS_WGSL,intersector:SCENE_INTERSECTOR_WGSL,shading:SCENE_SHADING_WGSL,spectral:SPECTRAL_WGSL,sampling:SAMPLING_WGSL,pupil:pupilSource,counting:true});
            const results=await Promise.allSettled(Object.entries(sources).map(async([name,code])=>[name,await interop.computePipeline(code,'Split mirror '+name+' + work counters')]));
            const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;
            return Object.fromEntries(results.map(r=>r.value));
          })();
          const ready=await splitCountingCompile;if(disposed)return 'off';splitCountingPipelines=ready;rebuildGroups();
        }
      }else if(!countingPipeline){countingCompile??=interop.computePipeline(countingSource,'Fused integrate + work counters (diagnostics)');const ready=await countingCompile;if(disposed)return 'off';countingPipeline=ready;rebuildGroups();}
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
          return {integrationMode,counts,workUnits:units,measuredWorkUnits:measured,timingCoverage:units>0?measured/units:0,msPerWorkUnit:measured>0?ms/measured:null,timing:timings.at(-1)?.source??null,timedChunks:timings.length};
        }finally{if(staging.mapState==='mapped')staging.unmap();interop.release(staging);workPending=null;}
      })();
      return workPending;
    },
    sample({batchSpp=1,targetSpp=64,seed=1,diagnostic='beauty',constantEnvironment=null,pinhole=null,chunked=false,interactive=false,mirrorReuse=true,mirrorReference=false}={}){
      bindScene();
      if(!tiles[0]?.sample)throw new Error('场景 BVH、光照资源或镜头尚未准备');
      // Complete every storage tile before advancing the global spp counter.
      const budget=(tileCursor||groupCursor)?roundBudget:sampleBudget(spp,targetSpp,batchSpp);if(!budget)return false;
      if(tileCursor===0&&groupCursor===0){
        roundTarget=targetSpp;
        // Paired storage bands own all four destinations, even on GPUs whose
        // buffer binding limit requires many tiles. Freeze for a full sweep.
        roundMirror=mirrorReuse&&!pinhole?(mirrorReference?4:2):0;
      }
      roundBudget=budget;const tile=tiles[tileCursor];
      const groupsX=roundMirror?Math.ceil(Math.ceil(dimensions.width/2)/8):Math.ceil(dimensions.width/8);
      const groupsY=roundMirror?Math.ceil(tile.halfHeight/8):Math.ceil(tile.height/8);
      const totalGroups=roundMirror&&integrationMode==='split'?Math.ceil(Math.ceil(dimensions.width/2)*tile.halfHeight/64):groupsX*groupsY;
      const useSplit=integrationMode==='split'&&roundMirror===2;
      const plan=chunkBudget.plan(interactive,budget*(roundMirror?4:1),totalGroups-groupCursor);
      const requested=chunked?plan.groups:totalGroups-groupCursor;
      const scratchGroups=useSplit?Math.floor(splitRays.size/(64*budget*SPLIT_RAY_BYTES)):totalGroups;
      const groups=Math.min(requested,scratchGroups);
      const dispatch=(chunked||(roundMirror&&integrationMode==='split'))?chunkDispatch(groups,device.limits.maxComputeWorkgroupsPerDimension):{x:groupsX,y:groupsY};
      if(roundMirror===4&&!pipelines.sampleValidation)throw new Error('Call prepareSampling before requesting mirror validation modes');
      const counted=counting&&Boolean(useSplit?tile.raygenCounting:tile.sampleCounting)&&!pinhole;
      const submission={revision:currentRevision,chunked,interactive,groups,work:groups*budget*(roundMirror?4:1),capacity:Math.min(totalGroups,scratchGroups)*budget*(roundMirror?4:1),tail:plan.tail,targetMs:plan.targetMs,gpuMs:null,counted,mirrorMode:roundMirror,integrationMode:useSplit?'split':'fused'};
      submission.countEpoch=countEpoch;submission.workWindow=workWindow;submission.countedWorkUnits=submission.work;
      // Pixels this chunk writes (mirror reuse covers four per thread), for the HUD.
      submission.spp=budget;submission.pixels=Math.min(dimensions.width*tile.height,groups*64*(roundMirror?4:1));
      if(useSplit){
        const halfWidth=Math.ceil(dimensions.width/2),begin=groupCursor*64,end=Math.min(begin+groups*64,halfWidth*tile.halfHeight);
        const central=dimensions.width%2?Math.floor(end/halfWidth)-Math.floor(begin/halfWidth):0;
        submission.countedWorkUnits=budget*(4*(end-begin)-2*central)/64;submission.pixels=4*(end-begin)-2*central;
      }
      if(counted)workUnits+=submission.countedWorkUnits;
      lastSubmission=submission;
      const bytes=new ArrayBuffer(192),f=new Float32Array(bytes),u=new Uint32Array(bytes);f.set(pinhole?.cameraToWorld??pose.elements);
      u.set([dimensions.width,dimensions.height,budget,roundTarget,seed,diagnosticIndex(diagnostic),constantEnvironment?1:0,tile.y],16);
      f.set([...(constantEnvironment??[0,0,0]),0],24);u[27]=tile.halfHeight;u.set([pinhole?1:roundMirror,(chunked||roundMirror)?groupCursor:0,(chunked||roundMirror)?dispatch.x:0,(chunked||roundMirror)?groups:0],28);if(pinhole)f.set(pinhole.clipToCamera,32);
      const sceneDispatch=useSplit?chunkDispatch(groups*4,device.limits.maxComputeWorkgroupsPerDimension):null;
      if(useSplit)u[32]=sceneDispatch.x;
      device.queue.writeBuffer(render,0,bytes);
      const pipeline=roundMirror===4?pipelines.sampleValidation:roundMirror?pipelines.sampleMirror:pipelines.sample;
      const bindGroup=roundMirror===4?tile.sampleValidation:roundMirror?tile.sampleMirror:tile.sample;
      if(useSplit)submitSplit(tile,dispatch,sceneDispatch,submission);
      else submit(counted?countingPipeline:pipeline,counted?tile.sampleCounting:bindGroup,dispatch.x,dispatch.y,{timed:true,submission});
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
    dispose(){disposed=true;pupilPrecomputer.dispose();timer.dispose();stageTimer?.dispose();for(const b of [optics,render,resolve,camera,target,surfaces,lut,pupil,work,splitRays,...tiles.map(t=>t.buffer)])if(b)interop.release(b);image?.texture.dispose();},
  };
}

function createSplitStageTimer(interop){
  const {device}=interop;
  if(!device.features.has('timestamp-query'))return null;
  const queries=device.createQuerySet({type:'timestamp',count:4});
  let resolve,read;
  try{resolve=interop.buffer(32,GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC,'Split timestamp resolve');read=interop.buffer(32,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ,'Split timestamp readback');}
  catch(error){queries.destroy();if(resolve)interop.release(resolve);throw error;}let pending=false;
  return {
    begin(){if(pending)return undefined;pending=true;return {lens:{querySet:queries,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1},scene:{querySet:queries,beginningOfPassWriteIndex:2,endOfPassWriteIndex:3}};},
    end(encoder,stamps,callback){encoder.resolveQuerySet(queries,0,4,resolve,0);encoder.copyBufferToBuffer(resolve,0,read,0,32);return ()=>read.mapAsync(GPUMapMode.READ).then(()=>{const t=new BigUint64Array(read.getMappedRange()),ms=timestampSpanMs(t[0],t[3]),lensMs=timestampSpanMs(t[0],t[1]),sceneMs=timestampSpanMs(t[2],t[3]);read.unmap();pending=false;if(ms!==null)callback({ms,lensMs,sceneMs});},()=>{pending=false;});},
    dispose(){queries.destroy();interop.release(resolve);interop.release(read);},
  };
}
