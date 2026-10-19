import * as THREE from 'three/webgpu';
import { pass, mrt, normalView, vec4, Fn, float, mix, builtinAOContext, uniform } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import { buildSanteiScene } from './scene/santei-scene.js';
import { createDaylight } from './lighting.js';
import { createTimeControls } from './time-controls.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { probeHDRCanvas,isHDRConfiguration,outputRendererOptions,displayOutputNode,captureCanvasRange } from './hdr-output.js';
import { createHybridRuntime } from './rendering/hybrid-runtime.js';
import { createLensUI } from './ui/lens-ui.js';
import { installActiveLightNodes } from './rendering/active-lights.js';
import { installSoftShadowFilter } from './rendering/soft-shadow-filter.js';
import { createRasterAO } from './rendering/raster-ao.js';
import { warmRender } from './rendering/startup-warmup.js';
import { installNormalPassReuse } from './rendering/pass-reuse.js';
import { startup } from './startup-progress.js';
import { installURLState } from './url-state.js';
import { createCameraRig, createScenePicker } from './camera-controls.js';
import { installSceneCard } from './ui/scene-card.js';
import {requiredGPULimits} from './rendering/gpu-policy.js';
import { installSharedInstancing, installRenderBundleContexts } from './rendering/three-interop.js';
import { bundleStaticContent } from './scene/render-bundles.js';
import { createMotionQuality } from './rendering/motion-quality.js';
import { loadRasterQuality, saveRasterQuality, rasterPixelRatio } from './rendering/raster-quality.js';
import { lensMaterial } from './scene/lens-registry.js';
import { installUserModels } from './user-model.js';

const faults=[];
window.addEventListener('error',event=>faults.push(event.message));
window.addEventListener('unhandledrejection',event=>faults.push(String(event.reason)));

async function createScene(){
  const startupStarted=performance.now();
  installSceneCard();
  await startup.stage(1,'检测 GPU 与 HDR 画布支持');
  const pixelDiagnostics=new URLSearchParams(location.search).get('gpu-diagnostics')==='1';
  if(!navigator.gpu)throw new Error('此浏览器尚未启用 WebGPU。请用支持 WebGPU 的 Chrome 或 Edge 打开本地地址。');
  const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
  if(!adapter)throw new Error('未找到可用的 WebGPU 设备。请检查浏览器硬件加速设置。');
  let hdr=await probeHDRCanvas(adapter);
  const rendererOptions={antialias:false,alpha:false,powerPreference:'high-performance',
    // The lens BVH and large sensor tiles are storage buffers; request what the
    // adapter actually offers instead of relying on the 128/256 MiB defaults.
    requiredLimits:requiredGPULimits(adapter.limits)};
  let renderer=new THREE.WebGPURenderer({...rendererOptions,...outputRendererOptions(hdr.supported)});
  await renderer.init();
  if(hdr.supported&&(!renderer.backend.isWebGPUBackend||!isHDRConfiguration(renderer.backend.context.getConfiguration?.()))){
    renderer.dispose();
    hdr={supported:false,reason:'The main canvas did not accept extended HDR output'};
    renderer=new THREE.WebGPURenderer({...rendererOptions,...outputRendererOptions(false)});
    await renderer.init();
  }
  // One shader build per material for every instanced batch (see three-interop).
  installSharedInstancing(renderer);
  // Static scene passes replay recorded render bundles (see scene/render-bundles).
  installRenderBundleContexts(renderer);
  const disposeActiveLights=installActiveLightNodes(renderer);
  // Raster preview quality (lens panel → 光栅画质) persists per browser.
  let rasterQuality=loadRasterQuality(window.localStorage);
  const pixelRatioFor=settings=>rasterPixelRatio(settings.pixelRatio,window.devicePixelRatio);
  let basePixelRatio=pixelRatioFor(rasterQuality),savedRasterJSON=JSON.stringify(rasterQuality);
  renderer.setPixelRatio(basePixelRatio);
  renderer.setSize(innerWidth,innerHeight);
  renderer.toneMapping=THREE.NoToneMapping;
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMappingExposure=1.04;
  renderer.shadowMap.enabled=true;
  renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  if(!renderer.backend.isWebGPUBackend)throw new Error('WebGPU 初始化失败，请使用支持 WebGPU 的浏览器。');
  renderer.backend.device.addEventListener('uncapturederror',event=>{
    faults.push(event.error.message);
    document.querySelector('#scene').dataset.gpuErrors=String(faults.length);
    console.error('WebGPU validation:',event.error.message);
  });
  document.querySelector('#scene').appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-label','可环视的山间别墅、枯山水庭院、拱桥鱼塘与远山三维模型');
  const displayHDR=matchMedia('(dynamic-range: high)');
  const outputStatus=document.querySelector('#output-status');
  function updateOutputStatus(){
    outputStatus.textContent=hdr.supported?'HDR':'SDR';
    outputStatus.title=hdr.supported?
      (displayHDR.matches?'HDR 画布输出 · 当前显示链路支持 HDR':'HDR 画布输出 · 当前显示链路报告标准动态范围'):
      '此浏览器不支持 HDR 画布，已自动使用 ACES tone mapping；内部仍为 HDR 浮点管线';
    Object.assign(document.querySelector('#scene').dataset,{outputMode:hdr.supported?'hdr':'sdr-tone-mapped',
      canvasFormat:renderer.backend.context.getConfiguration?.()?.format||'unknown',
      canvasToneMapping:renderer.backend.context.getConfiguration?.()?.toneMapping?.mode||'standard',
      displayHdr:String(displayHDR.matches)});
  }
  updateOutputStatus();displayHDR.addEventListener('change',updateOutputStatus);

  await startup.stage(2,'铺设庭园，栽种花木');
  const {scene,garden,landscape,villa,vegetation,details,features,testTargets}=buildSanteiScene();
  const userModels=new THREE.Group();userModels.name='User models';scene.add(userModels);
  // Static content is recorded into render bundles once warm-up has compiled
  // every variant (bundles.enable below). User models stay direct draws.
  const bundles=bundleStaticContent(scene,[villa.group,garden.garden,landscape.root,details.group,features.group,testTargets.group,
    scene.getObjectByName('Individually modelled garden planting')]);
  // Lower the raster resolution only while moving and only when the GPU is
  // measurably behind; every frame rendered at rest is full quality. The AO
  // result texture the bundled materials bind keeps its size (raster-ao), so a
  // step changes no bind group and re-records no bundle.
  const motionQuality=createMotionQuality({renderer,queue:renderer.backend.device.queue,baseRatio:basePixelRatio,
    onChange:()=>wake()});
  const portrait=innerWidth/innerHeight<.85;
  const camera=new THREE.PerspectiveCamera(portrait?48:40,innerWidth/innerHeight,.15,450);
  camera.position.set(21,13,27);
  if(portrait)camera.position.multiplyScalar(1.48);
  camera.lookAt(0,2.7,2.0);
  // One rig for look / orbit / pan / dolly / walk. Picking skips dense vegetation instances.
  const groundPicker=createScenePicker([villa.group,garden.garden,details.group,features.group,testTargets.group,landscape.meadow]);
  const controls=createCameraRig(camera,renderer.domElement,{
    pick:createScenePicker([villa.group,garden.garden,details.group,features.group,testTargets.group,landscape.meadow,userModels]),
    requestFrame:()=>wake()});
  controls.target.set(0,2.7,2.0);camera.lookAt(controls.target);controls.update(0);

  let ready=false,framesNeeded=0,rendering=false,pendingTime=null;
  let frameRequest=null,frameTask=null;
  const deferPointerFrames=navigator.vendor==='Apple Computer, Inc.';
  let timeRevision=0;
  let completionRevision=-1;
  let pipeline,hybrid;
  const cameraExposure=uniform(1);
  function queueFrame(){frameRequest=requestAnimationFrame(frame);}
  function wake(){if(!ready)return;framesNeeded=Math.max(framesNeeded,2);if(!rendering){lastFrameTime=performance.now();rendering=true;queueFrame();}}
  // Daylight refreshes shadows/PMREM itself; the lens bridge only repacks lights.
  function invalidate(){hybrid?.lightingChanged();wake();}
  let lastFrameTime=performance.now();
  function renderFrame(){
    if(!ready)return;
    const revision=timeRevision,hour=sceneElement.dataset.hour;
    if(hybrid){hybrid.frame();if(rasterQuality.adaptiveResolution&&hybrid.store.peekState().mode==='raster')motionQuality.frameSubmitted();}else pipeline.render();
    // Time completion is checked only on a new scene revision, never per optical batch.
    if(completionRevision!==revision&&sceneElement.dataset.renderedHour!==hour){completionRevision=revision;renderer.backend.device.queue.onSubmittedWorkDone().then(()=>{
      if(revision===timeRevision){sceneElement.dataset.renderedHour=hour;document.querySelector('#time-controls').setAttribute('aria-busy','false');}
    });}
  }
  function frame(now){
    frameRequest=null;
    if(!ready){rendering=false;return;}
    const delta=(now-lastFrameTime)/1000;lastFrameTime=now;
    // Commit the entire time state before any scene pass can cache this frame.
    if(pendingTime){const value=pendingTime;pendingTime=null;applyTime(value);}
    const cameraMoving=controls.update(delta);
    // WebKit can wait for canvas presentation at the end of its rendering
    // update. Keep camera ticks on rAF, but give native pointer events a task
    // turn before the raster submission so it uses the freshest camera pose.
    if(deferPointerFrames&&controls.pointerActive&&hybrid?.store.peekState().mode==='raster'){
      if(frameTask===null)frameTask=setTimeout(()=>{frameTask=null;renderFrame();},0);
    }else{
      if(frameTask!==null){clearTimeout(frameTask);frameTask=null;}
      renderFrame();
    }
    framesNeeded--;if(framesNeeded>0||cameraMoving||hybrid?.needsFrame())queueFrame();else rendering=false;
  }
  await startup.stage(3,'初始化天空、日照与反射');
  const daylight=createDaylight(scene,renderer,{details,invalidate});
  installSoftShadowFilter(scene,renderer);
  let celestialState;
  const sceneElement=document.querySelector('#scene');
  let timeControls;
  function applyTime(value,immediate=false){
    timeRevision++;
    document.querySelector('#time-controls').setAttribute('aria-busy','true');
    celestialState=daylight.update(value,immediate);
    cameraExposure.value=renderer.toneMappingExposure;
    hybrid?.setBaseExposure(renderer.toneMappingExposure);
    const s=celestialState;
    const periodLabel=s.sun.geometricAltitude>6?(value.hour<12?'日光':'午后'):s.sun.geometricAltitude>-6?(value.hour<12?'晨光':'薄暮'):'夜色';
    timeControls?.update({hour:value.hour,date:value.date,sunAltitude:s.sun.altitude,moonAltitude:s.moon.altitude,
      sunKelvin:s.lighting.sunKelvin,moonIllumination:s.moon.illuminatedFraction,phaseName:s.moon.phaseName,
      nightFactor:s.lighting.night,periodLabel});
    Object.assign(sceneElement.dataset,{hour:value.hour,date:value.date,sunAltitude:s.sun.altitude,moonAltitude:s.moon.altitude,
      sunLux:s.lighting.sunLux,moonLux:s.lighting.moonLux,sunKelvin:s.lighting.sunKelvin,moonPhase:s.moon.illuminatedFraction,
      exposure:renderer.toneMappingExposure,utc:s.utcISO});
    wake(); // daylight refreshed and invalidated the scene in the same update
  }
  timeControls=createTimeControls({onChange:value=>{pendingTime=value;wake();}});
  applyTime(timeControls.getValue(),true);
  pipeline=new THREE.RenderPipeline(renderer);
  // GTAO affects indirect light only. Direct Sun/Moon/lamp light stays governed
  // by its actual shadow map rather than an indiscriminate dark image overlay.
  // AO needs a single surface normal/depth per pixel; resolving MSAA normals
  // blends unrelated surfaces at silhouettes. Keep 4x MSAA on beauty only.
  const prePass=pass(scene,camera,{type:THREE.HalfFloatType,samples:0});
  const normalMRT=mrt({output:normalView});prePass.setMRT(normalMRT);
  const normal=prePass.getTextureNode('output'),depth=prePass.getTextureNode('depth');
  const scenePass=pass(scene,camera,{type:THREE.HalfFloatType,samples:rasterQuality.msaa});
  scenePass.renderTarget.texture.colorSpace=THREE.LinearSRGBColorSpace;
  const passReuse=installNormalPassReuse({renderer,normalMRT,beautyTarget:scenePass.renderTarget,camera});
  const beauty=scenePass.getTextureNode('output');
  const ambientOcclusion=ao(depth,normal,camera);
  ambientOcclusion.resolutionScale=.5;
  ambientOcclusion.radius.value=.45;
  ambientOcclusion.thickness.value=.8;
  ambientOcclusion.samples.value=8;
  const smoothAO=denoise(ambientOcclusion.getTextureNode(),depth,normal,camera);
  // Main-camera AO belongs only to the beauty target. Reflections and the
  // resource-only refresh must not inherit its view-dependent texture graph.
  const rasterAO=createRasterAO(renderer,smoothAO,{pixelRatio:basePixelRatio,width:innerWidth,height:innerHeight});
  const mainAO=rasterAO.sample;
  // Raster quality: AO off blends to 1 (no shader variant) and skips the AO passes.
  const aoAmount=uniform(1);
  const cameraAO=Fn(builder=>builder.camera===camera?mix(float(1),mainAO,aoAmount):float(1))();
  scenePass.contextNode=builtinAOContext(cameraAO);
  // Glare is metered after photographic exposure, then converted back to the
  // shared scene radiance before HDR output (or the SDR fallback transform).
  const glare=bloom(beauty.mul(cameraExposure),.10,.25,1.8);
  pipeline.outputNode=displayOutputNode(vec4(beauty.rgb.add(glare.rgb.div(cameraExposure)),beauty.a),cameraExposure,hdr.supported);

  const renderBeauty=pipeline.render.bind(pipeline);
  // Warm every optional pass before recording bundles, even when saved quality
  // settings disable it. First use of an RTT initializes/replaces its GPU texture;
  // recording beauty against the earlier placeholder leaves invalid bindings.
  let warmingRasterEffects=true;
  // Water reflection off: the reflector's per-frame scene render is skipped for
  // raster frames only (the lens lighting refresh restores it) and its
  // contribution is zeroed in the water material.
  const waterDescriptor=garden.water?lensMaterial(garden.water.material):null,reflectorBase=waterDescriptor?.reflector?.reflector??null;
  pipeline.render=()=>{
    if(warmingRasterEffects||rasterQuality.ambientOcclusion)rasterAO.prepare();
    if(reflectorBase)reflectorBase.updateBeforeType=(warmingRasterEffects||rasterQuality.reflection)?THREE.NodeUpdateType.FRAME:THREE.NodeUpdateType.NONE;
    try{renderBeauty();}finally{if(reflectorBase)reflectorBase.updateBeforeType=THREE.NodeUpdateType.FRAME;}
    bundles.frameRendered();
  };
  // The AO result target is only resized while AO renders: a resized target
  // that is never rendered again would leave every bundled material bound to
  // an uninitialized texture. Pending size changes apply when AO turns on.
  let aoTargetDirty=false;
  function syncAOTarget(){
    if(!rasterQuality.ambientOcclusion||!aoTargetDirty)return;
    aoTargetDirty=false;
    rasterAO.setPixelRatio(basePixelRatio);rasterAO.setSize(innerWidth,innerHeight);
    bundles.invalidate(); // recreated texture: bind groups and bundles re-record
  }
  // The AO prepass and the water reflection re-draw the whole forest at full
  // vertex cost. Woodland cells entirely beyond these distances contribute
  // nothing visible to a 0.45 m AO radius or a rippled 0.45-scale reflection,
  // so those two passes skip them; the beauty pass always draws everything.
  const AO_PREPASS_RANGE_M=90,REFLECTION_RANGE_M=120;
  bundles.setDistanceLimit((passRenderer,passCamera)=>{
    if(passRenderer.getMRT()===normalMRT)return AO_PREPASS_RANGE_M;
    if(reflectorBase&&passCamera!==camera&&reflectorBase.virtualCameras?.get(camera)===passCamera)return REFLECTION_RANGE_M;
    return Infinity;
  });
  function applyRasterQuality(settings){
    rasterQuality=settings;
    scenePass.options.samples=settings.msaa;
    const samplesChanged=scenePass.renderTarget.samples!==settings.msaa;
    if(samplesChanged){
      scenePass.renderTarget.samples=settings.msaa;
      scenePass.renderTarget.dispose();
      // Re-record both the new and previously used sample-count contexts.
      // Their cached bundles must not retain stale material bindings on return.
      bundles.invalidate();
    }
    aoAmount.value=settings.ambientOcclusion?1:0;
    if(waterDescriptor?.rasterReflection)waterDescriptor.rasterReflection.value=settings.reflection?1:0;
    const ratio=pixelRatioFor(settings);
    const ratioChanged=ratio!==basePixelRatio;
    if(ratioChanged||samplesChanged){
      basePixelRatio=ratio;motionQuality.setBaseRatio(ratio);
      renderer.setPixelRatio(ratio);renderer.setSize(innerWidth,innerHeight);
      if(ratioChanged)aoTargetDirty=true;
    }
    motionQuality.setInteracting(settings.adaptiveResolution&&controls.active&&(!hybrid||hybrid.store.peekState().mode==='raster'));
    syncAOTarget();
    Object.assign(document.querySelector('#scene').dataset,{rasterPixelRatio:settings.pixelRatio,rasterAo:String(settings.ambientOcclusion),
      rasterReflection:String(settings.reflection),rasterAdaptive:String(settings.adaptiveResolution)});
    wake();
  }
  applyRasterQuality(rasterQuality);

  const diagnostics={backend:'WebGPU',three:THREE.REVISION,ready:false,errors:faults,groups:{},instances:0,meshes:0,triangles:0,
    hdr:{canvasSupported:hdr.supported,probe:hdr,displayHigh:displayHDR.matches,internalFormat:'rgba16float',
      canvasConfiguration:renderer.backend.context.getConfiguration?.(),outputTransfer:'sRGB',fallback:'ACESFilmic',
      fullFrameReadback:pixelDiagnostics?'startup-night-opt-in':'on-demand-only'}};
  scene.traverse(o=>{if(o.isMesh){diagnostics.meshes++;if(o.isInstancedMesh)diagnostics.instances+=o.count;diagnostics.triangles+=(o.geometry.index?.count||o.geometry.attributes.position.count)/3*(o.isInstancedMesh?o.count:1);}});
  for(const [name,item]of Object.entries({villa,vegetation,garden,landscape,details,features}))diagnostics.groups[name]=item?.metadata||item?.userData||(name==='vegetation'?item:{});
  window.__SANTEI__={scene,camera,renderer,controls,pipeline,diagnostics,garden,daylight,timeControls,scenePass,testTargets};
  const gardenView={position:camera.position.toArray(),target:controls.target.toArray()};
  function showTestTarget(key){
    if(!ready)return;
    const view=key==='garden'?gardenView:testTargets.views[key];
    if(!view)return;
    camera.position.fromArray(view.position);controls.target.fromArray(view.target);camera.lookAt(controls.target);controls.sync();wake();
  }
  window.__SANTEI__.showTestTarget=showTestTarget;
  for(const button of document.querySelectorAll('[data-test-target]'))button.addEventListener('click',()=>showTestTarget(button.dataset.testTarget));
  // Render on time/date changes and camera movement; never run an idle GPU loop.
  controls.addEventListener('change',()=>{hybrid?.cameraChanged();wake();});
  const activeInputs=new Set();
  controls.addEventListener('start',event=>{activeInputs.add(event.travelSource||'pointer');hybrid?.setInteracting(true);motionQuality.setInteracting(rasterQuality.adaptiveResolution&&hybrid?.store.peekState().mode==='raster');wake();});
  controls.addEventListener('end',event=>{activeInputs.delete(event.travelSource||'pointer');hybrid?.setInteracting(activeInputs.size>0);motionQuality.setInteracting(rasterQuality.adaptiveResolution&&hybrid?.store.peekState().mode==='raster'&&activeInputs.size>0);wake();});
  addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);aoTargetDirty=true;syncAOTarget();hybrid?.resize();wake();});
  // Warm the visible Moon/stars, lamp shadows and unlit predawn variants while
  // the loading curtain is up, instead of compiling them on the first slider move.
  const initialTime=timeControls.getValue();
  diagnostics.warmup=[];
  const warm=async()=>{const row=await warmRender({renderer,scene,camera,render:()=>pipeline.render(),
    onProgress:({variants})=>{document.querySelector('#loading-detail').textContent=`正在准备场景管线 · 已访问 ${variants} 个绘制变体`;}});diagnostics.warmup.push(row);};
  for(const hour of [0,5.5]){
    await startup.stage(hour===0?4:5,hour===0?'预编译夜景、月亮与灯光':'预编译晨光与阴影');
    applyTime({...initialTime,hour},true);
    await warm();
    const canvasRange=hour===0&&pixelDiagnostics?captureCanvasRange(renderer):null;
    await renderer.backend.device.queue.onSubmittedWorkDone();
    if(canvasRange){
      diagnostics.hdr.nightCanvas=await canvasRange;
      Object.assign(sceneElement.dataset,{canvasPeak:diagnostics.hdr.nightCanvas.peak,
        canvasAboveWhite:diagnostics.hdr.nightCanvas.aboveWhitePixels,canvasNonFinite:diagnostics.hdr.nightCanvas.nonFinite});
    }
  }
  await startup.stage(6,'预编译当前时刻的场景');
  applyTime(initialTime,true);
  await warm();
  await renderer.backend.device.queue.onSubmittedWorkDone();
  // Every variant is compiled: from here on the static scene replays bundles.
  warmingRasterEffects=false;
  bundles.enable();
  hybrid=await createHybridRuntime({renderer,scene,camera,adapterInfo:adapter.info,rasterPipeline:pipeline,rasterBeauty:beauty,rasterGlare:glare,refreshContext:()=>passReuse.beautyContext,cameraExposure,hdr,environment:daylight,requestFrame:wake,
    onOutputState:mode=>{outputStatus.textContent=mode==='hdr'?'HDR':'SDR';sceneElement.dataset.outputMode=mode;},
    onRasterQuality:applyRasterQuality,initialState:{raster:rasterQuality}});
  const lensPanel=document.createElement('aside');lensPanel.id='lens-controls';document.body.appendChild(lensPanel);
  const lensUI=createLensUI({store:hybrid.store,container:lensPanel,liveStats:()=>hybrid.liveStats()});
  window.__SANTEI__.hybrid=hybrid;window.__SANTEI__.lensUI=lensUI;
  window.__SANTEI__.captureOutputRange=()=>{hybrid.frame();return captureCanvasRange(renderer);};
  hybrid.store.subscribe(state=>{
    Object.assign(sceneElement.dataset,{lensMode:state.mode,lensStatus:state.status,lensId:state.lensId,
      lensSpp:state.sampling.spp,lensTargetSpp:state.sampling.targetSpp,lensRenderModel:state.renderModel.id,
      sceneStatus:state.scene.status,sceneInstances:state.scene.summary?.instances??'',sceneBvhNodes:state.scene.summary?.bvhNodes??'',
      opticsRevision:state.revisions.optics,geometryRevision:state.revisions.geometry,lightingRevision:state.revisions.lighting,
      cameraRevision:state.revisions.camera,displayRevision:state.revisions.display,lightingRefreshes:state.diagnostics.lightingRefreshes,
      lensConfiguration:state.configurationIndex,focusDistanceM:state.optics.focusDistanceM??'infinity',
      imageDistanceMm:state.optics.imageDistanceMm,samplingPaused:String(state.sampling.paused),batchSpp:state.sampling.batchSpp,
      afStatus:state.af.status,lensError:state.error||'',bvhErrorRate:state.diagnostics.bvhErrorRate,unsupportedRate:state.diagnostics.unsupportedRate,
      transparencyLimitRate:state.diagnostics.transparencyLimitRate,
      opticalNumericalErrorRate:state.diagnostics.numericalErrorRate,opticalWidth:state.diagnostics.width,opticalHeight:state.diagnostics.height,
      opticalComputeMs:state.diagnostics.computeMs??'',lightingRefreshMs:state.diagnostics.lightingRefreshMs??'',opticalMemoryBytes:state.diagnostics.memoryBytes,
      opticalBlockedRate:state.diagnostics.opticalBlockedRate,opticalTirRate:state.diagnostics.tirRate,
      attemptedSamples:state.diagnostics.attemptedSamples,opticalPipelineCount:state.diagnostics.pipelineCompilations});
    diagnostics.hybrid=state;
    const rasterJSON=JSON.stringify(state.raster);
    if(rasterJSON!==savedRasterJSON){savedRasterJSON=rasterJSON;saveRasterQuality(window.localStorage,state.raster);}
  });
  try{await hybrid.initialize({onProgress:(step,label)=>startup.stage(step,label)});}catch(error){hybrid.store.update({status:'error',error:error.message});faults.push(error.message);console.error(error);}
  const urlState=await installURLState({camera,controls,store:hybrid.store,requestFrame:wake});
  sceneElement.dataset.renderedHour=sceneElement.dataset.hour;
  sceneElement.dataset.gpuErrors=String(faults.length);
  document.querySelector('#time-controls').setAttribute('aria-busy','false');
  diagnostics.ready=true;
  diagnostics.initializationWallMs=performance.now()-startupStarted;
  sceneElement.dataset.initializationWallMs=String(diagnostics.initializationWallMs);
  ready=true;
  for(const button of document.querySelectorAll('[data-test-target]'))button.disabled=false;
  // Models stand on the scene surface (never on each other); new ones go below the view centre.
  const downRay=new THREE.Raycaster(),down=new THREE.Vector3(0,-1,0);
  const groundAt=(x,z,fromY)=>{downRay.set(new THREE.Vector3(x,fromY,z),down);return groundPicker(downRay)?.point.y??null;};
  const userModel=installUserModels({root:userModels,scene,camera,element:renderer.domElement,exposure:cameraExposure,requestFrame:wake,groundAt,
    lookTarget:()=>{const t=controls.target;return new THREE.Vector3(t.x,groundAt(t.x,t.z,t.y+40)??t.y,t.z);},
    // Shadow maps refresh only on a time update; re-apply the current time.
    lightingChanged:()=>{pendingTime=timeControls.getValue();},sceneChanged:()=>hybrid.sceneChanged()});
  window.__SANTEI__.userModels=userModels;window.__SANTEI__.userModelManager=userModel;window.__SANTEI__.loadUserModel=files=>userModel.load(files);
  diagnostics.drawCalls=renderer.info.render.drawCalls;
  sceneElement.dataset.backend=diagnostics.backend;
  sceneElement.dataset.ready='true';
  sceneElement.dataset.meshes=diagnostics.meshes;
  sceneElement.dataset.instances=diagnostics.instances;
  sceneElement.dataset.triangles=diagnostics.triangles;
  sceneElement.dataset.koi=garden.koi.length;
  console.info('SANTEI scene ready',diagnostics);
  startup.complete();
  addEventListener('pagehide',()=>{ready=false;if(frameRequest!==null)cancelAnimationFrame(frameRequest);if(frameTask!==null)clearTimeout(frameTask);userModel.dispose();urlState.dispose();lensUI.dispose();hybrid.dispose();motionQuality.dispose();bundles.dispose();passReuse.dispose();rasterAO.dispose();disposeActiveLights();controls.dispose();pipeline.dispose();renderer.dispose();},{once:true});
  // Initialization captured the current scene and prepared its first lens
  // sample. Schedule display without throwing away that prepared state.
  wake();
}
createScene().catch(error=>{console.error(error);startup.fail(error);});
