import * as THREE from 'three/webgpu';
import { texture, screenUV, uniform, vec2, vec4, step, mix } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { createGPUInterop } from './three-interop.js';
import { createRasterCache } from './raster-cache.js';
import { createOpticalEngine } from './optical-engine.js';
import { hasSamplesRemaining, MAX_IMAGE_WIDTH } from './sampling-plan.js';
import { createControlStore } from './control-store.js';
import { apertureLimits, rearSamplingRegion } from '../optics/lens-state.js';
import { displayOutputNode } from '../hdr-output.js';

function catalogueFocalLengthMm(lens){
  // Zooms use their short end; prefer the published focal length over small
  // differences in the paraxial model between nominally identical lenses.
  const nominal=Number.parseFloat(lens.spec?.focal)||Number(lens.name?.match(/(\d+(?:\.\d+)?)\s*(?:[-–—]\s*\d+(?:\.\d+)?)?\s*mm(?:\b|_)/i)?.[1]);
  if(Number.isFinite(nominal)&&nominal>0)return nominal;
  return Math.abs(lens.configurations?.find(c=>Number.isFinite(c.initial?.focalLengthMm))?.initial.focalLengthMm)||null;
}

/** Scheduling and state boundary. Scene, optics, display, accumulation revisions
 * are deliberately separate; only the first two can invalidate scene capture. */
export async function createHybridRuntime({renderer,scene,camera,rasterPipeline,rasterBeauty,rasterGlare,cameraExposure,hdr,requestFrame,onOutputState=()=>{}}) {
  const store=createControlStore(),interop=createGPUInterop(renderer);
  const cache=createRasterCache({renderer,scene,interop,width:768});
  let lens=null,manifest=null,engine=null,baseExposure=cameraExposure.value,interacting=false,pointerActive=false,releaseTimer;
  let disposed=false,commandRevision=0,statisticsRevision=0,lastStatisticsSpp=-1,statisticsBusy=false,lastError=null;
  let displayPipeline=null,imageNode=null,bloomNode=null;
  const viewportAspect=uniform(innerWidth/innerHeight);
  let diagnosticDirty=false,sampleBusy=false;
  const update=patch=>store.update(patch);
  const state=()=>store.getState();
  function cancelFocus(){commandRevision++;const af=state().af;if(af.status==='busy')update({af:{...af,status:'idle',message:'参数改变，已取消过期对焦'}});}
  function clearMetrics(){const d=state().diagnostics;update({diagnostics:{...d,attemptedSamples:0,cacheMissRate:0,numericalErrorRate:0,opticalBlockedRate:0,tirRate:0,hitRate:0,backgroundRate:0,opticalPassRate:0}});diagnosticDirty=true;}
  function revision(kind){const revisions=state().revisions;revisions[kind]++;if(kind!=='display'&&kind!=='accumulation')revisions.accumulation++;update({revisions});}
  function publishEngine(){
    if(!engine)return;const s=state();
    update({sampling:{...s.sampling,spp:engine.spp},diagnostics:{...s.diagnostics,captures:cache.captures,pipelineCompilations:interop.compilations,
      captureMs:cache.captureMs,computeMs:engine.computeMs,timingSource:engine.timestampSupported?'GPU timestamp（单个采样分块） / CPU 提交耗时（捕获）':'无 timestamp：仅捕获 CPU 提交耗时',
      ...engine.dimensions,memoryBytes:engine.memoryBytes+(cache.captures>0?cache.target.width*cache.target.height*20:0),captureHorizontalFovDeg:cache.horizontalFov}});
  }
  function resetAccumulation(){cancelFocus();engine?.reset();clearMetrics();statisticsRevision++;lastStatisticsSpp=-1;revision('accumulation');publishEngine();requestFrame();}
  function minimumImageDistance(prescription){
    let lo=.05,hi=Math.max(1,prescription.imageDistanceMm);
    const valid=gap=>{try{rearSamplingRegion(prescription,prescription.lastVertexZMm+gap);return true;}catch{return false;}};
    if(valid(lo+.001))return lo+.001;
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
      // Capture and sensor ranges are separate. The fixed 36:24 sensor is fitted
      // in the viewport with letterboxing, never stretched or silently cropped.
      const scale=vec2(viewportAspect.div(1.5).max(1),viewportAspect.div(1.5).reciprocal().max(1));
      const sensorUV=screenUV.sub(.5).mul(scale).add(.5);
      imageNode=texture(engine.texture,sensorUV);
      const mask=step(0,sensorUV.x).mul(step(sensorUV.x,1)).mul(step(0,sensorUV.y)).mul(step(sensorUV.y,1));
      const framed=mix(vec4(.008,.009,.008,1),imageNode,mask);
      bloomNode=bloom(framed.mul(cameraExposure),.1,.25,1.8);
      displayPipeline.userData={framed};
    }
    const s=state();bloomNode.strength.value=s.display.bloom?.1:0;
    const linear=vec4(displayPipeline.userData.framed.rgb.add(bloomNode.rgb.div(cameraExposure)),1);
    displayPipeline.outputNode=displayOutputNode(linear,cameraExposure,hdr.supported&&s.display.output==='auto');
  }
  function displayChanged({rebuild=false,resolve=false}={}){
    revision('display');cameraExposure.value=baseExposure*2**state().display.exposureEV;
    if(rebuild)displayGraph();else if(bloomNode)bloomNode.strength.value=state().display.bloom?.1:0;
    diagnosticDirty ||= resolve;
    const actualOutput=hdr.supported&&state().display.output==='auto'?'hdr':'sdr-tone-mapped';
    if(rasterGlare)rasterGlare.strength.value=state().display.bloom?.1:0;
    if(rebuild&&rasterBeauty&&rasterGlare)rasterPipeline.outputNode=displayOutputNode(vec4(rasterBeauty.rgb.add(rasterGlare.rgb.div(cameraExposure)),1),cameraExposure,actualOutput==='hdr');
    update({display:{...state().display,actualOutput}});onOutputState(actualOutput);requestFrame();
  }
  function ensureCapture(){
    if(!engine||!lens)return;
    const captured=cache.capture({sourceCamera:camera,sceneRevision:state().revisions.scene,focalLengthMm:engine.packed.limits.focalLengthMm});
    if(captured){
      // Clear-sky deterministic fallback only for cache misses. In-cache sky uses
      // the actual capture; this is explicitly not spectral environment lighting.
      const intensity=Math.max(.00001,1/(baseExposure*50));
      engine.updateCapture({sourceCamera:camera,sky:{zenith:[.27,.43,.7].map(v=>v*intensity),horizon:[.65,.65,.6].map(v=>v*intensity),ground:[.1,.12,.08].map(v=>v*intensity)}});
      publishEngine();
    }
  }
  function applyOpticalChange(patch){
    const candidate={...state().optics,...patch};
    // Validate and upload before committing the UI snapshot. A rejected geometry
    // change must leave the old usable optics and focus state intact.
    engine.updateOptics({fNumber:candidate.fNumber,sensorZMm:lens.lastVertexZMm+candidate.imageDistanceMm,dispersion:candidate.dispersion});
    cancelFocus();update({optics:candidate});clearMetrics();statisticsRevision++;lastStatisticsSpp=-1;revision('optics');publishEngine();requestFrame();
  }
  async function loadLens(id,index=0){
    cancelFocus();const token=commandRevision,old=state();
    const entry=manifest.lenses.find(item=>item.id===id);if(!entry?.supported)throw new Error(entry?.reason||'镜头不可用');
    update({status:'loading',error:null});
    try{
      const response=await fetch(entry.asset);if(!response.ok)throw new Error('无法加载镜头数据');
      const nextAsset=await response.json();if(token!==commandRevision)return;
      const next=nextAsset.configurations[index];if(!next)throw new Error(nextAsset.configurationStatus[index]?.reason||'配置不可用');
      const limits=apertureLimits(next);
      // Discrete configurations retain their documented native image plane and
      // conjugate. A forced arbitrary 20 m estimate can place the sensor inside
      // the cover glass of an otherwise valid near-focus configuration.
      const focusDistanceM=next.objectDistanceMm===null?null:next.objectDistanceMm/1000;
      const sensorZMm=next.sensorZMm,fNumber=Math.max(limits.minFNumber,2.8);
      // Validate completely before replacing the usable state.
      const minimumGap=minimumImageDistance(next);
      const packed=engine.setLens(next,{fNumber,sensorZMm,dispersion:old.optics.dispersion});
      lens=next;cache.invalidate();statisticsRevision++;
      update({status:'ready',error:null,lensId:id,configurationIndex:index,configurations:nextAsset.configurationStatus.map(c=>({...c,available:c.supported})),
        warnings:[...(next.capabilityWarnings??[]),...next.warnings.filter(w=>/^(通光数据不完整|含 nd\/vd|380–780)/.test(w)),
          next.surfaces[next.stopIndex].apertureRadiusMm===null?`光阑半径由上游 ${next.apertureMode} 孔径参数与入瞳倍率标定，未采用绘图半径。`:'',
          packed.region.unknownAperture?'后面通光未知：使用明确的有限求交域，不能据此声称完整渐晕。':'',
          '经验渐晕仅存为元数据；当前只计算有依据的几何遮挡。',
          `捕获范围有限，单层 RGB/深度无法恢复被遮挡表面；镜头实际映射决定成像。`].filter(Boolean),
        limits:{fNumber:[limits.minFNumber,limits.maxFNumber],imageDistanceMm:[Math.min(minimumGap,next.imageDistanceMm),Math.max(200,Math.abs(limits.focalLengthMm)*4)]},
        optics:{...old.optics,fNumber,focusDistanceM,focusDistanceKnown:true,imageDistanceMm:sensorZMm-next.lastVertexZMm,focalLengthMm:limits.focalLengthMm},
        af:{...old.af,status:'idle',message:'上游原始像面与物距；可使用 AF-S 对当前目标调焦'}});
      clearMetrics();revision('optics');bindImage();publishEngine();requestFrame();
    }catch(error){if(token===commandRevision){update({status:lens?'ready':'error',error:error.message});}throw error;}
  }
  async function focusAt(distanceM,autofocus=false){
    const token=++commandRevision,revisions=state().revisions;
    const old=state();update({af:{...old.af,status:'busy',message:autofocus?'沿实际参考主光线获取目标':'追迹固定光束并求最佳像面'}});
    try{
      ensureCapture();
      let target;
      if(autofocus){const hit=await engine.referenceTarget();target=hit.infinity?[0,0,-1e7]:hit.local;distanceM=hit.infinity?null:hit.distanceM;}
      else target=[0,0,-(distanceM===null?1e7:distanceM*1000)];
      const result=await engine.focusPoint(target,{infinity:distanceM===null});
      const now=state();if(token!==commandRevision||revisions.scene!==now.revisions.scene||revisions.optics!==now.revisions.optics)return;
      applyOpticalChange({focusDistanceM:distanceM,focusDistanceKnown:true,imageDistanceMm:result.imageDistanceMm});
      const rms=value=>value<=result.rmsResolutionMm?`<${result.rmsResolutionMm.toExponential(1)}`:value<.001?value.toFixed(6):value.toFixed(4);
      update({af:{...state().af,status:'success',message:`${result.beams}/${result.beamBudget} 光束 · RMS ${rms(result.beforeRmsMm)} → ${rms(result.afterRmsMm)} mm`,lastResult:result}});
    }catch(error){if(token===commandRevision){update({af:{...state().af,status:'error',message:error.message}});}throw error;}
  }
  function invalidateScene(){
    if(disposed)return;commandRevision++;revision('scene');cache.invalidate();engine?.reset();clearMetrics();statisticsRevision++;lastStatisticsSpp=-1;
    if(state().af.status==='busy')update({af:{...state().af,status:'idle',message:'场景改变，已丢弃过期对焦'}});publishEngine();
  }
  store.setHandler(async({type,value})=>{
    const s=state();const recovery=type==='setMode'||type==='setPaused'||(engine&&['selectLens','selectConfiguration'].includes(type));
    if(s.status!=='ready'&&!recovery)throw new Error('镜头后端尚未就绪');
    const finite=(min,max)=>{if(!Number.isFinite(value)||value<min||value>max)throw new Error(`参数范围 ${min}–${max}`);return value;};
    switch(type){
      case 'setMode':if(!['raster','lens'].includes(value))throw new Error('无效视图');update({mode:value});requestFrame();break;
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
      case 'setDiagnostic':if(!['beauty','cache-miss','status'].includes(value))throw new Error('无效诊断视图');update({display:{...s.display,diagnostic:value}});displayChanged({resolve:true});break;
      case 'setOutput':if(!['auto','sdr'].includes(value))throw new Error('无效输出模式');update({display:{...s.display,output:value}});displayChanged({rebuild:true});break;
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
    store,cache,interop,get engine(){return engine;},
    invalidateScene,
    cameraChanged(){invalidateScene();if(interacting&&!pointerActive)scheduleRelease();},
    setBaseExposure(exposure){baseExposure=exposure;cameraExposure.value=exposure*2**state().display.exposureEV;},
    resize(){viewportAspect.value=innerWidth/innerHeight;},
    setInteracting(value){
      clearTimeout(releaseTimer);
      pointerActive=value;
      if(value){interacting=true;if(engine?.resize(240)){bindImage();resetAccumulation();}}
      else scheduleRelease();
    },
    needsFrame(){const s=state();return !disposed&&!sampleBusy&&!document.hidden&&s.mode==='lens'&&s.status==='ready'&&!s.sampling.paused&&s.af.status!=='busy'&&hasSamplesRemaining(engine.spp,s.sampling.targetSpp);},
    frame(){
      const s=state();if(s.mode==='raster'){rasterPipeline.render();return;}
      if(!engine||s.status!=='ready')return; // never display raster as successful lens output
      try{
        ensureCapture();if(diagnosticDirty){engine.resolve(s.display.diagnostic);diagnosticDirty=false;}
        const submitted=!sampleBusy&&!s.sampling.paused&&!document.hidden&&s.af.status!=='busy'&&engine.sample({batchSpp:interacting?1:s.sampling.batchSpp,targetSpp:s.sampling.targetSpp,seed:s.sampling.seed,diagnostic:s.display.diagnostic});
        displayPipeline.render();publishEngine();
        if(submitted){sampleBusy=true;interop.device.queue.onSubmittedWorkDone().then(()=>{sampleBusy=false;if(!disposed)requestFrame();},error=>{sampleBusy=false;if(!disposed)update({status:'error',error:error.message});});}
        if(!statisticsBusy&&engine.roundComplete&&engine.spp>0&&engine.spp!==lastStatisticsSpp&&((s.sampling.targetSpp>0&&engine.spp>=s.sampling.targetSpp)||engine.spp%32===0)){
          statisticsBusy=true;lastStatisticsSpp=engine.spp;const rev=statisticsRevision;
          engine.statistics().then(stats=>{if(stats&&rev===statisticsRevision){
            update({diagnostics:{...state().diagnostics,...stats}});
            if(stats.numericalErrorRate>1e-3){lastError=`光学数值错误率 ${(stats.numericalErrorRate*100).toFixed(3)}%，已停止累计；可切换光栅或选择其他镜头。`;update({status:'error',error:lastError});}
          }}).catch(error=>{lastError=error.message;}).finally(()=>{statisticsBusy=false;});
        }
      }catch(error){lastError=error.message;update({status:'error',error:error.message});console.error(error);}
    },
    async initialize(){
      const response=await fetch('/lenses/manifest.json');if(!response.ok)throw new Error('镜头数据缺失：运行 git submodule update --init --recursive 和 npm run build:lenses');
      manifest=await response.json();
      // Never clone the full library's configuration/provenance notes per spp.
      update({lenses:manifest.lenses.map(l=>({id:l.id,name:l.name,brand:l.brand??null,available:l.supported,reason:l.reason,
        validation:l.validation,surfaceCount:l.surfaceCount,focalLengthMm:catalogueFocalLengthMm(l)})),source:manifest.source});
      engine=await createOpticalEngine({interop,cache,width:state().sampling.resolution});
      await loadLens(manifest.defaultId);displayGraph();displayChanged();publishEngine();
      // Prepare the capture's MRT materials and the sensor display while the
      // loading curtain is still up, rather than on the first lens-mode frame.
      // Keep this real sample so switching modes can immediately show an image.
      update({status:'loading'});
      ensureCapture();
      engine.sample({batchSpp:1,targetSpp:state().sampling.targetSpp,seed:state().sampling.seed,diagnostic:state().display.diagnostic});
      diagnosticDirty=false;
      displayPipeline.render();
      await interop.device.queue.onSubmittedWorkDone();
      // Startup still opens in raster mode; never expose the warmup lens frame.
      rasterPipeline.render();
      await interop.device.queue.onSubmittedWorkDone();
      update({status:'ready'});publishEngine();
    },
    get diagnostics(){return {...state(),lastError,captureRevision:cache.revision,initializationMs:engine?.initializationMs};},
    dispose(){disposed=true;clearTimeout(releaseTimer);engine?.dispose();cache.dispose();displayPipeline?.dispose();interop.dispose();store.dispose();},
  };
  const visibility=()=>{if(!document.hidden)requestFrame();};document.addEventListener('visibilitychange',visibility);
  const originalDispose=runtime.dispose;runtime.dispose=()=>{document.removeEventListener('visibilitychange',visibility);originalDispose();};
  return runtime;
}
