import * as THREE from 'three/webgpu';
import { pass, uv, step, float, vec3, vec4 } from 'three/tsl';
import { probeHDRCanvas,outputRendererOptions,displayOutputNode } from '../src/hdr-output.js';

async function readTexture(device,texture) {
  const half=texture.format==='rgba16float';
  const buffer=device.createBuffer({size:256,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  const encoder=device.createCommandEncoder();
  encoder.copyTextureToBuffer({texture},{buffer,bytesPerRow:256},{width:3,height:1});
  device.queue.submit([encoder.finish()]);
  try{
    await buffer.mapAsync(GPUMapMode.READ);
    const bytes=buffer.getMappedRange();
    const a=half?new Uint16Array(bytes):new Uint8Array(bytes);
    return [0,4,8].map(i=>half?THREE.DataUtils.fromHalfFloat(a[i]):a[i]/255);
  }finally{buffer.unmap();buffer.destroy();}
}

async function checkPath(hdr) {
  const renderer=new THREE.WebGPURenderer({alpha:false,antialias:false,...outputRendererOptions(hdr)});
  renderer.toneMapping=THREE.NoToneMapping;renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.setSize(3,1);await renderer.init();
  const failures=[];
  renderer.backend.device.addEventListener('uncapturederror',e=>failures.push(e.error.message));
  document.body.appendChild(renderer.domElement);
  const material=new THREE.MeshBasicNodeMaterial();
  const value=float(.18).add(step(1/3,uv().x).mul(.82)).add(step(2/3,uv().x).mul(3));
  material.colorNode=vec3(value);
  const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-1,1,1,-1,0,2);
  camera.position.z=1;scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2),material));
  const scenePass=pass(scene,camera,{type:THREE.HalfFloatType});
  scenePass.renderTarget.texture.colorSpace=THREE.LinearSRGBColorSpace;
  const pipeline=new THREE.RenderPipeline(renderer);
  pipeline.outputNode=displayOutputNode(scenePass.getTextureNode('output'),float(1),hdr);
  pipeline.render();
  const context=renderer.backend.context,configuration=context.getConfiguration();
  const canvasPixels=readTexture(renderer.backend.device,context.getCurrentTexture());
  const sceneTexture=renderer.backend.get(scenePass.renderTarget.texture).texture;
  const intermediatePixels=readTexture(renderer.backend.device,sceneTexture);
  const result={requestedHDR:hdr,configuration:{format:configuration.format,colorSpace:configuration.colorSpace,
    mode:configuration.toneMapping?.mode},intermediate:await intermediatePixels,output:await canvasPixels,failures};
  if(Math.abs(result.intermediate[2]-4)>.01)throw new Error('HDR intermediate was clipped');
  if(hdr){
    const expected=[.18,1,4].map(v=>v<=.0031308?12.92*v:1.055*v**(1/2.4)-.055);
    for(let i=0;i<3;i++)if(Math.abs(result.output[i]-expected[i])>.004)throw new Error('HDR encoding/exposure mismatch');
  }else if(result.output.some(v=>v>1)||result.output[2]<.9)throw new Error('SDR ACES output mismatch');
  if(failures.length)throw new Error('WebGPU validation failed');
  pipeline.dispose();renderer.dispose();return result;
}

try{
  const adapter=await navigator.gpu.requestAdapter();
  const support=await probeHDRCanvas(adapter);
  const result={support,paths:[],passed:false};
  if(support.supported)result.paths.push(await checkPath(true));
  result.paths.push(await checkPath(false));
  result.passed=true;
  document.querySelector('#result').textContent=JSON.stringify(result,null,2);
  document.body.dataset.passed='true';
}catch(error){document.querySelector('#result').textContent=String(error.stack||error);document.body.dataset.passed='false';}
