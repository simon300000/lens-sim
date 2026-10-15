import * as THREE from 'three/webgpu';
import { pass,uniform } from 'three/tsl';
import { createDaylight } from '../src/lighting.js';
import { probeHDRCanvas,outputRendererOptions,displayOutputNode,captureCanvasRange } from '../src/hdr-output.js';
const out=document.querySelector('#result'),errors=[],rows=[];
let renderer,daylight,pipeline;
try{
  const adapter=await navigator.gpu.requestAdapter(),hdr=await probeHDRCanvas(adapter);
  renderer=new THREE.WebGPURenderer(outputRendererOptions(hdr.supported));await renderer.init();renderer.setSize(240,160);
  renderer.toneMapping=THREE.NoToneMapping;renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.backend.device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
  const scene=new THREE.Scene();scene.fog=new THREE.FogExp2('#dce3d5',.0065);scene.background=new THREE.Color();
  const camera=new THREE.PerspectiveCamera(40,1.5,.15,450);camera.position.set(0,2,5);camera.lookAt(0,0,0);
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1,24,16),new THREE.MeshStandardNodeMaterial({color:0x888888,roughness:.5})));
  daylight=createDaylight(scene,renderer,{details:{lamps:[],emissiveSources:[]},invalidate(){}});
  const exposure=uniform(1),scenePass=pass(scene,camera,{type:THREE.HalfFloatType});
  const beauty=scenePass.getTextureNode();
  pipeline=new THREE.RenderPipeline(renderer);pipeline.outputNode=displayOutputNode(beauty,exposure,hdr.supported);
  for(const hour of [12,0,12,5.5,12,18,0]){
    await new Promise(requestAnimationFrame);
    // No debounce wait: test exactly the first frame following each time input.
    daylight.update({hour,date:'2026-09-26'});exposure.value=renderer.toneMappingExposure;pipeline.render();
    const range=await captureCanvasRange(renderer);rows.push({hour,range});
    if(range.nonFinite||range.aboveWhitePixels>range.width*range.height*.25)throw new Error(`Time ${hour}: first-frame whiteout or nonfinite output`);
  }
  if(errors.length)throw new Error(errors.join('\n'));
  const data={passed:true,hdr:hdr.supported,rows,errors};out.textContent=JSON.stringify(data,null,2);window.__daylightTest=data;document.body.dataset.passed='true';
}catch(error){const data={passed:false,error:String(error),rows,errors};out.textContent=JSON.stringify(data,null,2);window.__daylightTest=data;document.body.dataset.passed='false';}
finally{pipeline?.dispose();daylight?.dispose();renderer?.dispose();}
