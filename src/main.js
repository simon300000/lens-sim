import * as THREE from 'three/webgpu';
import { pass, mrt, normalView, vec4, Fn, float, builtinAOContext, screenUV, uniform, convertToTexture } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildSanteiScene } from './scene/santei-scene.js';
import { createDaylight } from './lighting.js';
import { createTimeControls } from './time-controls.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { probeHDRCanvas,isHDRConfiguration,outputRendererOptions,displayOutputNode,captureCanvasRange } from './hdr-output.js';
import { createHybridRuntime } from './rendering/hybrid-runtime.js';
import { createLensUI } from './ui/lens-ui.js';
import { createRasterAO } from './rendering/raster-ao.js';
import { warmRender } from './rendering/startup-warmup.js';
import { installNormalPassReuse } from './rendering/pass-reuse.js';
import { startup } from './startup-progress.js';
import { installCameraWheelTravel, installCameraLookAround } from './camera-controls.js';

const faults=[];
window.addEventListener('error',event=>faults.push(event.message));
window.addEventListener('unhandledrejection',event=>faults.push(String(event.reason)));

async function createScene(){
  const startupStarted=performance.now();
  await startup.stage(1,'检测 GPU 与 HDR 画布支持');
  const pixelDiagnostics=new URLSearchParams(location.search).get('gpu-diagnostics')==='1';
  if(!navigator.gpu)throw new Error('此浏览器尚未启用 WebGPU。请用支持 WebGPU 的 Chrome 或 Edge 打开本地地址。');
  const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
  if(!adapter)throw new Error('未找到可用的 WebGPU 设备。请检查浏览器硬件加速设置。');
  let hdr=await probeHDRCanvas(adapter);
  const rendererOptions={antialias:true,alpha:false,powerPreference:'high-performance',
    // The lens BVH and large sensor tiles are storage buffers; request what the
    // adapter actually offers instead of relying on the 128/256 MiB defaults.
    requiredLimits:{maxTextureDimension2D:adapter.limits.maxTextureDimension2D,
      maxStorageBufferBindingSize:adapter.limits.maxStorageBufferBindingSize,maxBufferSize:adapter.limits.maxBufferSize}};
  let renderer=new THREE.WebGPURenderer({...rendererOptions,...outputRendererOptions(hdr.supported)});
  await renderer.init();
  if(hdr.supported&&(!renderer.backend.isWebGPUBackend||!isHDRConfiguration(renderer.backend.context.getConfiguration?.()))){
    renderer.dispose();
    hdr={supported:false,reason:'The main canvas did not accept extended HDR output'};
    renderer=new THREE.WebGPURenderer({...rendererOptions,...outputRendererOptions(false)});
    await renderer.init();
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,1.5));
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
  renderer.domElement.setAttribute('aria-label','可环视的山间别墅、庭院、鱼塘与远山三维模型');
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
  const {scene,garden,landscape,villa,vegetation,details}=buildSanteiScene();
  const portrait=innerWidth/innerHeight<.85;
  const camera=new THREE.PerspectiveCamera(portrait?48:40,innerWidth/innerHeight,.15,450);
  camera.position.set(21,13,27);
  if(portrait)camera.position.multiplyScalar(1.48);
  const controls=new OrbitControls(camera,renderer.domElement);
  controls.target.set(0,2.7,2.0);
  controls.enableDamping=true;
  controls.dampingFactor=.07;
  controls.minDistance=5;controls.maxDistance=62;
  controls.minPolarAngle=.01;controls.maxPolarAngle=Math.PI-.01;
  controls.enablePan=true;controls.panSpeed=.7;controls.rotateSpeed=.55;
  const disposeLookAround=installCameraLookAround(controls);
  controls.update();

  let ready=false,framesNeeded=0,rendering=false,pendingTime=null;
  let timeRevision=0;
  let completionRevision=-1;
  let pipeline,hybrid;
  const cameraExposure=uniform(1);
  function wake(){if(!ready)return;framesNeeded=Math.max(framesNeeded,2);if(!rendering){rendering=true;requestAnimationFrame(frame);}}
  // Daylight refreshes shadows/PMREM itself; the lens bridge only repacks lights.
  function invalidate(){hybrid?.lightingChanged();wake();}
  function frame(){
    // Commit the entire time state before any scene pass can cache this frame.
    if(pendingTime){const value=pendingTime;pendingTime=null;applyTime(value);}
    const revision=timeRevision,hour=sceneElement.dataset.hour;
    controls.update();if(hybrid)hybrid.frame();else pipeline.render();
    // Time completion is checked only on a new scene revision, never per optical batch.
    if(completionRevision!==revision&&sceneElement.dataset.renderedHour!==hour){completionRevision=revision;renderer.backend.device.queue.onSubmittedWorkDone().then(()=>{
      if(revision===timeRevision){sceneElement.dataset.renderedHour=hour;document.querySelector('#time-controls').setAttribute('aria-busy','false');}
    });}
    framesNeeded--;if(framesNeeded>0||hybrid?.needsFrame())requestAnimationFrame(frame);else rendering=false;
  }
  await startup.stage(3,'初始化天空、日照与反射');
  const daylight=createDaylight(scene,renderer,{details,invalidate});
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
  const prePass=pass(scene,camera,{type:THREE.HalfFloatType});
  const normalMRT=mrt({output:normalView});prePass.setMRT(normalMRT);
  const normal=prePass.getTextureNode('output'),depth=prePass.getTextureNode('depth');
  const scenePass=pass(scene,camera,{type:THREE.HalfFloatType});
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
  const rasterAO=createRasterAO(renderer,smoothAO);
  const mainAO=rasterAO.sample;
  const cameraAO=Fn(builder=>builder.camera===camera?mainAO:float(1))();
  scenePass.contextNode=builtinAOContext(cameraAO);
  // Glare is metered after photographic exposure, then converted back to the
  // shared scene radiance before HDR output (or the SDR fallback transform).
  const glare=bloom(beauty.mul(cameraExposure),.10,.25,1.8);
  pipeline.outputNode=displayOutputNode(vec4(beauty.rgb.add(glare.rgb.div(cameraExposure)),beauty.a),cameraExposure,hdr.supported);

  const renderBeauty=pipeline.render.bind(pipeline);
  pipeline.render=()=>{rasterAO.prepare();renderBeauty();};

  const diagnostics={backend:'WebGPU',three:THREE.REVISION,ready:false,errors:faults,groups:{},instances:0,meshes:0,triangles:0,
    hdr:{canvasSupported:hdr.supported,probe:hdr,displayHigh:displayHDR.matches,internalFormat:'rgba16float',
      canvasConfiguration:renderer.backend.context.getConfiguration?.(),outputTransfer:'sRGB',fallback:'ACESFilmic',
      fullFrameReadback:pixelDiagnostics?'startup-night-opt-in':'on-demand-only'}};
  scene.traverse(o=>{if(o.isMesh){diagnostics.meshes++;if(o.isInstancedMesh)diagnostics.instances+=o.count;diagnostics.triangles+=(o.geometry.index?.count||o.geometry.attributes.position.count)/3*(o.isInstancedMesh?o.count:1);}});
  for(const [name,item]of Object.entries({villa,vegetation,garden,landscape,details}))diagnostics.groups[name]=item?.metadata||item?.userData||(name==='vegetation'?item:{});
  window.__SANTEI__={scene,camera,renderer,controls,pipeline,diagnostics,garden,daylight,timeControls,scenePass};
  // Render on time/date changes and camera movement; never run an idle GPU loop.
  controls.addEventListener('change',()=>{hybrid?.cameraChanged();wake();});
  controls.addEventListener('start',()=>{hybrid?.setInteracting(true);wake();});
  controls.addEventListener('end',()=>{hybrid?.setInteracting(false);wake();});
  const disposeWheelTravel=installCameraWheelTravel(controls,renderer.domElement);
  addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);hybrid?.resize();wake();});
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
  hybrid=await createHybridRuntime({renderer,scene,camera,rasterPipeline:pipeline,rasterBeauty:beauty,rasterGlare:glare,refreshContext:()=>passReuse.beautyContext,cameraExposure,hdr,environment:daylight,requestFrame:wake,
    onOutputState:mode=>{outputStatus.textContent=mode==='hdr'?'HDR':'SDR';sceneElement.dataset.outputMode=mode;}});
  const lensPanel=document.createElement('aside');lensPanel.id='lens-controls';document.body.appendChild(lensPanel);
  const lensUI=createLensUI({store:hybrid.store,container:lensPanel});
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
  });
  try{await hybrid.initialize({onProgress:(step,label)=>startup.stage(step,label)});}catch(error){hybrid.store.update({status:'error',error:error.message});faults.push(error.message);console.error(error);}
  sceneElement.dataset.renderedHour=sceneElement.dataset.hour;
  sceneElement.dataset.gpuErrors=String(faults.length);
  document.querySelector('#time-controls').setAttribute('aria-busy','false');
  diagnostics.ready=true;
  diagnostics.initializationWallMs=performance.now()-startupStarted;
  sceneElement.dataset.initializationWallMs=String(diagnostics.initializationWallMs);
  ready=true;
  diagnostics.drawCalls=renderer.info.render.drawCalls;
  sceneElement.dataset.backend=diagnostics.backend;
  sceneElement.dataset.ready='true';
  sceneElement.dataset.meshes=diagnostics.meshes;
  sceneElement.dataset.instances=diagnostics.instances;
  sceneElement.dataset.triangles=diagnostics.triangles;
  sceneElement.dataset.koi=garden.koi.length;
  console.info('SANTEI scene ready',diagnostics);
  startup.complete();
  addEventListener('pagehide',()=>{ready=false;disposeWheelTravel();disposeLookAround();lensUI.dispose();hybrid.dispose();passReuse.dispose();rasterAO.dispose();controls.dispose();pipeline.dispose();renderer.dispose();},{once:true});
  // Initialization captured the current scene and prepared its first lens
  // sample. Schedule display without throwing away that prepared state.
  wake();
}
createScene().catch(error=>{console.error(error);startup.fail(error);});
