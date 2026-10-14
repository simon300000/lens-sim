import './style.css';
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, mix, vec2, vec3, vec4, positionWorld, sin, cos, normalMap, builtinAOContext, screenUV, reflector, dot, normalize, cameraPosition, pow, uniform, mx_noise_float, materialColor, convertToTexture } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildVilla } from './villa.js';
import { buildVegetation } from './vegetation.js';
import { buildGarden } from './garden.js';
import { buildLandscape } from './landscape.js';
import { buildDetails } from './details.js';
import { createDaylight } from './lighting.js';
import { createTimeControls } from './time-controls.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { probeHDRCanvas,isHDRConfiguration,outputRendererOptions,displayOutputNode,captureCanvasRange } from './hdr-output.js';

const loading=document.querySelector('#loading'), message=document.querySelector('#loading-message');
const faults=[];
window.addEventListener('error',event=>faults.push(event.message));
window.addEventListener('unhandledrejection',event=>faults.push(String(event.reason)));

async function createScene(){
  if(!navigator.gpu)throw new Error('此浏览器尚未启用 WebGPU。请用支持 WebGPU 的 Chrome 或 Edge 打开本地地址。');
  const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
  if(!adapter)throw new Error('未找到可用的 WebGPU 设备。请检查浏览器硬件加速设置。');
  message.textContent='检测 HDR 画布支持';
  let hdr=await probeHDRCanvas(adapter);
  const rendererOptions={antialias:true,alpha:false,powerPreference:'high-performance'};
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

  const scene=new THREE.Scene();
  scene.background=new THREE.Color('#e1e5d5');
  scene.fog=new THREE.FogExp2('#dce3d5',.0065);
  const portrait=innerWidth/innerHeight<.85;
  const camera=new THREE.PerspectiveCamera(portrait?48:40,innerWidth/innerHeight,.15,450);
  camera.position.set(21,13,27);
  if(portrait)camera.position.multiplyScalar(1.48);
  const controls=new OrbitControls(camera,renderer.domElement);
  controls.target.set(0,2.7,2.0);
  controls.enableDamping=true;
  controls.dampingFactor=.07;
  controls.minDistance=5;controls.maxDistance=62;
  controls.minPolarAngle=.22;controls.maxPolarAngle=Math.PI*.485;
  controls.enablePan=true;controls.panSpeed=.7;controls.rotateSpeed=.55;
  controls.update();

  message.textContent='铺设庭园，栽种花木';
  const garden=buildGarden(scene);
  const landscape=buildLandscape(scene,garden.pondOutline);
  const villa=buildVilla(scene);
  const vegetation=buildVegetation(scene);
  const details=buildDetails(scene,{garden,villa,vegetation,landscape});
  // Both paper lanterns need wall/roof occlusion. Their shadow cameras see the
  // local joinery layer, keeping the entire remote forest out of six cube faces.
  villa.group.traverse(o=>{if(o.isMesh)o.layers.enable(1);});
  details.group.traverse(o=>{if(o.isMesh)o.layers.enable(1);});
  for(const lamp of details.lamps.slice(0,2)){
    lamp.light.castShadow=true;
    lamp.light.shadow.mapSize.set(512,512);
    lamp.light.shadow.camera.near=.08;lamp.light.shadow.camera.far=11;
    lamp.light.shadow.camera.layers.set(1);
    lamp.light.shadow.bias=-.00008;lamp.light.shadow.normalBias=.025;
  }
  details.metadata.shadowedLamps=2;
  // Terrain can occlude low Sun/Moon rays. Dense tree silhouettes also cast
  // shadows; the individual distant needles keep their cheaper static shading.
  landscape.root.traverse(o=>{
    if(o.isMesh&&(o.name.startsWith('Atmospheric mountain')||o.geometry.type==='IcosahedronGeometry'))o.castShadow=true;
    if(o.isMesh&&o.name.includes('Meadow')){
      const variation=mx_noise_float(positionWorld.mul(vec3(2.5,1,2.5))).mul(.065).add(.95);
      o.material.colorNode=materialColor.mul(variation);
    }
  });
  if(garden.water){
    const p=positionWorld;
    const ripples=sin(p.x.mul(3.5).add(p.z.mul(2.3))).mul(.018).add(cos(p.x.mul(5).sub(p.z.mul(4.1))).mul(.012));
    garden.water.material.normalNode=normalMap(vec3(ripples.add(.5),ripples.mul(.7).add(.5),1));
    garden.water.material.metalness=0;
    garden.water.material.roughness=.115;
    const mirror=reflector({resolutionScale:.45,bounces:false,generateMipmaps:false});
    mirror.target.rotation.x=-Math.PI/2;
    garden.water.add(mirror.target);
    mirror.uvNode=mirror.uvNode.add(vec2(ripples.mul(.016),ripples.mul(.01)));
    const view=normalize(cameraPosition.sub(positionWorld));
    const fresnel=pow(dot(view,vec3(0,1,0)).clamp(0,1).oneMinus(),5).mul(.98).add(.02);
    garden.water.material.emissiveNode=mirror.rgb.mul(fresnel).mul(2.2);
    garden.water.material.opacity=.35;
  }
  let ready=false,framesNeeded=0,rendering=false;
  let timeRevision=0;
  let pipeline;
  const cameraExposure=uniform(1);
  function invalidate(){if(!ready)return;framesNeeded=Math.max(framesNeeded,4);if(!rendering){rendering=true;requestAnimationFrame(frame);}}
  function frame(){
    const revision=timeRevision,hour=sceneElement.dataset.hour;
    controls.update();pipeline.render();
    renderer.backend.device.queue.onSubmittedWorkDone().then(()=>{
      if(revision===timeRevision){sceneElement.dataset.renderedHour=hour;document.querySelector('#time-controls').setAttribute('aria-busy','false');}
    });
    framesNeeded--;if(framesNeeded>0)requestAnimationFrame(frame);else rendering=false;
  }
  const daylight=createDaylight(scene,renderer,{details,invalidate});
  let celestialState;
  const sceneElement=document.querySelector('#scene');
  let timeControls;
  function applyTime(value,immediate=false){
    timeRevision++;
    document.querySelector('#time-controls').setAttribute('aria-busy','true');
    celestialState=daylight.update(value,immediate);
    cameraExposure.value=renderer.toneMappingExposure;
    const s=celestialState;
    const periodLabel=s.sun.geometricAltitude>6?(value.hour<12?'日光':'午后'):s.sun.geometricAltitude>-6?(value.hour<12?'晨光':'薄暮'):'夜色';
    timeControls?.update({hour:value.hour,date:value.date,sunAltitude:s.sun.altitude,moonAltitude:s.moon.altitude,
      sunKelvin:s.lighting.sunKelvin,moonIllumination:s.moon.illuminatedFraction,phaseName:s.moon.phaseName,
      nightFactor:s.lighting.night,periodLabel});
    Object.assign(sceneElement.dataset,{hour:value.hour,date:value.date,sunAltitude:s.sun.altitude,moonAltitude:s.moon.altitude,
      sunLux:s.lighting.sunLux,moonLux:s.lighting.moonLux,sunKelvin:s.lighting.sunKelvin,moonPhase:s.moon.illuminatedFraction,
      exposure:renderer.toneMappingExposure,utc:s.utcISO});
    invalidate();
  }
  timeControls=createTimeControls({onChange:applyTime});
  applyTime(timeControls.getValue(),true);
  pipeline=new THREE.RenderPipeline(renderer);
  // GTAO affects indirect light only. Direct Sun/Moon/lamp light stays governed
  // by its actual shadow map rather than an indiscriminate dark image overlay.
  const prePass=pass(scene,camera,{type:THREE.HalfFloatType});
  prePass.setMRT(mrt({output:normalView}));
  const normal=prePass.getTextureNode('output'),depth=prePass.getTextureNode('depth');
  const scenePass=pass(scene,camera,{type:THREE.HalfFloatType});
  scenePass.renderTarget.texture.colorSpace=THREE.LinearSRGBColorSpace;
  const beauty=scenePass.getTextureNode('output');
  const ambientOcclusion=ao(depth,normal,camera);
  ambientOcclusion.resolutionScale=.5;
  ambientOcclusion.radius.value=.45;
  ambientOcclusion.thickness.value=.8;
  ambientOcclusion.samples.value=8;
  const smoothAO=denoise(ambientOcclusion.getTextureNode(),depth,normal,camera);
  scenePass.contextNode=builtinAOContext(convertToTexture(smoothAO).sample(screenUV).r);
  // Glare is metered after photographic exposure, then converted back to the
  // shared scene radiance before HDR output (or the SDR fallback transform).
  const glare=bloom(beauty.mul(cameraExposure),.10,.25,1.8);
  pipeline.outputNode=displayOutputNode(vec4(beauty.rgb.add(glare.rgb.div(cameraExposure)),beauty.a),cameraExposure,hdr.supported);

  const diagnostics={backend:'WebGPU',three:THREE.REVISION,ready:false,errors:faults,groups:{},instances:0,meshes:0,triangles:0,
    hdr:{canvasSupported:hdr.supported,probe:hdr,displayHigh:displayHDR.matches,internalFormat:'rgba16float',
      canvasConfiguration:renderer.backend.context.getConfiguration?.(),outputTransfer:'sRGB',fallback:'ACESFilmic'}};
  scene.traverse(o=>{if(o.isMesh){diagnostics.meshes++;if(o.isInstancedMesh)diagnostics.instances+=o.count;diagnostics.triangles+=(o.geometry.index?.count||o.geometry.attributes.position.count)/3*(o.isInstancedMesh?o.count:1);}});
  for(const [name,item]of Object.entries({villa,vegetation,garden,landscape,details}))diagnostics.groups[name]=item?.metadata||item?.userData||(name==='vegetation'?item:{});
  window.__SANTEI__={scene,camera,renderer,controls,pipeline,diagnostics,garden,daylight,timeControls,scenePass};
  message.textContent='预编译日月、晨光与反射';
  // Render on time/date changes and camera movement; never run an idle GPU loop.
  controls.addEventListener('change',invalidate);
  controls.addEventListener('start',invalidate);
  addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);invalidate();});
  // Warm the visible Moon/stars, lamp shadows and unlit predawn variants while
  // the loading curtain is up, instead of compiling them on the first slider move.
  const initialTime=timeControls.getValue();
  for(const hour of [0,5.5]){
    applyTime({...initialTime,hour},true);
    pipeline.render();
    const canvasRange=hour===0?captureCanvasRange(renderer):null;
    await renderer.backend.device.queue.onSubmittedWorkDone();
    if(canvasRange){
      diagnostics.hdr.nightCanvas=await canvasRange;
      Object.assign(sceneElement.dataset,{canvasPeak:diagnostics.hdr.nightCanvas.peak,
        canvasAboveWhite:diagnostics.hdr.nightCanvas.aboveWhitePixels,canvasNonFinite:diagnostics.hdr.nightCanvas.nonFinite});
    }
  }
  applyTime(initialTime,true);
  pipeline.render();
  await renderer.backend.device.queue.onSubmittedWorkDone();
  sceneElement.dataset.renderedHour=sceneElement.dataset.hour;
  sceneElement.dataset.gpuErrors=String(faults.length);
  document.querySelector('#time-controls').setAttribute('aria-busy','false');
  diagnostics.ready=true;
  ready=true;
  diagnostics.drawCalls=renderer.info.render.drawCalls;
  sceneElement.dataset.backend=diagnostics.backend;
  sceneElement.dataset.ready='true';
  sceneElement.dataset.meshes=diagnostics.meshes;
  sceneElement.dataset.instances=diagnostics.instances;
  sceneElement.dataset.triangles=diagnostics.triangles;
  sceneElement.dataset.koi=garden.koi.length;
  console.info('SANTEI scene ready',diagnostics);
  loading.classList.add('complete');
  invalidate();
}
createScene().catch(error=>{console.error(error);loading.classList.add('error');message.textContent=error.message;});
