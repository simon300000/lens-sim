import {preferredOpticalLutReuse} from './optical-lut-policy.js';
import * as THREE from 'three/webgpu';
import { texture, screenUV, uniform, vec2, vec4, step, mix } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { createThreeInterop, cameraPose } from './three-interop.js';
import { DIAGNOSTIC_MODES, ACCUMULATING_DIAGNOSTICS } from './optical-engine.js';
import { createLensTracer } from '../lens-tracer.js';
import { createSceneBVH } from './scene-bvh.js';
import { createGardenProvider } from './garden-provider.js';
import { createLensLibrary } from '../optics/lens-library.js';
import { createSceneResources } from './scene-resources.js';
import { createLightingResources, STAR_ANGULAR_RADIUS } from './lighting-resources.js';
import { hasSamplesRemaining, MAX_IMAGE_WIDTH } from './sampling-plan.js';
import { createControlStore } from './control-store.js';
import { normalizeRasterQuality } from './raster-quality.js';
import { apertureLimits, rearSamplingRegion } from '../optics/lens-state.js';
import { displayOutputNode } from '../hdr-output.js';
import { exportLensTexture, captureCanvas } from './image-export.js';
import { summarizeWork } from './work-model.js';
import { createCompletionClock } from './adaptive-chunks.js';
import { loadGlassCatalog, inspectRecord, customLensId, CUSTOM_BRAND } from '../optics/lens-workbench.js';

/** Small, clone-friendly description of the active prescription for the layout view and table. */
function slimPrescription(lens,{stopRadiusMm,sensorZMm,focusDistanceM}){
  return {id:lens.id,name:lens.name,configurationTitle:lens.configurationTitle,stopIndex:lens.stopIndex,stopRadiusMm,sensorZMm,
    lastVertexZMm:lens.lastVertexZMm,objectDistanceMm:lens.objectDistanceMm,focusDistanceM,sensorMm:lens.sensorMm,glasses:lens.glasses,
    surfaces:lens.surfaces.map(s=>({index:s.index,zMm:s.zMm,radiusMm:s.radiusMm,thicknessMm:s.thicknessMm,conic:s.conic,aspheric:s.aspheric,
      xodd:s.xodd??null,doe:s.doe??null,apertureRadiusMm:s.apertureRadiusMm,drawRadiusMm:s.drawRadiusMm,mediumBefore:s.mediumBefore,
      mediumAfter:s.mediumAfter,material:s.material,type:s.type}))};
}

function catalogueFocalLengthMm(lens){
  // Zooms use their short end; prefer the published focal length over small
  // differences in the paraxial model between nominally identical lenses.
  const nominal=Number.parseFloat(lens.spec?.focal)||Number(lens.name?.match(/(\d+(?:\.\d+)?)\s*(?:[-–—]\s*\d+(?:\.\d+)?)?\s*mm(?:\b|_)/i)?.[1]);
  if(Number.isFinite(nominal)&&nominal>0)return nominal;
  return Math.abs(lens.configurations?.find(c=>Number.isFinite(c.initial?.focalLengthMm))?.initial.focalLengthMm)||null;
}

/** Scheduling and state boundary for the geometry-first-hit lens renderer.
 * Revisions and what they invalidate:
 *   geometry  (topology/transform/material edits) -> BVH refresh (minimal) + accumulation
 *   lighting  (time of day)  -> raster shadow/PMREM refresh + light uniform + material table + accumulation
 *   camera    (pose)         -> reflector refresh + pose + accumulation; never the BVH
 *   optics    (lens/stop/focus) -> optics buffer + accumulation; never BVH or shadows
 *   display   (exposure/bloom/output) -> display only
 */
export async function createHybridRuntime({renderer,scene,camera,adapterInfo,rasterPipeline,rasterBeauty,rasterGlare,refreshContext,reflectionPixelRatio,cameraExposure,hdr,environment,requestFrame,onOutputState=()=>{},onRasterQuality=()=>{},initialState={},useWorker=true,maxSamplesInFlight=2,lensBaseUrl='/lenses/'}) {
  if(!Number.isInteger(maxSamplesInFlight)||maxSamplesInFlight<1||maxSamplesInFlight>2)throw new RangeError('Samples in flight must be 1 or 2');
  // The garden is one host of the embeddable lens tracer (lens-tracer.js): three
  // supplies the device and lighting resources, the scene producer feeds the
  // tracer's BVH, and the garden PBR port is its radiance provider.
  const store=createControlStore(initialState),interop=createThreeInterop(renderer),library=createLensLibrary({baseUrl:lensBaseUrl});
  const bvh=createSceneBVH({interop,worker:useWorker?undefined:false});
  const sceneResources=createSceneResources({interop,scene,camera,starAngularRadius:STAR_ANGULAR_RADIUS,bvh});
  const lighting=createLightingResources({interop,renderer,scene,camera,environment,refreshContext,reflectionPixelRatio});
  const garden=createGardenProvider({lighting,materials:sceneResources});
  let tracer=null,lens=null,baseLens=null,baseAsset=null,manifest=null,engine=null,baseExposure=cameraExposure.value,interacting=false,pointerActive=false,releaseTimer;
  let disposed=false,commandRevision=0,lensLoadRevision=0,statisticsRevision=0,lastStatisticsSerial=-1,statisticsBusy=false,lastError=null;
  let displayPipeline=null,imageNode=null,bloomNode=null,lightingDirty=true,sceneBuild=null;
  const viewportAspect=uniform(innerWidth/innerHeight),rawDisplay=uniform(0);
  let diagnosticDirty=false,samplesInFlight=0,rasterCameraDirty=false;
  // Imported or edited prescriptions live only in this page session.
  const customAssets=new Map();
  // Work counting runs only while the diagnostics HUD asks for it.
  let workCounting=false,workBusy=false,lastWorkAt=-Infinity;
  function publishPrescription(){
    if(!lens||!engine?.packed)return;
    update({prescription:slimPrescription(lens,{stopRadiusMm:engine.packed.stopRadiusMm,sensorZMm:engine.packed.sensorZMm,focusDistanceM:state().optics.focusDistanceM})});
  }
  const completionClock=createCompletionClock();
  let inputUntil=0,lastDisplayAt=-Infinity,lastPublishAt=-Infinity,lastStatisticsAt=-Infinity,lastDisplayRevision='';
  // All page input counts, including hovering/scrolling the controls. This is
  // scheduling only: it must not resize the image or invalidate accumulated rays.
  const inputEvents=['click','pointermove','pointerdown','pointerup','wheel','keydown','keyup','input','touchmove','focusin'];
  const inputOptions={capture:true,passive:true};
  const noteInput=event=>{if(event.isTrusted){inputUntil=performance.now()+1000;}};
  for(const type of inputEvents)document.addEventListener(type,noteInput,inputOptions);
  // Message tasks yield to page input without a RAF-sized gap after every tiny
  // compute dispatch. Presentation remains throttled independently below.
  const chunkTasks=new MessageChannel();
  chunkTasks.port1.onmessage=()=>{if(runtime.needsFrame())runtime.frame();};
  const isInteractive=()=>interacting||performance.now()<inputUntil;
  // Input immediately stops replenishing the second queued chunk. Already
  // submitted GPU work drains normally; it cannot be cancelled.
  const flightLimit=()=>isInteractive()?1:maxSamplesInFlight;
  const update=patch=>store.update(patch);
  const state=()=>store.peekState();
  function cancelFocus(){commandRevision++;const af=state().af;if(af.status==='busy')update({af:{...af,status:'idle',message:'参数改变，已取消过期对焦'}});}
  function clearMetrics(){lastStatisticsAt=-Infinity;const d=state().diagnostics;update({diagnostics:{...d,attemptedSamples:0,numericalErrorRate:0,opticalBlockedRate:0,tirRate:0,hitRate:0,backgroundRate:0,
    opticalPassRate:0,bvhErrorRate:0,unsupportedRate:0,transparencyLimitRate:0,radianceInvalidRate:0,reflectionOutsideRate:0,sceneHitOfPassed:0,backgroundOfPassed:0}});diagnosticDirty=true;}
  function revision(kind){const revisions={...state().revisions};revisions[kind]=(revisions[kind]??0)+1;if(kind!=='display'&&kind!=='accumulation')revisions.accumulation++;update({revisions});}
  function sceneSummary(){
    const s=sceneResources.stats;if(!s)return null;
    return {instances:s.instances,uniqueTriangles:s.triangles,expandedTriangles:s.report.expandedTriangles,meshes:s.report.meshes,blas:s.report.blas,
      materials:s.report.materials,bvhNodes:s.nodes,tlasNodes:s.tlasNodes,blasNodes:s.blasNodes,tlasDepth:s.tlasDepth,maxBlasDepth:s.maxBlasDepth,
      gpuBytes:s.gpuBytes,buildWallMs:s.buildWallMs,extractMs:s.extractMs,uploadSubmitMs:s.uploadSubmitMs,timing:s.timing,worker:s.worker,
      environmentObjects:s.report.environment.length,unsupported:s.report.unsupported,counters:sceneResources.counters,reason:s.reason};
  }
  const memoryBytes=()=>engine.memoryBytes+(sceneResources.stats?.gpuBytes??0)+1008;
  function publishEngine(){
    if(!engine)return;const s=state();
    const ls=lighting.status;
    update({sampling:{...s.sampling,spp:engine.spp},diagnostics:{...s.diagnostics,pipelineCompilations:interop.compilations,
      integrationMode:engine.lastSubmission?.integrationMode??engine.integrationMode,computeMs:engine.computeMs,lightingRefreshMs:lighting.refreshMs,lightingRefreshes:lighting.refreshes,
      timingSource:{gpu:'GPU timestamp（单个采样分块：镜头+BVH+着色）',queue:'队列完成间隔估算（单个采样分块，含同队列显示工作）',wall:'无 timestamp：墙钟近似'}[engine.timingSource]+' / CPU 提交耗时（光栅资源刷新）',
      ...engine.dimensions,memoryBytes:memoryBytes()},
      scene:{...s.scene,...(sceneSummary()?{summary:sceneSummary()}:{}),lighting:{ok:ls.ok,errors:ls.errors??[],warnings:ls.warnings??[],lights:ls.lights,environment:ls.environment,reflection:ls.reflection}}});
  }
  function resetAccumulation(kind='accumulation'){cancelFocus();engine?.reset();clearMetrics();statisticsRevision++;lastStatisticsSerial=-1;revision(kind);publishEngine();requestFrame();}
  function minimumImageDistance(prescription){
    let lo=0,hi=Math.max(1,prescription.imageDistanceMm);
    const valid=gap=>{try{rearSamplingRegion(prescription,prescription.lastVertexZMm+gap);return true;}catch{return false;}};
    if(valid(0))return 0;
    while(!valid(hi)&&hi<2000)hi*=2;
    if(!valid(hi))throw new Error('无法确定像面调节范围');
    for(let i=0;i<20;i++){const mid=(lo+hi)/2;if(valid(mid))hi=mid;else lo=mid;}
    return hi+.001;
  }
  function bindImage(){if(imageNode)imageNode.value=engine.texture;}
  function displayGraph(){
    if(!engine)return;
    if(!displayPipeline){
      displayPipeline=new THREE.RenderPipeline(renderer);
      // The fixed 36:24 sensor is fitted in the viewport with letterboxing,
      // never stretched or silently cropped.
      const scale=vec2(viewportAspect.div(1.5).max(1),viewportAspect.div(1.5).reciprocal().max(1));
      const sensorUV=screenUV.sub(.5).mul(scale).add(.5);
      imageNode=texture(engine.texture,sensorUV);
      const mask=step(0,sensorUV.x).mul(step(sensorUV.x,1)).mul(step(0,sensorUV.y)).mul(step(sensorUV.y,1));
      const framed=mix(vec4(.008,.009,.008,1),imageNode,mask);
      bloomNode=bloom(framed.mul(cameraExposure),.1,.25,1.8);
      displayPipeline.userData={framed};
    }
    const s=state();bloomNode.strength.value=s.display.bloom&&s.display.diagnostic==='beauty'?.1:0;
    const framed=displayPipeline.userData.framed;
    const linear=vec4(framed.rgb.add(bloomNode.rgb.div(cameraExposure)),1);
    // Diagnostic maps are displayed unexposed (values are rates/normals/IDs).
    displayPipeline.outputNode=mix(displayOutputNode(linear,cameraExposure,hdr.supported&&s.display.output==='auto'),vec4(framed.rgb.clamp(0,1),1),rawDisplay);
  }
  function displayChanged({rebuild=false,resolve=false}={}){
    revision('display');cameraExposure.value=baseExposure*2**state().display.exposureEV;
    const diagnostic=state().display.diagnostic;rawDisplay.value=diagnostic==='beauty'?0:1;
    if(rebuild)displayGraph();else if(bloomNode)bloomNode.strength.value=state().display.bloom&&diagnostic==='beauty'?.1:0;
    diagnosticDirty ||= resolve;
    const actualOutput=hdr.supported&&state().display.output==='auto'?'hdr':'sdr-tone-mapped';
    if(rasterGlare)rasterGlare.strength.value=state().display.bloom?.1:0;
    if(rebuild&&rasterBeauty&&rasterGlare)rasterPipeline.outputNode=displayOutputNode(vec4(rasterBeauty.rgb.add(rasterGlare.rgb.div(cameraExposure)),1),cameraExposure,actualOutput==='hdr');
    update({display:{...state().display,actualOutput}});onOutputState(actualOutput);requestFrame();
  }
  /** Raster-generated lighting resources that the lens kernel reads. Runs only
   * when time/lighting or the camera changed, never per sample batch. */
  function ensureLighting(){
    if(!lightingDirty)return;
    lightingDirty=false;
    lighting.refresh();tracer?.setPose(cameraPose(camera));
    const ls=lighting.status;
    if(!ls.ok)throw new Error('光栅光照资源不可用：'+ls.errors.join('；'));
    publishEngine();
  }
  function applyOpticalChange(patch){
    const candidate={...state().optics,...patch};
    // Validate and upload before committing the UI snapshot. A rejected change
    // leaves the previous optics and focus state intact.
    tracer.updateOptics({fNumber:candidate.fNumber,sensorZMm:lens.lastVertexZMm+candidate.imageDistanceMm,dispersion:candidate.dispersion});
    cancelFocus();update({optics:candidate});clearMetrics();statisticsRevision++;lastStatisticsSerial=-1;revision('optics');publishPrescription();publishEngine();requestFrame();
  }
  async function loadLens(id,index=0){
    const custom=customAssets.get(id),entry=custom?null:manifest.lenses.find(item=>item.id===id);
    if(!custom&&!entry?.supported)throw new Error(entry?.reason||'镜头不可用');
    cancelFocus();const token=++lensLoadRevision,old=state();
    update({status:'loading',error:null});
    try{
      let nextAsset=custom;
      nextAsset??=await library.asset(id);
      if(token!==lensLoadRevision)return;
      const next=nextAsset.configurations[index];if(!next)throw new Error(nextAsset.configurationStatus[index]?.reason||'配置不可用');
      const limits=apertureLimits(next);
      const focusDistanceM=next.objectDistanceMm===null?null:next.objectDistanceMm/1000;
      const sensorZMm=next.sensorZMm,fNumber=limits.minFNumber;
      const minimumGap=minimumImageDistance(next);
      const packed=await tracer.setLens(next,{fNumber,sensorZMm,dispersion:old.optics.dispersion},{stale:()=>token!==lensLoadRevision||disposed});
      if(!packed)return;
      lens=next;baseLens=next;baseAsset=nextAsset;statisticsRevision++;
      update({status:'ready',error:null,lensId:id,configurationIndex:index,configurations:nextAsset.configurationStatus.map(c=>({...c,available:c.supported})),
        warnings:[...(next.capabilityWarnings??[]),...next.warnings.filter(w=>/^(通光数据不完整|含 nd\/vd|DOE 按|380–780)/.test(w)),
          next.surfaces[next.stopIndex].apertureRadiusMm===null?`光阑半径由上游 ${next.apertureMode} 孔径参数与入瞳倍率标定，未采用绘图半径。`:'',
          packed.region.unknownAperture?'后面通光未知：使用明确的有限求交域，不能据此声称完整渐晕。':'',
          '经验渐晕仅存为元数据；当前只计算有依据的几何遮挡。'].filter(Boolean),
        limits:{fNumber:[limits.minFNumber,limits.maxFNumber],imageDistanceMm:[Math.min(minimumGap,next.imageDistanceMm),Math.max(200,Math.abs(limits.focalLengthMm)*4)]},
        optics:{...old.optics,fNumber,focusDistanceM,focusDistanceKnown:true,imageDistanceMm:sensorZMm-next.lastVertexZMm,focalLengthMm:limits.focalLengthMm,
          focusModel:next.focusMotion?`镜组移动 · ${next.focusMotion.source}`:'固定镜组 · 传感器轴向调焦'},
        af:{...old.af,status:'idle',message:custom?'导入/编辑的处方：原始像面与物距；可使用 AF-S 调焦':'上游原始像面与物距；可使用 AF-S 对当前目标调焦'}});
      clearMetrics();revision('optics');bindImage();publishPrescription();publishEngine();requestFrame();
    }catch(error){if(token!==lensLoadRevision||disposed)return;update({status:lens?'ready':'error',error:error.message});throw error;}
  }
  async function focusAt(distanceM,autofocus=false){
    const token=++commandRevision,revisions=state().revisions;
    const old=state();update({af:{...old.af,status:'busy',message:autofocus?'沿实际参考主光线求取真实场景交点':baseLens.focusMotion?'搜索镜组最佳对焦位置':'搜索最佳像面'}});
    try{
      let hit=null;
      if(autofocus){
        if(!sceneResources.ready)throw new Error('场景 BVH 尚未就绪');
        tracer.setPose(cameraPose(camera));hit=await tracer.referenceTarget();distanceM=hit.infinity?null:hit.distanceM;
      }
      if(token!==commandRevision)return;
      const stale=()=>disposed||token!==commandRevision||revisions.geometry!==state().revisions.geometry||revisions.optics!==state().revisions.optics||revisions.camera!==state().revisions.camera;
      // The tracer's focus search keeps the physical stop radius and prepares the
      // pupil table on its Worker before swapping the lens.
      const moved=await tracer.focus(distanceM,{stale});
      if(!moved)return;
      const next=moved.lens,limits=moved.limits,fNumber=moved.fNumber;
      const minimumGap=minimumImageDistance(next);
      lens=next;cancelFocus();
      const label=moved.method==='table'?'对焦表':moved.method==='cam-search'?'镜组 RMS 搜索':'像面 RMS 搜索';
      const rms=v=>Number.isFinite(v)?`${(v*1000).toFixed(2)} µm`:'无有效光斑';
      update({optics:{...state().optics,fNumber,focusDistanceM:moved.focusDistanceM,focusDistanceKnown:true,
        imageDistanceMm:next.imageDistanceMm,focalLengthMm:limits.focalLengthMm,focusModel:`lens-bench · ${label}`},
        limits:{fNumber:[limits.minFNumber,limits.maxFNumber],imageDistanceMm:[Math.min(minimumGap,next.imageDistanceMm),Math.max(200,Math.abs(limits.focalLengthMm)*4)]},
        af:{...state().af,status:'success',message:`${label} · 轴上 RMS ${rms(moved.beforeRmsMm)} → ${rms(moved.afterRmsMm)}${moved.clamped?' · 已限制到资料最近对焦距离':''}${moved.extrapolated?' · 超出资料行程，沿末段外推':''}`,
          lastResult:{source:baseLens.focusMotion?.source??'lens-bench planeFocus',method:moved.method,focusDistanceM:moved.focusDistanceM,sensorZMm:next.sensorZMm,
            beforeRmsMm:moved.beforeRmsMm,afterRmsMm:moved.afterRmsMm,evaluations:moved.evaluations,solveMs:moved.solveMs,
            extrapolated:moved.extrapolated,clamped:moved.clamped,target:hit}}});
      clearMetrics();statisticsRevision++;lastStatisticsSerial=-1;revision('optics');publishPrescription();publishEngine();requestFrame();
    }catch(error){if(token===commandRevision){update({af:{...state().af,status:'error',message:error.message}});}throw error;}
  }
  /** Time of day / light change: shadows and PMREM already rerendered by the
   * daylight update; mark the lens bridge stale and repack material emission. */
  function lightingChanged(){
    if(disposed)return;lightingDirty=true;
    if(sceneResources.ready)sceneResources.writeTables();
    if(state().af.status==='busy')update({af:{...state().af,status:'idle',message:'光照改变，已丢弃过期对焦'}});
    resetAccumulation('lighting');
  }
  /** Geometry, transform, visibility or material edits of registered objects. */
  function sceneChanged(){
    if(disposed||!sceneResources.ready)return Promise.resolve(null);
    update({scene:{...state().scene,status:'building',message:'检测并更新场景数据'}});
    sceneBuild=sceneResources.refresh().then(result=>{
      if(disposed)return result;
      if(result){revision(result.reason==='material'?'material':'geometry');engine?.reset();clearMetrics();statisticsRevision++;}
      update({scene:{...state().scene,status:'ready',message:result?`已更新（${result.reason}）`:'无变化'}});publishEngine();requestFrame();return result;
    },error=>{update({scene:{...state().scene,status:'error',message:error.message}});throw error;}).finally(()=>{sceneBuild=null;});
    return sceneBuild;
  }
  function cameraChanged(){
    if(disposed)return;lightingDirty=true;
    // Raster navigation does not consume the optical image. Clear it once and
    // retain the latest pose via lightingDirty, without rebuilding UI snapshots
    // and resetting optical buffers for every damping/keyboard frame.
    // The optical image is reset once, when lens mode next displays it
    // (setMode): resetting it on the first move published a store snapshot
    // and rebuilt the lens panel DOM inside the first navigation frame.
    if(state().mode==='raster'){
      cancelFocus();rasterCameraDirty=true;
      if(interacting&&!pointerActive)scheduleRelease();
      return;
    }
    resetAccumulation('camera');
    if(interacting&&!pointerActive)scheduleRelease();
  }
  /** HUD-driven arithmetic estimate. The counting integrator variant compiles on first use. */
  async function setWorkCounting(on){
    workCounting=on;lastWorkAt=-Infinity;
    const setWork=work=>update({diagnostics:{...state().diagnostics,work}});
    if(!engine){setWork(on?{status:'pending'}:null);return on?'pending':'off';}
    if(on&&!engine.workSupported){setWork({status:'unsupported'});return 'unsupported';}
    if(on&&!engine.workCounting)setWork({status:'compiling'});
    const status=await engine.setWorkCounting(on);
    if(!on||workCounting!==on)setWork(workCounting?state().diagnostics.work:null);
    requestFrame();return status;
  }
  /** Adapt + preflight an imported/edited lens-bench record in the browser, then load it like bundled data. */
  async function loadCustomLens({record,configurationIndex=0}={}){
    if(!record||typeof record.tx!=='string')throw new Error('缺少镜头处方');
    const catalog=await loadGlassCatalog(undefined,library.glassCatalogUrl());
    const asset=inspectRecord(record,catalog);
    const usable=asset.configurationStatus.filter(c=>c.supported);
    if(!usable.length)throw new Error(asset.configurationStatus[0]?.reason||'处方未通过预检');
    const index=asset.configurations[configurationIndex]?configurationIndex:usable[0].index;
    const id=customLensId(record);
    customAssets.set(id,asset);
    const focal=Math.abs(asset.configurations[index].capability?.initial?.focalLengthMm)||null;
    const entry={id,name:record.name||id,brand:CUSTOM_BRAND,available:true,reason:null,custom:true,validation:'browser-preflight',
      surfaceCount:asset.configurations[index].surfaces.length,focalLengthMm:focal};
    update({lenses:[...state().lenses.filter(l=>l.id!==id),entry]});
    await loadLens(id,index);
    return {id,configurationIndex:index,warnings:asset.configurationStatus[index].warnings};
  }
  /** PNG of the current picture: the accumulated sensor image in lens mode, the displayed canvas in raster mode. */
  async function exportImage(){
    const s=state(),stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\..*/,'').replace('T','-');
    const safe=v=>String(v).replace(/[^\w.-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60);
    if(s.mode==='raster'||!engine){
      rasterPipeline.render();
      const blob=await captureCanvas(renderer.domElement);
      return {blob,fileName:`lens-sim_raster_${stamp}.png`,width:renderer.domElement.width,height:renderer.domElement.height,kind:'raster'};
    }
    if(s.status!=='ready')throw new Error('镜头图像尚未就绪');
    const {width,height}=engine.dimensions;
    if(!(engine.spp>0))throw new Error('还没有累计任何样本');
    await interop.device.queue.onSubmittedWorkDone();
    const raw=s.display.diagnostic!=='beauty';
    const blob=await exportLensTexture({interop,texture:engine.outputGPU,width,height,exposure:cameraExposure.value,raw});
    const lensName=s.lenses.find(l=>l.id===s.lensId)?.name??s.lensId;
    const fileName=`lens-sim_${safe(lensName)}_f${Number(s.optics.fNumber.toFixed(2))}_${engine.spp}spp${raw?`_${s.display.diagnostic}`:''}_${stamp}.png`;
    return {blob,fileName,width,height,spp:engine.spp,kind:raw?'diagnostic':'lens'};
  }
  store.setHandler(async({type,value})=>{
    const s=state();
    if(type==='exportImage')return exportImage();
    if(type==='setWorkCounting')return setWorkCounting(Boolean(value));
    // Read-only: the editable source record of the active lens (kept out of per-frame snapshots).
    if(type==='getLensRecord')return baseAsset?.record?structuredClone(baseAsset.record):null;
    const recovery=type==='setMode'||type==='setPaused'||type==='loadCustomLens'||(engine&&['selectLens','selectConfiguration'].includes(type));
    if(s.status!=='ready'&&!recovery)throw new Error('镜头后端尚未就绪');
    const finite=(min,max)=>{if(!Number.isFinite(value)||value<min||value>max)throw new Error(`参数范围 ${min}–${max}`);return value;};
    switch(type){
      case 'setMode':{
        if(!['raster','lens'].includes(value))throw new Error('无效视图');
        const moved=rasterCameraDirty;rasterCameraDirty=false;update({mode:value});
        // Raster navigation deferred the camera reset of the accumulated image.
        // Raster drew over the canvas: present the lens image again even when
        // sampling is finished or paused and no new chunk will be submitted.
        if(value==='lens'){lightingDirty=true;lastDisplayRevision='';if(moved)resetAccumulation('camera');}
        requestFrame();break;
      }
      // Raster preview quality (mode A). The application owns the raster passes and applies it.
      case 'setRasterQuality':{const raster=normalizeRasterQuality(value,s.raster);update({raster});onRasterQuality(raster);requestFrame();break;}
      case 'selectLens':await loadLens(value);break;
      case 'selectConfiguration':await loadLens(s.lensId,value);break;
      case 'loadCustomLens':if(!engine)throw new Error('镜头后端尚未就绪');return loadCustomLens(value);
      case 'setFNumber':finite(...s.limits.fNumber);applyOpticalChange({fNumber:value});break;
      case 'setFocusDistance':if(value!==null)finite(.1,10000);await focusAt(value);break;
      case 'setImageDistance':finite(...s.limits.imageDistanceMm);applyOpticalChange({imageDistanceMm:value,focusDistanceKnown:false});update({af:{...state().af,status:'idle',message:'手动微调像面；所示物距为上次指令，未重新标定'}});break;
      case 'autofocus':await focusAt(null,true);break;
      case 'setAutoFocusOnRelease':update({af:{...s.af,autoOnRelease:Boolean(value)}});break;
      case 'setDispersion':applyOpticalChange({dispersion:Boolean(value)});break;
      case 'setTargetSpp':finite(0,4096);if(!Number.isInteger(value))throw new Error('spp 必须为整数');update({sampling:{...s.sampling,targetSpp:value}});requestFrame();break;
      case 'setResolution':finite(240,MAX_IMAGE_WIDTH);await engine.resizeChecked(interacting?240:value);update({sampling:{...state().sampling,resolution:value}});bindImage();resetAccumulation();break;
      case 'setPaused':update({sampling:{...s.sampling,paused:Boolean(value)}});requestFrame();break;
      case 'reset':resetAccumulation();break;
      case 'setExposureEV':finite(-15,15);update({display:{...s.display,exposureEV:value}});displayChanged();break;
      case 'setBloom':update({display:{...s.display,bloom:Boolean(value)}});displayChanged();break;
      case 'setDiagnostic':{
        if(!(value in DIAGNOSTIC_MODES))throw new Error('无效诊断视图');
        const accumulating=d=>ACCUMULATING_DIAGNOSTICS.includes(d),changesSamples=accumulating(value)||accumulating(s.display.diagnostic);
        update({display:{...s.display,diagnostic:value}});displayChanged({resolve:true});
        // Geometry/normal/material maps accumulate different per-path values;
        // switching to or from them restarts the same random sequence.
        if(changesSamples&&value!==s.display.diagnostic)resetAccumulation();break;
      }
      case 'setOutput':if(!['auto','sdr'].includes(value))throw new Error('无效输出模式');update({display:{...s.display,output:value}});displayChanged({rebuild:true});break;
      case 'rebuildScene':await sceneChanged();break;
      default:throw new Error('未知控制命令: '+type);
    }
  });
  function scheduleRelease(){
    clearTimeout(releaseTimer);releaseTimer=setTimeout(async()=>{
      interacting=false;
      try{if(state().mode==='lens'&&engine&&await engine.resizeChecked(state().sampling.resolution)){bindImage();resetAccumulation();}}
      catch(error){if(!disposed)update({sampling:{...state().sampling,resolution:engine.dimensions.width},error:error.message});}
      if(disposed)return;
      if(state().af.autoOnRelease&&state().status==='ready')focusAt(null,true).catch(()=>{});requestFrame();
    },240);
  }
  const runtime={
    store,interop,sceneResources,lighting,garden,library,get engine(){return engine;},get tracer(){return tracer;},
    lightingChanged,sceneChanged,cameraChanged,
    /** Back-compatible full invalidation: lighting + registered scene data. */
    invalidateScene(){lightingChanged();return sceneChanged();},
    setBaseExposure(exposure){baseExposure=exposure;cameraExposure.value=exposure*2**state().display.exposureEV;},
    resize(){viewportAspect.value=innerWidth/innerHeight;lightingDirty=true;},
    setInteracting(value){
      clearTimeout(releaseTimer);
      pointerActive=value;
      if(value){interacting=true;if(state().mode==='lens'&&engine?.resize(240)){bindImage();resetAccumulation();}}
      else scheduleRelease();
    },
    /** Cheap numbers for the performance HUD, read directly (no store update or snapshot cloning). */
    liveStats(){
      if(!engine)return null;const s=state();
      const timing=engine.lastTiming;
      return {mode:s.mode,paused:s.sampling.paused,interactive:isInteractive(),finished:s.sampling.targetSpp>0&&engine.spp>=s.sampling.targetSpp,
        spp:engine.progress,computeMs:engine.computeMs,chunkPixels:timing?.chunkPixels??null,chunkSpp:timing?.chunkSpp??null,lightingRefreshMs:lighting.refreshMs,...engine.dimensions,memoryBytes:memoryBytes()};
    },
    needsFrame(){const s=state();return !disposed&&samplesInFlight<flightLimit()&&!document.hidden&&s.mode==='lens'&&s.status==='ready'&&sceneResources.ready&&!s.sampling.paused&&s.af.status!=='busy'&&hasSamplesRemaining(engine.spp,s.sampling.targetSpp);},
    frame(){
      const s=state();if(s.mode==='raster'){rasterPipeline.render();return;}
      // Never display raster as successful lens output.
      if(!engine||s.status!=='ready'||!sceneResources.ready)return;
      try{
        ensureLighting();
        if(diagnosticDirty){engine.resolve(s.display.diagnostic);diagnosticDirty=false;}
        const now=performance.now(),interactive=interacting||now<inputUntil;
        // Idle: larger chunks, up to four samples per pixel and two submissions
        // in flight. Input: small chunks and a single outstanding submission.
        const submitted=samplesInFlight<flightLimit()&&!s.sampling.paused&&!document.hidden&&s.af.status!=='busy'&&engine.sample({batchSpp:interactive?1:s.sampling.batchSpp,targetSpp:s.sampling.targetSpp,seed:s.sampling.seed,diagnostic:s.display.diagnostic,chunked:true,interactive});
        const finished=s.sampling.targetSpp>0&&engine.spp>=s.sampling.targetSpp;
        const displayRevision=`${s.revisions.display}/${s.revisions.accumulation}`;
        // Avoid full viewport bloom/output and cloned DOM snapshots per chunk.
        // Explicit display edits and the final chunk are always presented.
        if(displayRevision!==lastDisplayRevision||(submitted&&(now-lastDisplayAt>=1000/30||finished))){
          displayPipeline.render();lastDisplayAt=now;lastDisplayRevision=displayRevision;
        }
        if(now-lastPublishAt>=125||(submitted&&finished)){publishEngine();lastPublishAt=now;}
        if(submitted){
          const submission=engine.lastSubmission;
          samplesInFlight++;
          // Fill the idle queue through another browser task, giving pending
          // input an opportunity to switch back before more work is submitted.
          if(samplesInFlight<flightLimit())chunkTasks.port2.postMessage(null);
          const submittedAt=performance.now();
          interop.device.queue.onSubmittedWorkDone().then(()=>{
            const ms=completionClock.complete(submittedAt,performance.now());
            if(!disposed)engine.completeChunk(submission,ms);
            samplesInFlight--;if(!disposed)chunkTasks.port2.postMessage(null);
          },error=>{samplesInFlight--;if(!disposed)update({status:'error',error:error.message});});
        }
        // Counters are valid during a partial sweep too: each pixel records its
        // own attempts. Spp modulo gates can be skipped forever (1,5,9,...).
        if(workCounting&&!workBusy&&engine.workCounting&&now-lastWorkAt>=1000){
          workBusy=true;lastWorkAt=now;
          engine.readWork().then(result=>{
            if(result&&result.workUnits>0&&workCounting&&!disposed)update({diagnostics:{...state().diagnostics,work:{status:'ok',...summarizeWork(result.counts,result),integrationMode:result.integrationMode,timingCoverage:result.timingCoverage,timedChunks:result.timedChunks}}});
          }).catch(()=>{}).finally(()=>{workBusy=false;});
        }
        const sampleSerial=engine.sampleSerial;
        if(!statisticsBusy&&engine.lastSubmission&&sampleSerial!==lastStatisticsSerial&&(now-lastStatisticsAt>=1000||finished||s.sampling.paused)){
          statisticsBusy=true;lastStatisticsSerial=sampleSerial;lastStatisticsAt=now;const rev=statisticsRevision;
          engine.statistics().then(stats=>{if(stats&&rev===statisticsRevision){
            update({diagnostics:{...state().diagnostics,...stats}});
            if(stats.numericalErrorRate>1e-3){lastError=`光学数值错误率 ${(stats.numericalErrorRate*100).toFixed(3)}%，已停止累计；可切换光栅或选择其他镜头。`;update({status:'error',error:lastError});}
            else if(stats.bvhErrorRate>0){lastError=`BVH 遍历错误率 ${(stats.bvhErrorRate*100).toFixed(4)}%（实现错误，不是镜头遮挡或背景），已停止累计。`;update({status:'error',error:lastError});}
          }}).catch(error=>{lastError=error.message;}).finally(()=>{statisticsBusy=false;if(!disposed&&engine.sampleSerial!==lastStatisticsSerial)requestFrame();});
        }
      }catch(error){lastError=error.message;update({status:'error',error:error.message});console.error(error);}
    },
    async initialize({onProgress=async()=>{}}={}){
      await onProgress(7,'提取场景几何，构建光追加速结构');
      update({scene:{status:'building',message:'提取场景几何并在 Worker 中构建 BVH'}});
      const build=sceneResources.build('initial').then(stats=>{update({scene:{...state().scene,status:'ready',message:`BVH 就绪：${stats.instances} 个实例 · ${stats.triangles} 个基础三角形`}});return stats;},
        error=>{update({scene:{...state().scene,status:'error',message:error.message}});throw error;});
      manifest=await library.manifest();
      update({lenses:manifest.lenses.map(l=>({id:l.id,name:l.name,brand:l.brand??null,available:l.supported,reason:l.reason,
        validation:l.validation,surfaceCount:l.surfaceCount,focalLengthMm:catalogueFocalLengthMm(l)})),source:manifest.source});
      await onProgress(8,'编译真实镜组、光谱采样与自动对焦');
      tracer=await createLensTracer({interop,provider:garden,scene:bvh,chunkTiming:'queue',opticalLutReuse:preferredOpticalLutReuse(adapterInfo),width:state().sampling.resolution});
      engine=tracer.engine;
      if(workCounting)setWorkCounting(true).catch(error=>console.warn('Work counting unavailable',error));
      await loadLens(manifest.defaultId);displayGraph();displayChanged();
      await build;
      update({status:'loading'});
      // Warm the lighting-resource refresh and first real lens sample while
      // the loading curtain is up; startup still opens in raster mode.
      await onProgress(9,'预热镜头成像与首帧显示');
      lightingDirty=true;ensureLighting();
      engine.sample({batchSpp:1,targetSpp:state().sampling.targetSpp,seed:state().sampling.seed,diagnostic:state().display.diagnostic});
      diagnosticDirty=false;
      displayPipeline.render();
      await interop.device.queue.onSubmittedWorkDone();
      rasterPipeline.render();
      await interop.device.queue.onSubmittedWorkDone();
      update({status:'ready'});publishEngine();
    },
    get diagnostics(){return {...state(),lastError,initializationMs:engine?.initializationMs,sceneStats:sceneResources.stats,lighting:lighting.status};},
    dispose(){disposed=true;lensLoadRevision++;clearTimeout(releaseTimer);for(const type of inputEvents)document.removeEventListener(type,noteInput,inputOptions);chunkTasks.port1.close();chunkTasks.port2.close();tracer?.dispose();sceneResources.dispose();lighting.dispose();displayPipeline?.dispose();interop.dispose();store.dispose();},
  };
  const visibility=()=>{if(!document.hidden)requestFrame();};document.addEventListener('visibilitychange',visibility);
  const originalDispose=runtime.dispose;runtime.dispose=()=>{document.removeEventListener('visibilitychange',visibility);originalDispose();};
  return runtime;
}
