import * as THREE from 'three/webgpu';
import { texture, screenUV, uniform, vec2, vec4, step, mix } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { createGPUInterop } from './three-interop.js';
import { createOpticalEngine, DIAGNOSTIC_MODES, ACCUMULATING_DIAGNOSTICS } from './optical-engine.js';
import { createSceneResources } from './scene-resources.js';
import { createLightingResources, STAR_ANGULAR_RADIUS } from './lighting-resources.js';
import { hasSamplesRemaining, MAX_IMAGE_WIDTH } from './sampling-plan.js';
import { createControlStore } from './control-store.js';
import { apertureLimits, rearSamplingRegion } from '../optics/lens-state.js';
import { focusedPrescription } from '../optics/focus-motion.js';
import { displayOutputNode } from '../hdr-output.js';

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
export async function createHybridRuntime({renderer,scene,camera,rasterPipeline,rasterBeauty,rasterGlare,refreshContext,cameraExposure,hdr,environment,requestFrame,onOutputState=()=>{},useWorker=true,maxSamplesInFlight=2}) {
  if(!Number.isInteger(maxSamplesInFlight)||maxSamplesInFlight<1||maxSamplesInFlight>2)throw new RangeError('Samples in flight must be 1 or 2');
  const store=createControlStore(),interop=createGPUInterop(renderer);
  const sceneResources=createSceneResources({interop,scene,camera,starAngularRadius:STAR_ANGULAR_RADIUS,useWorker});
  const lighting=createLightingResources({interop,renderer,scene,camera,environment,refreshContext});
  let lens=null,baseLens=null,manifest=null,engine=null,baseExposure=cameraExposure.value,interacting=false,pointerActive=false,releaseTimer;
  let disposed=false,commandRevision=0,lensLoadRevision=0,statisticsRevision=0,lastStatisticsSpp=-1,statisticsBusy=false,lastError=null;
  let displayPipeline=null,imageNode=null,bloomNode=null,lightingDirty=true,sceneBuild=null;
  const viewportAspect=uniform(innerWidth/innerHeight),rawDisplay=uniform(0);
  let diagnosticDirty=false,samplesInFlight=0;
  const update=patch=>store.update(patch);
  const state=()=>store.getState();
  function cancelFocus(){commandRevision++;const af=state().af;if(af.status==='busy')update({af:{...af,status:'idle',message:'参数改变，已取消过期对焦'}});}
  function clearMetrics(){const d=state().diagnostics;update({diagnostics:{...d,attemptedSamples:0,numericalErrorRate:0,opticalBlockedRate:0,tirRate:0,hitRate:0,backgroundRate:0,
    opticalPassRate:0,bvhErrorRate:0,unsupportedRate:0,transparencyLimitRate:0,radianceInvalidRate:0,reflectionOutsideRate:0,sceneHitOfPassed:0,backgroundOfPassed:0}});diagnosticDirty=true;}
  function revision(kind){const revisions={...state().revisions};revisions[kind]=(revisions[kind]??0)+1;if(kind!=='display'&&kind!=='accumulation')revisions.accumulation++;update({revisions});}
  function sceneSummary(){
    const s=sceneResources.stats;if(!s)return null;
    return {instances:s.instances,uniqueTriangles:s.triangles,expandedTriangles:s.report.expandedTriangles,meshes:s.report.meshes,blas:s.report.blas,
      materials:s.report.materials,bvhNodes:s.nodes,tlasNodes:s.tlasNodes,blasNodes:s.blasNodes,tlasDepth:s.tlasDepth,maxBlasDepth:s.maxBlasDepth,
      gpuBytes:s.gpuBytes,buildWallMs:s.buildWallMs,extractMs:s.extractMs,uploadSubmitMs:s.uploadSubmitMs,timing:s.timing,worker:s.worker,
      environmentObjects:s.report.environment.length,unsupported:s.report.unsupported,counters:sceneResources.counters,reason:s.reason};
  }
  function publishEngine(){
    if(!engine)return;const s=state();
    const ls=lighting.status;
    update({sampling:{...s.sampling,spp:engine.spp},diagnostics:{...s.diagnostics,pipelineCompilations:interop.compilations,
      computeMs:engine.computeMs,lightingRefreshMs:lighting.refreshMs,lightingRefreshes:lighting.refreshes,
      timingSource:engine.timestampSupported?'GPU timestamp（单个采样分块：镜头+BVH+着色）/ CPU 提交耗时（光栅资源刷新）':'无 timestamp：仅 CPU 提交耗时',
      ...engine.dimensions,memoryBytes:engine.memoryBytes+(sceneResources.stats?.gpuBytes??0)+1008},
      scene:{...s.scene,...(sceneSummary()?{summary:sceneSummary()}:{}),lighting:{ok:ls.ok,errors:ls.errors??[],warnings:ls.warnings??[],lights:ls.lights,environment:ls.environment,reflection:ls.reflection}}});
  }
  function resetAccumulation(kind='accumulation'){cancelFocus();engine?.reset();clearMetrics();statisticsRevision++;lastStatisticsSpp=-1;revision(kind);publishEngine();requestFrame();}
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
    lighting.refresh();engine?.setPose(camera);
    const ls=lighting.status;
    if(!ls.ok)throw new Error('光栅光照资源不可用：'+ls.errors.join('；'));
    publishEngine();
  }
  function applyOpticalChange(patch){
    const candidate={...state().optics,...patch};
    // Validate and upload before committing the UI snapshot. A rejected change
    // leaves the previous optics and focus state intact.
    engine.updateOptics({fNumber:candidate.fNumber,sensorZMm:lens.lastVertexZMm+candidate.imageDistanceMm,dispersion:candidate.dispersion});
    cancelFocus();update({optics:candidate});clearMetrics();statisticsRevision++;lastStatisticsSpp=-1;revision('optics');publishEngine();requestFrame();
  }
  async function loadLens(id,index=0){
    const entry=manifest.lenses.find(item=>item.id===id);if(!entry?.supported)throw new Error(entry?.reason||'镜头不可用');
    cancelFocus();const token=++lensLoadRevision,old=state();
    update({status:'loading',error:null});
    try{
      const response=await fetch(entry.asset);if(!response.ok)throw new Error('无法加载镜头数据');
      const nextAsset=await response.json();if(token!==lensLoadRevision)return;
      const next=nextAsset.configurations[index];if(!next)throw new Error(nextAsset.configurationStatus[index]?.reason||'配置不可用');
      const limits=apertureLimits(next);
      const focusDistanceM=next.objectDistanceMm===null?null:next.objectDistanceMm/1000;
      const sensorZMm=next.sensorZMm,fNumber=limits.minFNumber;
      const minimumGap=minimumImageDistance(next);
      const nextState={fNumber,sensorZMm,dispersion:old.optics.dispersion};
      await engine.prepareLens(next,nextState);if(token!==lensLoadRevision||disposed)return;
      const packed=engine.setLens(next,nextState);
      lens=next;baseLens=next;statisticsRevision++;
      update({status:'ready',error:null,lensId:id,configurationIndex:index,configurations:nextAsset.configurationStatus.map(c=>({...c,available:c.supported})),
        warnings:[...(next.capabilityWarnings??[]),...next.warnings.filter(w=>/^(通光数据不完整|含 nd\/vd|DOE 按|380–780)/.test(w)),
          next.surfaces[next.stopIndex].apertureRadiusMm===null?`光阑半径由上游 ${next.apertureMode} 孔径参数与入瞳倍率标定，未采用绘图半径。`:'',
          packed.region.unknownAperture?'后面通光未知：使用明确的有限求交域，不能据此声称完整渐晕。':'',
          '经验渐晕仅存为元数据；当前只计算有依据的几何遮挡。'].filter(Boolean),
        limits:{fNumber:[limits.minFNumber,limits.maxFNumber],imageDistanceMm:[Math.min(minimumGap,next.imageDistanceMm),Math.max(200,Math.abs(limits.focalLengthMm)*4)]},
        optics:{...old.optics,fNumber,focusDistanceM,focusDistanceKnown:true,imageDistanceMm:sensorZMm-next.lastVertexZMm,focalLengthMm:limits.focalLengthMm,
          focusModel:next.focusMotion?`镜组移动 · ${next.focusMotion.source}`:'固定镜组 · 传感器轴向调焦'},
        af:{...old.af,status:'idle',message:'上游原始像面与物距；可使用 AF-S 对当前目标调焦'}});
      clearMetrics();revision('optics');bindImage();publishEngine();requestFrame();
    }catch(error){if(token!==lensLoadRevision||disposed)return;update({status:lens?'ready':'error',error:error.message});throw error;}
  }
  async function focusAt(distanceM,autofocus=false){
    const token=++commandRevision,revisions=state().revisions;
    const old=state();update({af:{...old.af,status:'busy',message:autofocus?'沿实际参考主光线求取真实场景交点':baseLens.focusMotion?'按上游对焦资料移动镜组':'追迹固定光束并求最佳像面'}});
    try{
      let target,hit=null;
      if(autofocus){
        if(!sceneResources.ready)throw new Error('场景 BVH 尚未就绪');
        engine.setPose(camera);hit=await engine.referenceTarget();target=hit.infinity?[0,0,-1e7]:hit.local;distanceM=hit.infinity?null:hit.distanceM;
      }
      else target=[0,0,-(distanceM===null?1e7:distanceM*1000)];
      if(token!==commandRevision)return;
      if(baseLens.focusMotion){
        const moved=focusedPrescription(baseLens,distanceM),next=moved.lens,limits=apertureLimits(next);
        // Hold the physical stop opening while the entrance pupil / EFL change.
        const fNumber=Math.max(limits.minFNumber,Math.min(limits.maxFNumber,
          Math.abs(limits.focalLengthMm*limits.pupilMagnification)/(2*engine.packed.stopRadiusMm)));
        const minimumGap=minimumImageDistance(next);
        engine.setLens(next,{fNumber,sensorZMm:next.sensorZMm,dispersion:old.optics.dispersion});
        lens=next;
        cancelFocus();
        update({optics:{...state().optics,fNumber,focusDistanceM:moved.focusDistanceM,focusDistanceKnown:true,
          imageDistanceMm:next.imageDistanceMm,focalLengthMm:limits.focalLengthMm,
          focusModel:`镜组移动 · ${baseLens.focusMotion.source}`},
          limits:{fNumber:[limits.minFNumber,limits.maxFNumber],imageDistanceMm:[Math.min(minimumGap,next.imageDistanceMm),Math.max(200,Math.abs(limits.focalLengthMm)*4)]},
          af:{...state().af,status:'success',message:`按 ${baseLens.focusMotion.source} 移动镜组 · 像面固定${moved.clamped?' · 已限制到资料最近对焦距离':''}${moved.extrapolated?' · 超出表格节点，沿末段外推':''}${hit?.transparentLayers?` · 穿过 ${hit.transparentLayers} 层透明面`:''}`,
            lastResult:{source:baseLens.focusMotion.source,focusDistanceM:moved.focusDistanceM,sensorZMm:next.sensorZMm,extrapolated:moved.extrapolated,clamped:moved.clamped,target:hit}}});
        clearMetrics();statisticsRevision++;lastStatisticsSpp=-1;revision('optics');publishEngine();requestFrame();
        return;
      }
      const result=await engine.focusPoint(target,{infinity:distanceM===null});
      const now=state();
      if(token!==commandRevision||revisions.geometry!==now.revisions.geometry||revisions.optics!==now.revisions.optics||revisions.camera!==now.revisions.camera)return;
      applyOpticalChange({focusDistanceM:distanceM,focusDistanceKnown:true,imageDistanceMm:result.imageDistanceMm});
      const rms=value=>value<=result.rmsResolutionMm?`<${result.rmsResolutionMm.toExponential(1)}`:value<.001?value.toFixed(6):value.toFixed(4);
      const through=hit?.transparentLayers?` · 穿过 ${hit.transparentLayers} 层透明面`:'';
      const targetText=hit?(hit.infinity?'背景 → ∞ · ':`真实交点 ${hit.distanceM.toFixed(3)} m · `):'';
      update({af:{...state().af,status:'success',message:`${targetText}${result.beams}/${result.beamBudget} 光束 · RMS ${rms(result.beforeRmsMm)} → ${rms(result.afterRmsMm)} mm${through}`,lastResult:{...result,target:hit}}});
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
    if(state().af.status==='busy')update({af:{...state().af,status:'idle',message:'相机改变，已丢弃过期对焦'}});
    resetAccumulation('camera');
    if(interacting&&!pointerActive)scheduleRelease();
  }
  store.setHandler(async({type,value})=>{
    const s=state();const recovery=type==='setMode'||type==='setPaused'||(engine&&['selectLens','selectConfiguration'].includes(type));
    if(s.status!=='ready'&&!recovery)throw new Error('镜头后端尚未就绪');
    const finite=(min,max)=>{if(!Number.isFinite(value)||value<min||value>max)throw new Error(`参数范围 ${min}–${max}`);return value;};
    switch(type){
      case 'setMode':if(!['raster','lens'].includes(value))throw new Error('无效视图');update({mode:value});if(value==='lens')lightingDirty=true;requestFrame();break;
      case 'selectLens':await loadLens(value);break;
      case 'selectConfiguration':await loadLens(s.lensId,value);break;
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
      case 'setExposureEV':finite(-6,6);update({display:{...s.display,exposureEV:value}});displayChanged();break;
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
      try{if(engine&&await engine.resizeChecked(state().sampling.resolution)){bindImage();resetAccumulation();}}
      catch(error){if(!disposed)update({sampling:{...state().sampling,resolution:engine.dimensions.width},error:error.message});}
      if(disposed)return;
      if(state().af.autoOnRelease&&state().status==='ready')focusAt(null,true).catch(()=>{});requestFrame();
    },240);
  }
  const runtime={
    store,interop,sceneResources,lighting,get engine(){return engine;},
    lightingChanged,sceneChanged,cameraChanged,
    /** Back-compatible full invalidation: lighting + registered scene data. */
    invalidateScene(){lightingChanged();return sceneChanged();},
    setBaseExposure(exposure){baseExposure=exposure;cameraExposure.value=exposure*2**state().display.exposureEV;},
    resize(){viewportAspect.value=innerWidth/innerHeight;lightingDirty=true;},
    setInteracting(value){
      clearTimeout(releaseTimer);
      pointerActive=value;
      if(value){interacting=true;if(engine?.resize(240)){bindImage();resetAccumulation();}}
      else scheduleRelease();
    },
    needsFrame(){const s=state();return !disposed&&samplesInFlight<(interacting?1:maxSamplesInFlight)&&!document.hidden&&s.mode==='lens'&&s.status==='ready'&&sceneResources.ready&&!s.sampling.paused&&s.af.status!=='busy'&&hasSamplesRemaining(engine.spp,s.sampling.targetSpp);},
    frame(){
      const s=state();if(s.mode==='raster'){rasterPipeline.render();return;}
      // Never display raster as successful lens output.
      if(!engine||s.status!=='ready'||!sceneResources.ready)return;
      try{
        ensureLighting();
        if(diagnosticDirty){engine.resolve(s.display.diagnostic);diagnosticDirty=false;}
        const submitted=samplesInFlight<(interacting?1:maxSamplesInFlight)&&!s.sampling.paused&&!document.hidden&&s.af.status!=='busy'&&engine.sample({batchSpp:interacting?1:s.sampling.batchSpp,targetSpp:s.sampling.targetSpp,seed:s.sampling.seed,diagnostic:s.display.diagnostic});
        displayPipeline.render();publishEngine();
        // Keep at most two ordered batches on the existing GPU queue. One whole-
        // queue fence per frame previously left a RAF-sized bubble after each
        // slow batch. Interaction stays single-batch to bound control latency.
        if(submitted){samplesInFlight++;interop.device.queue.onSubmittedWorkDone().then(()=>{samplesInFlight--;if(!disposed)requestFrame();},error=>{samplesInFlight--;if(!disposed)update({status:'error',error:error.message});});}
        if(!statisticsBusy&&engine.roundComplete&&engine.spp>0&&engine.spp!==lastStatisticsSpp&&((s.sampling.targetSpp>0&&engine.spp>=s.sampling.targetSpp)||engine.spp%32===0)){
          statisticsBusy=true;lastStatisticsSpp=engine.spp;const rev=statisticsRevision;
          engine.statistics().then(stats=>{if(stats&&rev===statisticsRevision){
            update({diagnostics:{...state().diagnostics,...stats}});
            if(stats.numericalErrorRate>1e-3){lastError=`光学数值错误率 ${(stats.numericalErrorRate*100).toFixed(3)}%，已停止累计；可切换光栅或选择其他镜头。`;update({status:'error',error:lastError});}
            else if(stats.bvhErrorRate>0){lastError=`BVH 遍历错误率 ${(stats.bvhErrorRate*100).toFixed(4)}%（实现错误，不是镜头遮挡或背景），已停止累计。`;update({status:'error',error:lastError});}
          }}).catch(error=>{lastError=error.message;}).finally(()=>{statisticsBusy=false;});
        }
      }catch(error){lastError=error.message;update({status:'error',error:error.message});console.error(error);}
    },
    async initialize({onProgress=async()=>{}}={}){
      await onProgress(7,'提取场景几何，构建光追加速结构');
      update({scene:{status:'building',message:'提取场景几何并在 Worker 中构建 BVH'}});
      const build=sceneResources.build('initial').then(stats=>{update({scene:{...state().scene,status:'ready',message:`BVH 就绪：${stats.instances} 个实例 · ${stats.triangles} 个基础三角形`}});return stats;},
        error=>{update({scene:{...state().scene,status:'error',message:error.message}});throw error;});
      const response=await fetch('/lenses/manifest.json');if(!response.ok)throw new Error('镜头数据缺失：运行 git submodule update --init --recursive 和 npm run build:lenses');
      manifest=await response.json();
      update({lenses:manifest.lenses.map(l=>({id:l.id,name:l.name,brand:l.brand??null,available:l.supported,reason:l.reason,
        validation:l.validation,surfaceCount:l.surfaceCount,focalLengthMm:catalogueFocalLengthMm(l)})),source:manifest.source});
      await onProgress(8,'编译真实镜组、光谱采样与自动对焦');
      engine=await createOpticalEngine({interop,sceneResources,lighting,width:state().sampling.resolution});
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
    dispose(){disposed=true;lensLoadRevision++;clearTimeout(releaseTimer);engine?.dispose();sceneResources.dispose();lighting.dispose();displayPipeline?.dispose();interop.dispose();store.dispose();},
  };
  const visibility=()=>{if(!document.hidden)requestFrame();};document.addEventListener('visibilitychange',visibility);
  const originalDispose=runtime.dispose;runtime.dispose=()=>{document.removeEventListener('visibilitychange',visibility);originalDispose();};
  return runtime;
}
