import * as THREE from 'three/webgpu';
import {texture,float} from 'three/tsl';
import {createGPUInterop} from '../src/rendering/three-interop.js';
import {createRasterCache} from '../src/rendering/raster-cache.js';
import {displayOutputNode,outputRendererOptions,probeHDRCanvas} from '../src/hdr-output.js';

try{
  const adapter=await navigator.gpu.requestAdapter(),hdr=await probeHDRCanvas(adapter);
  const renderer=new THREE.WebGPURenderer({...outputRendererOptions(hdr.supported),antialias:false});
  await renderer.init();renderer.setSize(6,4);renderer.toneMapping=THREE.NoToneMapping;renderer.outputColorSpace=THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);
  const interop=createGPUInterop(renderer),errors=[];interop.device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
  const scene=new THREE.Scene();scene.background=new THREE.Color(4,.5,.25);
  const material=new THREE.MeshBasicNodeMaterial({color:new THREE.Color(4,.5,.25)});
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(20,20),material));
  const camera=new THREE.PerspectiveCamera(40,1.5,.02,450);camera.position.z=2;camera.updateMatrixWorld();
  const cache=createRasterCache({renderer,scene,interop,width:6});cache.capture({sourceCamera:camera,sceneRevision:1,focalLengthMm:55});
  const image=interop.storageImage(6,4);
  const code=`@group(0) @binding(0) var src:texture_2d<f32>;
  @group(0) @binding(1) var dst:texture_storage_2d<rgba16float,write>;
  @compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
    if(any(id.xy>=textureDimensions(src))){return;}
    textureStore(dst,vec2i(id.xy),textureLoad(src,vec2i(id.xy),0));}`;
  const compute=await interop.computePipeline(code,'shared-device capture compute display');
  const group=interop.device.createBindGroup({layout:compute.getBindGroupLayout(0),entries:[{binding:0,resource:cache.textures().color.createView()},{binding:1,resource:image.gpu.createView()}]});
  const encoder=interop.device.createCommandEncoder(),p=encoder.beginComputePass();p.setPipeline(compute);p.setBindGroup(0,group);p.dispatchWorkgroups(1,1);p.end();interop.device.queue.submit([encoder.finish()]);
  const pipeline=new THREE.RenderPipeline(renderer);pipeline.outputNode=displayOutputNode(texture(image.texture),float(1),hdr.supported);pipeline.render();
  const pixels=await interop.readTexture(image.gpu);if(Math.abs(pixels[0]-4)>.01)throw new Error('linear HDR beauty → compute was clipped or exposed');
  const captureBefore=cache.captures;for(let i=0;i<3;i++)pipeline.render();
  if(cache.captures!==captureBefore)throw new Error('Display retriggers raster capture');
  if(errors.length)throw new Error(errors.join('\n'));
  const result={passed:true,three:THREE.REVISION,adapter:adapter.info,captureCount:cache.captures,sameDevice:true,linearPixel:[...pixels.slice(0,4)],output:hdr,errors};
  document.querySelector('#result').textContent=JSON.stringify(result,null,2);document.body.dataset.passed='true';
  window.__chain={renderer,interop,cache,image,pipeline,result};
}catch(error){document.querySelector('#result').textContent=error.stack||String(error);document.body.dataset.passed='false';}
