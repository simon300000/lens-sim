import {stripWorkCounting} from './shader-source.js';
import rawOpticalSource from '../optics/optical-core.wgsl.js';
import {opticalSourceForLutPolicy} from './optical-source.js';
import { SCENE_INTERSECTOR_WGSL, SCENE_SURFACE_WGSL, SCENE_RAY_WGSL, SCENE_SAMPLE_WGSL, WORK_COUNTERS_WGSL } from './scene-wgsl.js';
import {planRayBatch,decodeCells,decodeLobe,initialCellTable,CACHE_TABLE_WORDS,CACHE_BYTES_PER_SAMPLE,cellShift,CACHE_SPP_LIMIT,CACHE_CELLS_MAX,CELL_STRIDE,CELL_FIXED_PER_MM,CACHE_RAY_BYTES,CACHE_RESULT_BYTES,CACHE_INDEX_BYTES,CACHE_RETRY_BIT,CACHE_RESCUE_BIT} from './ray-cache.js';
import {exitFootprint} from '../optics/front-element.js';
import rawIntegratorSource from './optical-integrator.wgsl.js';
import resolveSource from './resolve.wgsl.js';
import targetSource from '../optics/focus-target.wgsl.js';
import statisticsSource from './statistics.wgsl.js';
import statisticsReduceSource from './statistics-reduce.wgsl.js';
import {statisticsConfiguration,specializeStatistics} from './statistics-plan.js';
import { SPECTRAL_WGSL, xyzToRGB } from '../spectral/reconstruction.js';
import { SAMPLING_WGSL } from '../spectral/sampler.js';
import {createPupilPrecomputer} from '../optics/pupil-precompute.js';
import { buildPupilTable, PUPIL_TABLE_BYTES } from '../optics/pupil-sampling.js';
import pupilSource from '../optics/pupil-sampling.wgsl.js';
import { packLens } from '../optics/lens-state.js';
import { createComputeTimer,timestampSpanMs,OUTPUT_FORMATS } from './gpu-interop.js';
import { imagePlan, sampleBudget, PIXEL_BYTES, ROUND_SPP_LIMIT, roundSppWGSL, MAX_IMAGE_WIDTH } from './sampling-plan.js';
import { WORK_COUNTERS } from './work-model.js';
import { createChunkBudget,chunkDispatch } from './adaptive-chunks.js';
import {stagedIntegratorSources,STAGED_RAY_BYTES,STAGED_HIT_BYTES,STAGED_SCRATCH_BYTES} from './staged-integrator.js';
import {PROVIDER_BINDING_BASE,providerSource} from './radiance-provider.js';

export const DIAGNOSTIC_MODES=Object.freeze({beauty:0,'scene-error':1,status:2,'geometry-depth':3,'geometry-normal':4,'geometry-material':5});
// Modes >= 3 change what is accumulated (debug RGB), so switching resets accumulation.
export const ACCUMULATING_DIAGNOSTICS=Object.freeze(['geometry-depth','geometry-normal','geometry-material']);
const diagnosticIndex=mode=>DIAGNOSTIC_MODES[mode]??0;
const uniformBinding=(binding,buffer)=>({binding,resource:{buffer}});
const IDENTITY=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
/** World point -> local space of a column-major affine pose (f64). */
function inverseAffinePoint(m,p){
  const [a,b,c,d,e,f,g,h,i]=[m[0],m[4],m[8],m[1],m[5],m[9],m[2],m[6],m[10]],x=p[0]-m[12],y=p[1]-m[13],z=p[2]-m[14];
  const A=e*i-f*h,B=-(d*i-f*g),C=d*h-e*g,det=a*A+b*B+c*C;
  return [(A*x-(b*i-c*h)*y+(b*f-c*e)*z)/det,(B*x+(a*i-c*g)*y-(a*f-c*d)*z)/det,(C*x-(a*h-b*g)*y+(a*e-b*d)*z)/det];
}

/** The lens tracer's GPU engine: real-lens raygen, the BVH trace stage (surface
 * providers only) and the radiance provider's shading stage, accumulated per
 * pixel in XYZ. No DOM and no rendering framework; lens-tracer.js is the
 * embedding API built on it.
 *   interop: createGPUInterop(device) (or the three adapter, three-interop.js)
 *   sceneResources: scene BVH ({ready, revision, bindings(6)}); needed by surface providers and AF
 *   provider: radiance provider (radiance-provider.js)
 *   aspect: image width / height (the sensor's, kept in step by setLens)
 *   maxWidth: resolution ceiling (default MAX_IMAGE_WIDTH; Infinity: the device's texture limit only) */
export async function createOpticalEngine({interop,sceneResources=null,provider,width=480,aspect=1.5,outputFormat='rgba16float',accumulationBindingBytes=Infinity,stageTiming=false,chunkTiming='timestamp',opticalLutReuse=false,stagedRayBufferBytes=STAGED_SCRATCH_BYTES,roundSppLimit=ROUND_SPP_LIMIT,maxWidth=MAX_IMAGE_WIDTH,workers}) {
  const started=performance.now(),{device}=interop;
  if(!OUTPUT_FORMATS.includes(outputFormat))throw new RangeError(`Unsupported output format ${outputFormat}`);
  if(provider.kind==='surface'&&!sceneResources)throw new Error('A surface radiance provider needs scene BVH resources');
  const opticalSource=opticalSourceForLutPolicy(rawOpticalSource,opticalLutReuse);
  const format=code=>outputFormat==='rgba16float'?code:code.replaceAll('texture_storage_2d<rgba16float,write>',`texture_storage_2d<${outputFormat},write>`);
  const statisticsConfig=statisticsConfiguration(device.limits);
  // A smaller binding cap is useful for validating paired bands on small
  // images. It can only reduce, never exceed the actual device limits.
  const imageLimits={maxTextureDimension2D:device.limits.maxTextureDimension2D,maxBufferSize:device.limits.maxBufferSize,
    maxStorageBufferBindingSize:Math.min(device.limits.maxStorageBufferBindingSize,accumulationBindingBytes)};
  let currentAspect=aspect,mode=provider.kind;
  const initialPlan=imagePlan(width,imageLimits,{paired:true,aspect,maxWidth});
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
  const stripped=stripWorkCounting(rawIntegratorSource);
  const entry='if(render.debug.x>=2u){integrateMirrors(id);}else{integratePixel(id);}';
  const independentSource=stripped.replace(entry,'integratePixel(id);');
  const validationSource=stripped.replace(entry,'integrateMirrors(id);');
  /** Shader sources that depend on the radiance provider. Independent/pinhole rays
   * and explicit quadrant retracing are diagnostic references of surface providers;
   * production mirror batches always use the staged passes. */
  function providerSources(next,{counting=false}={}){
    const surface=next.kind==='surface',shading=(surface?SCENE_SURFACE_WGSL:SCENE_RAY_WGSL)+providerSource(next,PROVIDER_BINDING_BASE);
    const staged=stagedIntegratorSources({integrator:rawIntegratorSource,optical:opticalSource,work:WORK_COUNTERS_WGSL,intersector:SCENE_INTERSECTOR_WGSL,shading,spectral:SPECTRAL_WGSL,sampling:SAMPLING_WGSL,pupil:pupilSource,roundSppLimit,counting,mode:next.kind});
    const sample=surface?roundSppWGSL(roundSppLimit)+WORK_COUNTERS_WGSL+opticalSource+SCENE_INTERSECTOR_WGSL+shading+SPECTRAL_WGSL+SAMPLING_WGSL+pupilSource:null;
    return {staged:Object.fromEntries(Object.entries(staged).map(([name,code])=>[name,format(code)])),sample:sample&&format(sample)};
  }
  async function compileAll(jobs){
    const compiled=await Promise.allSettled(jobs.map(([,code,label])=>interop.computePipeline(code,label)));
    const failure=compiled.find(result=>result.status==='rejected');if(failure)throw failure.reason;
    return Object.fromEntries(jobs.map(([name],i)=>[name,compiled[i].value]));
  }
  function providerJobs(next){
    const sources=providerSources(next);
    return [...Object.entries(sources.staged).map(([name,code])=>['staged_'+name,code,`Staged ${name} batch (${next.label??next.kind})`]),
      ...(sources.sample?[['sample',sources.sample+independentSource,'Independent/pinhole validation reference']]:[])];
  }
  const coreJobs=[
    ['resolve',format(SPECTRAL_WGSL+resolveSource),'XYZ display-only resolve'],
    ...(sceneResources?[['target',WORK_COUNTERS_WGSL+opticalSource+SCENE_INTERSECTOR_WGSL+targetSource,'AF reference ray -> BVH first opaque surface']]:[]),
    ['statistics',specializeStatistics(statisticsSource,statisticsConfig),'Attempt statistics partial reduction'],
    ['statisticsReduce',specializeStatistics(statisticsReduceSource,statisticsConfig),'Attempt statistics final reduction'],
  ];
  const startupBuffers=[optics,render,resolve,camera,target,pupil,work];
  let pipelines;
  try{pipelines=await compileAll([...coreJobs,...providerJobs(provider)]);}catch(error){for(const b of startupBuffers)interop.release(b);throw error;}
  const timer=createComputeTimer(interop),pupilPrecomputer=createPupilPrecomputer({worker:workers?.pupil});
  const stagedSet=set=>({raygen:set.staged_raygen,trace:set.staged_trace??null,scene:set.staged_scene});
  let stagedPipelines=stagedSet(pipelines),stagedRays=null,stagedHits=null;
  // 'timestamp': GPU timestamp queries time each chunk (benchmarks). 'queue': the caller reports
  // chunk times from queue completions via completeChunk; no timestamp queries are issued.
  if(!['timestamp','queue'].includes(chunkTiming))throw new RangeError('Unknown chunk timing');
  const useTimestamps=chunkTiming==='timestamp';
  const stageNames=()=>mode==='surface'?['lens','trace','scene']:['lens','scene'];
  let stageTimer=stageTiming&&useTimestamps?createStageTimer(interop,stageNames()):null;
  let pupilTable;
  let surfaces,lut,tiles=[],tileCursor=0,groupCursor=0,chunkBudget=createChunkBudget(),lastSubmission=null,sampleSerial=0,roundBudget=0,roundTarget=0,roundMirror=0,tileGroups=0,image,packed,lens,groups={},spp=0,disposed=false,computeMs=null,statsPending=null,lastTiming=null;
  let dimensions={width:0,height:0},currentRevision=0,resizeRevision=0;
  let cacheCore=null,cacheResolve=null,cacheBuffers=null,cacheBatch=null,cacheRadius=null,cacheSerial=0;
  // Held ray batches in trace order, and the spp of sweeps they traced completely (not yet accumulated).
  let held=[],heldSpp=0;
  // Sensor bands (setBands): explicit packet-group ranges traced band by band; spp per band.
  let bands=null;
  const pose=new Float32Array(IDENTITY);
  let sceneBound=-1,providerBound=-1,providerObject=null;
  // Work counting (diagnostics HUD only): workgroup-samples submitted since the
  // last readback, and GPU (or wall) time of recent counted chunks.
  let workWindow=0,closedWorkWindow=-1,countEpoch=0,stagedCountingPipelines=null,stagedCountingCompile=null;
  let counting=false,workUnits=0,workPending=null,validationCompile=null;const workTimings=[];
  const workSupported=device.limits.maxStorageBuffersPerShaderStage>=9;
  function recordWorkTiming(ms,units,source,window){if(!(ms>0&&units>0)||window<=closedWorkWindow)return;workTimings.push({ms,units,source,window});}

  function group(pipeline,entries){return device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries});}
  const surfaceMode=()=>mode==='surface';
  function rebuildGroups(){
    groups={};for(const tile of tiles)for(const key of ['sample','sampleValidation','raygen','trace','scene','raygenCounting','traceCounting','sceneCounting','resolve'])tile[key]=null;
    const sceneReady=Boolean(sceneResources?.ready);
    if(!surfaces||!image||provider.ready===false||(surfaceMode()&&!sceneReady))return;
    const lensBindings=[uniformBinding(0,optics),uniformBinding(1,surfaces),uniformBinding(2,lut)];
    const providerBindings=provider.bindings(PROVIDER_BINDING_BASE);
    const sceneBindings=surfaceMode()?[...sceneResources.bindings(6),...providerBindings]:providerBindings;
    for(const tile of tiles){
      if(surfaceMode()){
        const sampleBindings=[...lensBindings,uniformBinding(3,render),uniformBinding(4,tile.buffer),{binding:5,resource:image.gpu.createView()},...sceneBindings,uniformBinding(20,pupil)];
        tile.sampleValidation=pipelines.sampleValidation?group(pipelines.sampleValidation,sampleBindings):null;
        tile.sample=group(pipelines.sample,sampleBindings);
      }
      tile.raygen=group(stagedPipelines.raygen,[...lensBindings,uniformBinding(3,render),uniformBinding(4,tile.buffer),uniformBinding(20,pupil),uniformBinding(21,stagedRays)]);
      const hitBindings=surfaceMode()?[uniformBinding(23,stagedHits)]:[];
      tile.scene=group(stagedPipelines.scene,[uniformBinding(0,optics),uniformBinding(3,render),uniformBinding(4,tile.buffer),{binding:5,resource:image.gpu.createView()},...sceneBindings,uniformBinding(21,stagedRays),...hitBindings]);
      tile.raygenCounting=stagedCountingPipelines?group(stagedCountingPipelines.raygen,[...lensBindings,uniformBinding(3,render),uniformBinding(4,tile.buffer),uniformBinding(20,pupil),uniformBinding(21,stagedRays),uniformBinding(22,work)]):null;
      tile.sceneCounting=stagedCountingPipelines?group(stagedCountingPipelines.scene,[uniformBinding(0,optics),uniformBinding(3,render),uniformBinding(4,tile.buffer),{binding:5,resource:image.gpu.createView()},...sceneBindings,uniformBinding(21,stagedRays),uniformBinding(22,work),...hitBindings]):null;
      if(surfaceMode()){
        const traceBindings=[uniformBinding(3,render),uniformBinding(4,tile.buffer),...sceneResources.bindings(6).slice(0,3),uniformBinding(21,stagedRays),uniformBinding(23,stagedHits)];
        tile.trace=group(stagedPipelines.trace,traceBindings);
        tile.traceCounting=stagedCountingPipelines?group(stagedCountingPipelines.trace,[...traceBindings,uniformBinding(22,work)]):null;
      }
      tile.resolve=group(pipelines.resolve,[uniformBinding(0,resolve),uniformBinding(1,tile.buffer),{binding:2,resource:image.gpu.createView()}]);
    }
    if(pipelines.target&&sceneReady)groups.target=group(pipelines.target,[...lensBindings,uniformBinding(3,camera),uniformBinding(4,target),...sceneResources.bindings(6).slice(0,3)]);
    sceneBound=sceneResources?.revision??-1;providerBound=provider.revision;providerObject=provider;
  }
  /** Rebind after a BVH (re)upload or a change of the provider's resources. */
  function bindScene(){if(sceneBound!==(sceneResources?.revision??-1)||providerBound!==provider.revision||providerObject!==provider||!tiles[0]?.scene)rebuildGroups();}
  function releaseHeld(){for(const h of held)for(const buffer of h.buffers)interop.release(buffer);held=[];heldSpp=0;if(bands)for(const b of bands)b.held=0;for(const tile of tiles)if(tile.estimate){interop.release(tile.estimate);tile.estimate=null;}}
  function reset({resetTiming=false}={}){
    if(resetTiming)chunkBudget=createChunkBudget();
    releaseHeld();
    currentRevision++;spp=0;bands=null;tileCursor=0;groupCursor=0;lastSubmission=null;roundBudget=0;tileGroups=0;computeMs=null;lastTiming=null;cacheBatch=null;
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
  /** Surface providers: 4 quadrant hit records per optical sample. Ray providers trace nothing. */
  function stagedHitBytes(plan){return mode==='surface'?stagedRayBytes(plan)/STAGED_RAY_BYTES*4*STAGED_HIT_BYTES:0;}
  function allocate(nextWidth){
    const plan=imagePlan(nextWidth,imageLimits,{paired:true,aspect:currentAspect,maxWidth}),buffers=[];let output,rayBuffer,hitBuffer;
    interop.memoryBudget?.assertAdditional(plan.memoryBytes+(stagedRayBytes(plan)+stagedHitBytes(plan)),'新旧图像并存的分配峰值');
    try{
      for(const t of plan.tiles)buffers.push({...t,buffer:interop.storage(t.bytes,'Tiled XYZ and attempted-path counters')});
      output=interop.storageImage(plan.width,plan.height,{format:outputFormat});
      rayBuffer=interop.storage(stagedRayBytes(plan),'Staged: bounded optical batch packets');
      if(mode==='surface')hitBuffer=interop.storage(stagedHitBytes(plan),'Staged: first-hit records');
      return {plan,tiles:buffers,image:output,stagedRays:rayBuffer,stagedHits:hitBuffer??null};
    }catch(error){for(const t of buffers)interop.release(t.buffer);if(rayBuffer)interop.release(rayBuffer);if(hitBuffer)interop.release(hitBuffer);output?.dispose();throw error;}
  }
  function releaseCandidate(candidate){for(const t of candidate.tiles)interop.release(t.buffer);if(candidate.stagedRays)interop.release(candidate.stagedRays);if(candidate.stagedHits)interop.release(candidate.stagedHits);candidate.image.dispose();}
  function install(candidate){
    releaseHeld();for(const t of tiles)interop.release(t.buffer);image?.dispose();
    if(stagedRays)interop.release(stagedRays);stagedRays=candidate.stagedRays??null;
    if(stagedHits)interop.release(stagedHits);stagedHits=candidate.stagedHits??null;
    dimensions={width:candidate.plan.width,height:candidate.plan.height};tiles=candidate.tiles;image=candidate.image;
    rebuildGroups();reset();return true;
  }
  const unchanged=nextWidth=>{const p=imagePlan(nextWidth,imageLimits,{paired:true,aspect:currentAspect,maxWidth});return p.width===dimensions.width&&p.height===dimensions.height;};
  function resize(nextWidth){
    resizeRevision++;
    if(unchanged(nextWidth))return false;
    return install(allocate(nextWidth));
  }
  async function resizeChecked(nextWidth){
    const token=++resizeRevision;
    if(unchanged(nextWidth))return false;
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
  /** A sensor of another aspect ratio reallocates the image at the same width. */
  function matchSensor(state){
    const sensor=state?.sensorMm;if(!sensor)return;
    const next=sensor[0]/sensor[1];if(!(next>0&&Number.isFinite(next)))throw new RangeError('Invalid sensor size');
    if(Math.abs(next-currentAspect)>1e-9){currentAspect=next;install(allocate(dimensions.width));}
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
    packed=next;lens=nextLens;device.queue.writeBuffer(optics,0,next.parameters);matchSensor(state);rebuildGroups();reset({resetTiming:true});return next;
  }
  function updateOptics(state){
    const next=packLens(lens,state);updatePupil(lens,next,state);packed=next;device.queue.writeBuffer(optics,0,next.parameters);matchSensor(state);reset({resetTiming:true});return next;
  }
  /** cameraToWorld: column-major 4x4 (16 numbers), lens space (metres) -> world. */
  function setPose(cameraToWorld){
    if(!(cameraToWorld?.length>=16))throw new TypeError('setPose expects a column-major 4x4 camera-to-world matrix');
    pose.set(Array.prototype.slice.call(cameraToWorld,0,16));device.queue.writeBuffer(camera,0,pose);
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
    if(surfaceMode())passes.push([selected.trace,submission.counted?tile.traceCounting:tile.trace,sceneDispatch,'Staged traversal batch',stages?.trace]);
    passes.push([selected.scene,submission.counted?tile.sceneCounting:tile.scene,sceneDispatch,'Staged scene batch',sceneStamp]);
    for(const [pipeline,bind,grid,label,stamp] of passes){
      const pass=encoder.beginComputePass({label,...(stamp?{timestampWrites:stamp}:{})});pass.setPipeline(pipeline);pass.setBindGroup(0,bind);pass.dispatchWorkgroups(grid.x,grid.y);pass.end();
    }
    const revision=currentRevision,timingDimensions={...dimensions};
    const accept=t=>{if(submission.counted&&submission.countEpoch===countEpoch)recordWorkTiming(t.ms,submission.countedWorkUnits,'gpu',submission.workWindow);if(revision===currentRevision){computeMs=t.ms;lastTiming={...timingDimensions,...t,chunkPixels:submission.pixels??null,chunkSpp:submission.spp??null};submission.gpuMs=t.ms;chunkBudget.observe(submission,t.ms);}};
    const collect=stages?stageTimer.end(encoder,stages,accept):timestamps?timer.end(encoder,timestamps,ms=>accept({ms})):null;
    device.queue.submit([encoder.finish()]);collect?.();
  }
  async function readAccumulation(){
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
  }
  // ------------------------------------------------------------------ ray cache
  // Lens first: a batch of S spp is traced into GPU packets and binned by exit
  // point; the host renders one view per cell and resolves that cell's rays with
  // its ray provider; finish() accumulates every attempt (ray-cache.js).
  const CACHED_ROUND=8;
  async function cachePipelines(){
    if(provider.kind!=='ray')throw new Error('The ray cache needs a ray radiance provider');
    const target=provider;
    const sources=stagedIntegratorSources({integrator:rawIntegratorSource,optical:opticalSource,work:WORK_COUNTERS_WGSL,intersector:'',shading:SCENE_RAY_WGSL+providerSource(target,PROVIDER_BINDING_BASE),
      spectral:SPECTRAL_WGSL,sampling:SAMPLING_WGSL,pupil:pupilSource,sample:SCENE_SAMPLE_WGSL,roundSppLimit:CACHE_SPP_LIMIT,mode:'cached'});
    const jobs=Object.entries(sources).filter(([name])=>name==='resolve'?cacheResolve?.provider!==target:!cacheCore).map(([name,code])=>[name,format(code),'Ray cache '+name]);
    const compiled=await compileAll(jobs);if(disposed)throw new Error('Optical engine disposed');
    if(!cacheCore)cacheCore=compiled;
    if(compiled.resolve)cacheResolve={provider:target,pipeline:compiled.resolve,group:null,revision:-1};
    if(target!==provider)return cachePipelines();
  }
  function cacheBuffer(name,bytes,label){
    const current=cacheBuffers?.[name];if(current&&current.size>=bytes)return current;
    if(current)interop.release(current);
    cacheBuffers[name]=interop.storage(Math.max(16,bytes),label);return cacheBuffers[name];
  }
  /** Exit-disk radius of the current lens/stop (lens space mm) from the CPU footprint. */
  function exitRadius(){
    if(cacheRadius?.packed!==packed){const footprint=exitFootprint(lens,packed,{fields:5,samples:192});cacheRadius={packed,radiusMm:Math.max(footprint.maxRadiusMm,1e-3)*1.0001,footprint};}
    return cacheRadius.radiusMm;
  }
  /** A held batch's own buffers. Out of memory (the interop budget or the device)
   * throws an error with code 'ray-cache-memory'; the host then finishes held
   * batches before tracing more. */
  async function heldBuffers(specs){
    device.pushErrorScope('out-of-memory');
    const made=[];let failure=null;
    try{for(const [bytes,label,uniform] of specs)made.push(uniform?interop.uniform(new Uint8Array(bytes),label):interop.storage(Math.max(16,bytes),label));}catch(error){failure=error;}
    const memory=await device.popErrorScope();
    if(!failure&&!memory)return made;
    for(const buffer of made)interop.release(buffer);
    const bytes=specs.reduce((n,s)=>n+s[0],0);
    throw Object.assign(new RangeError(`Ray cache: no memory for another held batch (${(bytes/2**20).toFixed(1)} MiB): ${(failure??memory).message}`),{code:'ray-cache-memory'});
  }
  const bandBytesPerSpp=band=>band.groups*64*CACHE_BYTES_PER_SAMPLE;
  /** Sensor tiles ("bands"): [{tile, rows: [r0, r1), cols: [c0, c1)}] in 8x8 packet-group rows and
   * columns of an accumulation tile (cols default: whole rows); they must cover the frame without
   * overlap. A tile cut from traced tiles keeps their spp (all equal), so traced tiles can be split. */
  function setBands(list){
    if(cacheBatch)throw new Error('Finish the open ray batch first');
    if(held.length)throw new Error('Finish the held ray batches first');
    if(tileCursor!==0||groupCursor!==0)throw new Error('A sampling round is in progress');
    if(!bands&&spp)throw new Error('Reset before tracing in sensor bands');
    const blocksX=Math.ceil(Math.ceil(dimensions.width/2)/8),old=new Map((bands??[]).map(b=>[b.key,b]));
    const covered=tiles.map(t=>new Uint8Array(Math.ceil(t.halfHeight/8)*blocksX));
    const next=list.map(({tile,rows:[r0,r1],cols:[c0,c1]=[0,blocksX]})=>{
      const rowsInTile=covered[tile]?.length/blocksX;
      if(!rowsInTile||!(Number.isInteger(r0)&&Number.isInteger(r1)&&r0>=0&&r1>r0&&r1<=rowsInTile))throw new RangeError('Invalid sensor band');
      if(!(Number.isInteger(c0)&&Number.isInteger(c1)&&c0>=0&&c1>c0&&c1<=blocksX))throw new RangeError('Invalid sensor band columns');
      for(let r=r0;r<r1;r++)for(let c=c0;c<c1;c++){if(covered[tile][r*blocksX+c])throw new RangeError('Sensor bands overlap');covered[tile][r*blocksX+c]=1;}
      const key=`${tile}:${r0}:${r1}:${c0}:${c1}`;
      if(old.has(key))return old.get(key);
      // A part of a band keeps its spp (its pixels' attempts); a band across traced bands of different spp cannot exist.
      const parents=[...old.values()].filter(b=>b.tile===tile&&b.rows[0]<r1&&b.rows[1]>r0&&b.cols[0]<c1&&b.cols[1]>c0),spps=new Set(parents.map(b=>b.spp));
      if(spps.size>1)throw new Error('A sensor band cannot join bands traced to different spp');
      const window=c0>0||c1<blocksX;
      return {key,tile,rows:[r0,r1],cols:[c0,c1],window,cursor:r0*blocksX,groups:(r1-r0)*(c1-c0),spp:parents[0]?.spp??0,held:0};
    });
    if(covered.some(c=>c.some(v=>!v)))throw new RangeError('Sensor bands must cover the frame');
    bands=next;spp=Math.min(...bands.map(b=>b.spp));
    return engine.bands;
  }
  /** The accumulation plus the resolved rays of the held batches (ray-cache.js preview). */
  function previewHeld(){
    const encoder=device.createCommandEncoder({label:'Ray cache preview'}),b=(binding,buffer)=>uniformBinding(binding,buffer);
    for(const tile of tiles){tile.estimate??=interop.storage(tile.bytes,'Ray cache: preview estimate');encoder.copyBufferToBuffer(tile.buffer,0,tile.estimate,0,tile.bytes);}
    for(const h of held){
      const pass=encoder.beginComputePass({label:'Ray cache preview'});pass.setPipeline(cacheCore.preview);
      pass.setBindGroup(0,group(cacheCore.preview,[b(0,optics),b(3,h.render),b(4,h.tile.buffer),b(18,h.results),b(21,h.rays),b(22,h.tile.estimate)]));
      pass.dispatchWorkgroups(h.sceneDispatch.x,h.sceneDispatch.y);pass.end();
    }
    device.queue.submit([encoder.finish()]);
  }
  /** One cached batch (see lens-tracer.js rayBatch). Resolves to the batch handle
   * or null when the target spp is already reached. */
  async function rayBatch({spp:requested=16,targetSpp=0,seed=1,grid=4,memoryBytes=512*1024**2,rotation,jitter,radiusMm,hold=false,band:bandIndex=null}={}){
    if(cacheBatch)throw new Error('Finish the open ray batch first');
    if(held.length&&!hold)throw new Error('Finish the held ray batches first');
    const band=bandIndex===null?null:bands?.[bandIndex];
    if(bandIndex!==null&&(!band||!hold))throw new Error('A band batch needs setBands() and hold: true');
    if(!Number.isInteger(grid)||grid<1||grid*grid>CACHE_CELLS_MAX)throw new RangeError(`Ray cache grid must be 1..${Math.sqrt(CACHE_CELLS_MAX)}`);
    await cachePipelines();bindScene();
    if(!tiles[0]?.scene)throw new Error('镜头或辐亮度提供者尚未准备');
    const revision=currentRevision;
    const roundStart=tileCursor===0&&groupCursor===0;
    if(!roundStart&&roundMirror!==CACHED_ROUND)throw new Error('A direct sampling round is in progress');
    const tile=tiles[band?band.tile:tileCursor],halfWidth=Math.ceil(dimensions.width/2);
    const cursor=band?band.cursor:groupCursor;
    const totalGroups=Math.ceil(halfWidth/8)*Math.ceil(tile.halfHeight/8);
    const limit=Math.min(device.limits.maxBufferSize,device.limits.maxStorageBufferBindingSize);
    let budget,groups;
    if(band){
      // A band is traced whole: S shrinks to fit memoryBytes, never the band.
      const wanted=sampleBudget(band.spp+band.held,targetSpp,requested,CACHE_SPP_LIMIT);if(!wanted)return null;
      const plan=planRayBatch({totalGroups:band.groups,spp:wanted,memoryBytes,maxBufferBytes:limit});
      if(plan.groups<band.groups)throw Object.assign(new RangeError(`Ray cache: a band of ${band.groups} packet groups exceeds the cache budget at 1 spp`),{code:'band-cache',bytesPerSpp:bandBytesPerSpp(band)});
      budget=plan.spp;roundTarget=targetSpp;roundMirror=CACHED_ROUND;
    }else if(roundStart){
      const wanted=sampleBudget(spp+heldSpp,targetSpp,requested,CACHE_SPP_LIMIT);if(!wanted)return null;
      const plan=planRayBatch({totalGroups,spp:wanted,memoryBytes,maxBufferBytes:limit});
      budget=plan.spp;roundTarget=targetSpp;roundMirror=CACHED_ROUND;roundBudget=budget;
    }else budget=roundBudget;
    // A tile that does not fit the budget is resolved in several batches of packet groups.
    groups=band?band.groups:planRayBatch({totalGroups:totalGroups-groupCursor,spp:budget,memoryBytes,maxBufferBytes:limit,fixedSpp:true}).groups;
    const capacity=groups*64,rays=capacity*budget*4;
    const sizes={rays:capacity*budget*CACHE_RAY_BYTES,indices:rays*CACHE_INDEX_BYTES,results:rays*CACHE_RESULT_BYTES};
    cacheBuffers??={};
    const cells=cacheBuffer('cells',CACHE_TABLE_WORDS*4,'Ray cache: cell table');
    let rayBuffer,indices,results,cacheParams,batchRender,buffers=[];
    if(hold){
      buffers=await heldBuffers([[sizes.rays,'Held ray batch: lens packets'],[sizes.indices,'Held ray batch: cell-sorted ray indices'],[sizes.results,'Held ray batch: per-ray results'],[48,'Held ray batch: parameters',true],[192,'Held ray batch: render parameters',true]]);
      [rayBuffer,indices,results,cacheParams,batchRender]=buffers;
    }else{
      rayBuffer=cacheBuffer('rays',sizes.rays,'Ray cache: lens packets');
      indices=cacheBuffer('indices',sizes.indices,'Ray cache: cell-sorted ray indices');
      results=cacheBuffer('results',sizes.results,'Ray cache: per-ray radiance results');
      cacheParams=cacheBuffers.params??=interop.uniform(new Uint8Array(48),'Ray cache parameters');batchRender=render;
    }
    const R=radiusMm??exitRadius(),serial=cacheSerial++;
    const shift=cellShift(seed,serial),angle=rotation??shift.rotation,offset=jitter??shift.jitter;
    const params=new ArrayBuffer(48),pf=new Float32Array(params);
    pf.set([Math.cos(angle),Math.sin(angle),1/(2*R),grid,offset[0],offset[1],CELL_FIXED_PER_MM,R]);
    device.queue.writeBuffer(cacheParams,0,params);
    // Attempts of earlier held batches over the same pixels (same tile and packet groups).
    // Same pixels: the same band (sensor tiles share cursors), else the same tile and cursor.
    const same=h=>band?h.band===band:h.tile===tile&&h.cursor===cursor;
    const traced=held.filter(same).reduce((n,h)=>n+h.spp,0);
    device.queue.writeBuffer(cells,0,initialCellTable());
    // The staged render parameters of this chunk (mirror mode, cursor, packet groups).
    const dispatch=chunkDispatch(groups,device.limits.maxComputeWorkgroupsPerDimension),sceneDispatch=chunkDispatch(groups*4,device.limits.maxComputeWorkgroupsPerDimension);
    const bytes=new ArrayBuffer(192),f=new Float32Array(bytes),u=new Uint32Array(bytes);f.set(pose);
    u.set([dimensions.width,dimensions.height,budget,roundTarget,seed,0,0,tile.y],16);u[27]=tile.halfHeight;u.set([2,cursor,dispatch.x,groups],28);u[32]=sceneDispatch.x;u[33]=traced;if(band?.window){u[34]=band.cols[0];u[35]=band.cols[1]-band.cols[0];}
    device.queue.writeBuffer(batchRender,0,bytes);
    const lensBindings=[uniformBinding(0,optics),uniformBinding(1,surfaces),uniformBinding(2,lut)];
    const p=cacheCore,b=(binding,buffer)=>uniformBinding(binding,buffer);
    const encoder=device.createCommandEncoder({label:'Ray cache batch'});
    const run=(pipeline,entries,grid2,label)=>{const pass=encoder.beginComputePass({label});pass.setPipeline(pipeline);pass.setBindGroup(0,group(pipeline,entries));pass.dispatchWorkgroups(grid2.x,grid2.y);pass.end();};
    if(hold)encoder.clearBuffer(results);
    run(p.raygen,[...lensBindings,b(3,batchRender),b(4,tile.buffer),b(20,pupil),b(21,rayBuffer)],dispatch,'Ray cache lens batch');
    run(p.bin,[b(3,batchRender),b(4,tile.buffer),b(16,cells),b(19,cacheParams),b(21,rayBuffer)],sceneDispatch,'Ray cache binning');
    run(p.scan,[b(16,cells),b(19,cacheParams)],{x:1,y:1},'Ray cache prefix sum');
    run(p.scatter,[b(3,batchRender),b(4,tile.buffer),b(16,cells),b(17,indices),b(19,cacheParams),b(21,rayBuffer)],sceneDispatch,'Ray cache scatter');
    device.queue.submit([encoder.finish()]);
    const started=performance.now();
    const words=new Uint32Array(await interop.readBuffer(cells,CACHE_TABLE_WORDS*4));
    const decoded=decodeCells(words,{n:grid,radiusMm:R}),lobe=decodeLobe(words);
    let resolved=0,finished=false;
    const lensToWorld=([x,y,z])=>{const m=pose,v=[x*.001,y*.001,z*.001];return [0,1,2].map(r=>m[r]*v[0]+m[4+r]*v[1]+m[8+r]*v[2]+m[12+r]);};
    for(const cell of decoded)if(cell.count)cell.originWorld=lensToWorld([cell.centroidMm[0],cell.centroidMm[1],lens.surfaces[0].zMm]);
    const advance=()=>{
      sampleSerial++;groupCursor+=groups;tileGroups=totalGroups;
      if(groupCursor>=totalGroups){groupCursor=0;tileCursor++;if(tileCursor===tiles.length){tileCursor=0;return true;}}
      return false;
    };
    // A held batch moves the frame cursor now; its attempts reach the accumulation in finish().
    let entry=null;
    if(hold){
      if(revision!==currentRevision){for(const buffer of buffers)interop.release(buffer);throw new DOMException('Ray batch invalidated by a reset','AbortError');}
      entry={tile,cursor,spp:budget,render:batchRender,rays:rayBuffer,results,sceneDispatch,buffers,band,completes:band?false:advance(),offset:traced};
      if(entry.completes)heldSpp+=budget;
      if(band)band.held+=budget;
      held.push(entry);
    }else cacheBatch={revision};
    const dispatchCell=(word,first,count,label)=>{
      const view=new Uint32Array([word,first,count,0]);
      const grid2=chunkDispatch(Math.ceil(count/64),device.limits.maxComputeWorkgroupsPerDimension);view[3]=grid2.x;
      device.queue.writeBuffer(cacheParams,32,view);
      const entries=[b(3,batchRender),b(4,tile.buffer),b(17,indices),b(18,results),b(19,cacheParams),b(21,rayBuffer),...provider.bindings(PROVIDER_BINDING_BASE)];
      const encoder=device.createCommandEncoder({label});const pass=encoder.beginComputePass({label:'Ray cache resolve'});
      pass.setPipeline(cacheResolve.pipeline);pass.setBindGroup(0,group(cacheResolve.pipeline,entries));pass.dispatchWorkgroups(grid2.x,grid2.y);pass.end();
      device.queue.submit([encoder.finish()]);
    };
    const batch={
      spp:budget,groups,rays:decoded.reduce((n,c)=>n+c.count,0),grid,radiusMm:R,rotation:angle,jitter:offset,cells:decoded,held:hold,lobe,band:bandIndex,
      /** Cache bytes this batch occupies (its own buffers when held). */
      bytes:sizes.rays+sizes.indices+sizes.results,
      /** Resolve cell k with the provider's current resources (the host's view for this cell). */
      resolve(k){
        if(finished)throw new Error('Ray batch already finished');
        const cell=decoded[k];if(!cell?.count||revision!==currentRevision)return false;
        dispatchCell(k,cell.offset,cell.count,'Ray cache cell '+k);resolved++;return true;
      },
      /** Resolve every ray of the batch in one dispatch (the host has all of its views resident). */
      resolveAll(){
        if(finished)throw new Error('Ray batch already finished');
        if(!batch.rays||revision!==currentRevision)return false;
        dispatchCell(0,0,batch.rays,'Ray cache resolve all');resolved++;return true;
      },
      /** Resolve again the rays of cell k (all cells without k) that are still unresolved:
       * the provider deferred them (SCENE_DEFERRED) until its resources change. */
      retry(k){
        if(finished)throw new Error('Ray batch already finished');
        const range=k===undefined?{offset:0,count:batch.rays}:decoded[k];
        if(!range?.count||revision!==currentRevision)return false;
        dispatchCell((k??0)|CACHE_RETRY_BIT,range.offset,range.count,'Ray cache retry');return true;
      },
      /** Resolve the batch's unsupported rays again (a provider's second chance, e.g. with more of its resources). */
      rescue(){
        if(finished)throw new Error('Ray batch already finished');
        if(!batch.rays||revision!==currentRevision)return false;
        dispatchCell(CACHE_RESCUE_BIT,0,batch.rays,'Ray cache rescue');return true;
      },
      /** Drop the newest held band batch without accumulating it (its pixels keep their
       * earlier attempts, so they are traced again with the same sample keys). */
      discard(){
        if(finished)return false;
        if(!hold||!entry?.band||held.at(-1)!==entry)throw new Error('Only the newest held band batch can be discarded');
        finished=true;held.pop();for(const buffer of buffers)interop.release(buffer);entry.band.held-=budget;
        if(!held.length)for(const t of tiles)if(t.estimate){interop.release(t.estimate);t.estimate=null;}
        return true;
      },
      /** Validation readback: the cell-sorted ray indices and the lens packets (48 B per canonical sample). */
      async readBack(){
        return {capacity,indices:new Uint32Array(await interop.readBuffer(indices,Math.max(4,batch.rays*CACHE_INDEX_BYTES))).subarray(0,batch.rays),
          packets:await interop.readBuffer(rayBuffer,capacity*budget*CACHE_RAY_BYTES)};
      },
      /** Accumulate every attempt of the batch and advance the frame cursor (held
       * batches: in trace order, then their buffers are released). */
      finish(){
        if(finished)return batch.statistics;
        if(revision!==currentRevision){finished=true;if(!hold)cacheBatch=null;return null;}
        if(hold&&held[0]!==entry)throw new Error('Finish held ray batches in trace order');
        finished=true;
        // Earlier batches over these pixels are accumulated now: no attempt offset.
        if(hold)device.queue.writeBuffer(batchRender,33*4,new Uint32Array([0]));
        const encoder=device.createCommandEncoder({label:'Ray cache accumulate'});
        const pass=encoder.beginComputePass({label:'Ray cache accumulate'});
        pass.setPipeline(p.accumulate);pass.setBindGroup(0,group(p.accumulate,[b(0,optics),b(3,batchRender),b(4,tile.buffer),{binding:5,resource:image.gpu.createView()},b(18,results),b(21,rayBuffer)]));
        pass.dispatchWorkgroups(sceneDispatch.x,sceneDispatch.y);pass.end();device.queue.submit([encoder.finish()]);
        if(hold){
          held.shift();for(const buffer of buffers)interop.release(buffer);
          for(const h of held)if(entry.band?h.band===entry.band:h.tile===tile&&h.cursor===entry.cursor){h.offset-=budget;device.queue.writeBuffer(h.render,33*4,new Uint32Array([h.offset]));}
          if(entry.completes){spp+=budget;heldSpp-=budget;}
          if(entry.band){entry.band.held-=budget;entry.band.spp+=budget;spp=Math.min(...bands.map(b=>b.spp));}
          if(!held.length)for(const t of tiles)if(t.estimate){interop.release(t.estimate);t.estimate=null;}
        }else{cacheBatch=null;if(advance())spp+=budget;}
        const used=decoded.filter(c=>c.count),counts=used.map(c=>c.count);
        batch.statistics={spp:budget,groups,rays:batch.rays,renders:resolved,cells:used.length,
          raysPerCell:counts.length?{min:Math.min(...counts),max:Math.max(...counts),mean:batch.rays/counts.length}:null,
          maxParallaxResidualMm:used.length?Math.max(...used.map(c=>c.parallaxResidualMm)):0,binReadbackMs:performance.now()-started};
        return batch.statistics;
      },
    };
    return batch;
  }
  const initializationMs=performance.now()-started;
  const engine={
    get texture(){return image.texture;},get outputGPU(){return image.gpu;},get outputFormat(){return outputFormat;},
    get spp(){return spp;},get dimensions(){return {...dimensions};},get packed(){return packed;},get lens(){return lens;},get tileCount(){return tiles.length;},get roundComplete(){return tileCursor===0&&groupCursor===0;},
    get pupilTable(){return pupilTable;},get provider(){return provider;},get pose(){return Float32Array.from(pose);},
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
    get memoryBytes(){return dimensions.width*dimensions.height*(PIXEL_BYTES+(outputFormat==='rgba32float'?16:8))+[optics,render,resolve,camera,target,surfaces,lut,pupil,work,stagedRays,stagedHits].reduce((sum,buffer)=>sum+(buffer?.size??0),0);},
    async prepareLens(nextLens,state){
      const next=packLens(nextLens,state);
      return pupilPrecomputer.prepare(nextLens,next,{enabled:state?.pupilSampling!==false,bins:state?.pupilBins,movingCenter:state?.pupilMovingCenter});
    },
    reset,resize,resizeChecked,setLens,updateOptics,setPose,bindScene,
    get integrationMode(){return 'staged';},
    get opticalLutReuse(){return opticalLutReuse;},
    /** Swap the radiance provider: compiles its shading stage (and the trace stage for
     * a surface provider) while the old one keeps working, then rebinds and restarts
     * accumulation. Switching kind reallocates the staged scratch (hit records). */
    async setRadianceProvider(next){
      if(next===provider)return;
      if(next.kind==='surface'&&!sceneResources)throw new Error('A surface radiance provider needs scene BVH resources');
      const ready=await compileAll(providerJobs(next));if(disposed)throw new Error('Optical engine disposed');
      const kindChanged=next.kind!==mode;
      provider=next;mode=next.kind;
      pipelines={...Object.fromEntries(Object.entries(pipelines).filter(([name])=>!name.startsWith('staged_')&&name!=='sample'&&name!=='sampleValidation')),...ready};
      stagedPipelines=stagedSet(pipelines);stagedCountingPipelines=null;stagedCountingCompile=null;validationCompile=null;
      if(kindChanged){if(stageTimer){stageTimer.dispose();stageTimer=createStageTimer(interop,stageNames());}install(allocate(dimensions.width));}
      else{rebuildGroups();reset({resetTiming:true});}
    },
    async prepareSampling({mirrorReference=false}={}){
      if(!mirrorReference)return;
      if(!surfaceMode())throw new Error('Mirror validation references need a surface provider');
      validationCompile??=interop.computePipeline(providerSources(provider).sample+validationSource,'Mirror sampling validation');
      const ready=await validationCompile;if(disposed)throw new Error('Optical engine disposed');pipelines.sampleValidation=ready;rebuildGroups();
    },
    get workCounting(){return counting&&Boolean(stagedCountingPipelines);},
    get workSupported(){return workSupported;},
    /** Resolves to 'counting' | 'off' | 'unsupported'. The counting variant compiles once, on first use. */
    async setWorkCounting(on){
      const epoch=++countEpoch;workWindow=0;closedWorkWindow=-1;counting=Boolean(on)&&workSupported;workUnits=0;workTimings.length=0;
      if(!counting)return workSupported?'off':'unsupported';
      if(!stagedCountingPipelines){
        const compiling=provider;
        stagedCountingCompile??=(async()=>{
          const sources=providerSources(compiling,{counting:true}).staged;
          const results=await Promise.allSettled(Object.entries(sources).map(async([name,code])=>[name,await interop.computePipeline(code,'Staged '+name+' + work counters')]));
          const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;
          return Object.fromEntries(results.map(r=>r.value));
        })();
        const ready=await stagedCountingCompile;if(disposed)return 'off';if(compiling!==provider)return engine.setWorkCounting(on);
        stagedCountingPipelines={trace:null,...ready};rebuildGroups();
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
    rayBatch,
    sample({batchSpp=1,targetSpp=64,seed=1,diagnostic='beauty',constantEnvironment=null,pinhole=null,chunked=false,interactive=false,mirrorReuse=true,mirrorReference=false}={}){
      if(cacheBatch||held.length)throw new Error('A ray batch is open');
      if((tileCursor||groupCursor)&&roundMirror===CACHED_ROUND)throw new Error('A cached sampling round is in progress');
      bindScene();
      if(!tiles[0]?.scene)throw new Error('场景 BVH、光照资源或镜头尚未准备');
      // Complete every storage tile before advancing the global spp counter.
      const budget=(tileCursor||groupCursor)?roundBudget:sampleBudget(spp,targetSpp,batchSpp,roundSppLimit);if(!budget)return false;
      if(tileCursor===0&&groupCursor===0){
        const nextMirror=mirrorReuse&&!pinhole?(mirrorReference?4:2):0;
        if(nextMirror!==2&&!surfaceMode())throw new Error('Pinhole, independent and mirror-reference diagnostics need a surface provider');
        roundTarget=targetSpp;roundCounted=workRound++%WORK_SAMPLE_EVERY===0;
        // Paired storage bands own all four destinations, even on GPUs whose
        // buffer binding limit requires many tiles. Freeze for a full sweep.
        roundMirror=nextMirror;
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
      const bytes=new ArrayBuffer(192),f=new Float32Array(bytes),u=new Uint32Array(bytes);f.set(pinhole?.cameraToWorld??pose);
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
    /** Display the accumulation; while held ray batches wait for views, the estimate
     * that includes their resolved rays (ray-cache.js preview). */
    resolve(diagnostic='beauty'){
      if(held.length&&tiles.every(t=>t.resolve))previewHeld();
      for(const tile of tiles){if(!tile.resolve)return;
        device.queue.writeBuffer(resolve,0,new Uint32Array([dimensions.width,dimensions.height,diagnosticIndex(diagnostic)|(tile.halfHeight<<8),tile.y]));
        submit(pipelines.resolve,held.length?group(pipelines.resolve,[uniformBinding(0,resolve),uniformBinding(1,tile.estimate),{binding:2,resource:image.gpu.createView()}]):tile.resolve,Math.ceil(dimensions.width/8),Math.ceil(tile.height/8));
      }
    },
    /** Spp traced so far, including held batches that are not yet accumulated. */
    get tracedSpp(){return bands?Math.min(...bands.map(b=>b.spp+b.held)):spp+heldSpp;},
    /** Sensor bands: setBands([{tile, rows: [r0, r1)}]), then rayBatch({band: index, hold: true}). */
    setBands,
    get bands(){return bands?bands.map(b=>({...b,bytesPerSpp:bandBytesPerSpp(b)})):null;},
    /** Group rows per accumulation tile (8 canonical rows each; a band row also covers its mirrored rows). */
    get bandLayout(){return {blocksX:Math.ceil(Math.ceil(dimensions.width/2)/8),tiles:tiles.map(t=>({rows:Math.ceil(t.halfHeight/8),halfHeight:t.halfHeight,y:t.y}))};},
    /** Held ray batches and the cache bytes they occupy. */
    get held(){return {batches:held.length,bytes:held.reduce((n,h)=>n+h.buffers.reduce((m,buffer)=>m+buffer.size,0),0)};},
    async statistics(){
      if(statsPending)return statsPending;if(!tiles[0]?.scene)return null;const revision=currentRevision;
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
    /** AF: the current lens's reference chief ray against the scene BVH (first opaque surface). */
    async referenceTarget(){
      bindScene();if(!groups.target)throw new Error('场景 BVH 不可用');submit(pipelines.target,groups.target);
      const result=new Float32Array(await interop.readBuffer(target,32));
      const status=Math.round(result[3]),layers=Math.round(result[5]);
      if(status===5)return {infinity:true,status,transparentLayers:layers};
      if(status===8)throw new Error(`准星 BVH 遍历错误（代码 ${Math.round(result[6])}），未修改焦点`);
      if(status===9)throw new Error('准星穿过的透明层超过上限，未修改焦点');
      if(status!==4)throw new Error('参考主光线无法通过当前镜头');
      const world=Array.from(result.slice(0,3)),local=inverseAffinePoint(pose,world).map(v=>v*1000);
      return {world,local,distanceM:-local[2]*.001,hitDistanceM:result[4],transparentLayers:layers,status};
    },
    readAccumulation,
    /** Linear float HDR of the accumulation (mean per attempted path), row order with
     * the top row first: space 'linear-srgb' (RGBA32F, A = 1) or 'xyz' (XYZ + attempted
     * paths in A). Unlike the output texture it is neither clamped nor half-float. */
    async readHDR({space='linear-srgb'}={}){
      if(space!=='linear-srgb'&&space!=='xyz')throw new RangeError('readHDR space must be linear-srgb or xyz');
      const raw=await readAccumulation(),f=new Float32Array(raw),u=new Uint32Array(raw),{width,height}=dimensions;
      const data=new Float32Array(width*height*4),stride=PIXEL_BYTES/4;
      for(let i=0;i<width*height;i++){
        const n=u[i*stride+3],k=1/Math.max(1,n),xyz=[f[i*stride]*k,f[i*stride+1]*k,f[i*stride+2]*k];
        const out=space==='xyz'?xyz:xyzToRGB(xyz);
        data[i*4]=out[0];data[i*4+1]=out[1];data[i*4+2]=out[2];data[i*4+3]=space==='xyz'?n:1;
      }
      return {width,height,space,spp,data};
    },
    /** readHDR for image rows [y, y + rows) only: reads just those rows of the accumulation
     * bands (no whole-frame copy), for streaming exports of large images. */
    async readHDRRows({y=0,rows,space='linear-srgb'}={}){
      if(space!=='linear-srgb'&&space!=='xyz')throw new RangeError('readHDR space must be linear-srgb or xyz');
      const {width,height}=dimensions,rowBytes=width*PIXEL_BYTES,stride=PIXEL_BYTES/4;
      if(!(Number.isInteger(y)&&Number.isInteger(rows)&&y>=0&&rows>0&&y+rows<=height))throw new RangeError('readHDRRows: rows outside the image');
      const data=new Float32Array(width*rows*4);
      for(let Y=y;Y<y+rows;){
        // Top half of a band: buffer row Y - tile.y; bottom half: rows count down from the band's end.
        let seg=null;
        for(const tile of tiles){
          if(Y>=tile.y&&Y<tile.y+tile.halfHeight){seg={tile,first:Y-tile.y,n:Math.min(y+rows,tile.y+tile.halfHeight)-Y,reverse:false};break;}
          const m=height-1-Y;
          if(m>=tile.y&&m<tile.y+tile.halfHeight){const n=Math.min(y+rows-Y,m-tile.y+1);seg={tile,first:tile.halfHeight+(m-tile.y)-(n-1),n,reverse:true};break;}
        }
        if(!seg)throw new Error('readHDRRows: row outside the accumulation bands');
        const raw=await interop.readBuffer(seg.tile.buffer,seg.n*rowBytes,seg.first*rowBytes),f=new Float32Array(raw),u=new Uint32Array(raw);
        for(let i=0;i<seg.n;i++){
          const src=(seg.reverse?seg.n-1-i:i)*width,dst=(Y+i-y)*width;
          for(let x=0;x<width;x++){
            const j=(src+x)*stride,n=u[j+3],k=1/Math.max(1,n),xyz=[f[j]*k,f[j+1]*k,f[j+2]*k],out=space==='xyz'?xyz:xyzToRGB(xyz),o=(dst+x)*4;
            data[o]=out[0];data[o+1]=out[1];data[o+2]=out[2];data[o+3]=space==='xyz'?n:1;
          }
        }
        Y+=seg.n;
      }
      return {width,height,y,rows,space,spp,data};
    },
    dispose(){disposed=true;releaseHeld();pupilPrecomputer.dispose();timer.dispose();stageTimer?.dispose();for(const b of [optics,render,resolve,camera,target,surfaces,lut,pupil,work,stagedRays,stagedHits,...tiles.map(t=>t.buffer),...Object.values(cacheBuffers??{})])if(b)interop.release(b);image?.dispose();},
  };
  return engine;
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
