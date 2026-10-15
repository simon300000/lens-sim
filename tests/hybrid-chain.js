import * as THREE from 'three/webgpu';
import {texture,float,vec3,normalWorld,mix} from 'three/tsl';
import {displayOutputNode,outputRendererOptions,probeHDRCanvas} from '../src/hdr-output.js';
import {createLensRig,emitter} from './gpu-fixtures.js';
/** Minimal integration chain on ONE GPUDevice: Three's own renderer creates a
 * shadow map and a PMREM texture -> the lens bridge binds those textures (no
 * CPU copy) -> the fused compute shades a real BVH hit -> linear HDR result
 * -> RenderPipeline display. */
const check=(c,m)=>{if(!c)throw new Error(m);};
try{
  const adapter=await navigator.gpu.requestAdapter(),hdr=await probeHDRCanvas(adapter);
  const renderer=new THREE.WebGPURenderer({...outputRendererOptions(hdr.supported),antialias:false});
  await renderer.init();renderer.setSize(96,64);renderer.toneMapping=THREE.NoToneMapping;renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;document.body.appendChild(renderer.domElement);
  const scene=new THREE.Scene();
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(6,6),new THREE.MeshStandardNodeMaterial({color:0xffffff,roughness:1}));floor.rotation.x=-Math.PI/2;floor.receiveShadow=true;scene.add(floor);
  const blocker=new THREE.Mesh(new THREE.BoxGeometry(.6,.6,.6),new THREE.MeshStandardNodeMaterial({color:0x808080}));blocker.position.set(0,.8,0);blocker.castShadow=true;scene.add(blocker);
  const hot=new THREE.Mesh(new THREE.PlaneGeometry(.5,.5),emitter([4,.5,.25]));hot.position.set(1.4,.5,-.5);scene.add(hot);
  const sun=new THREE.DirectionalLight(0xffffff,3);sun.position.set(0,5,0);sun.castShadow=true;Object.assign(sun.shadow.camera,{left:-3,right:3,top:3,bottom:-3,near:.5,far:10});scene.add(sun,sun.target);
  const sky=new THREE.Scene(),skyMat=new THREE.MeshBasicNodeMaterial({side:THREE.BackSide});skyMat.colorNode=mix(vec3(.1),vec3(.3,.4,.6),normalWorld.y.mul(-.5).add(.5));sky.add(new THREE.Mesh(new THREE.SphereGeometry(20,16,8),skyMat));
  scene.environment=new THREE.PMREMGenerator(renderer).fromScene(sky,0,.1,50,{size:32}).texture;
  const camera=new THREE.PerspectiveCamera(50,1.5,.05,50);camera.position.set(0,3.2,3.2);camera.lookAt(0,0,0);camera.updateMatrixWorld();
  const {interop,engine,lighting}=await createLensRig({renderer,scene,camera,width:96}),errors=[];
  interop.device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
  check(lighting.status.lights.directional===1&&lighting.status.environment,'shadow map / PMREM not bridged: '+JSON.stringify(lighting.status));
  check(interop.device===renderer.backend.device,'second GPUDevice');
  const lens=(await(await fetch('/lenses/canon-fl-50mm-f1-8.json')).json()).configurations[0];engine.setLens(lens,{fNumber:2.8,sensorZMm:lens.sensorZMm,dispersion:false});
  const pinhole={cameraToWorld:camera.matrixWorld.elements,clipToCamera:camera.projectionMatrixInverse.elements};
  engine.sample({batchSpp:1,targetSpp:1,pinhole});
  const pipeline=new THREE.RenderPipeline(renderer);pipeline.outputNode=displayOutputNode(texture(engine.texture),float(1),hdr.supported);pipeline.render();
  const pixels=await interop.readTexture(engine.outputGPU);
  const project=p=>{const v=new THREE.Vector3(...p).project(camera);return [Math.floor((v.x*.5+.5)*96),Math.floor((.5-v.y*.5)*64)];};
  const at=(x,y)=>pixels.slice((y*96+x)*4,(y*96+x)*4+3);
  const [hx,hy]=project([1.4,.5,-.49]),[sx,sy]=project([0,0,0]),[lx,ly]=project([-1.8,0,1.2]);
  const emissive=at(hx,hy),shadowed=at(sx,sy+1),lit=at(lx,ly);
  check(Math.abs(emissive[0]-4)<.15,'linear HDR emissive clipped or exposed: '+emissive);
  check(lit[1]>3*shadowed[1],'raster shadow map not applied in compute: lit '+lit+' shadowed '+shadowed);
  check(errors.length===0,errors.join('\n'));
  const result={passed:true,three:THREE.REVISION,adapter:adapter.info,sameDevice:true,emissiveHDR:Array.from(emissive),lit:Array.from(lit),shadowed:Array.from(shadowed),lighting:lighting.status,output:hdr,errors};
  document.querySelector('#result').textContent=JSON.stringify(result,null,2);document.body.dataset.passed='true';window.__chain={result};
}catch(error){document.querySelector('#result').textContent=error.stack||String(error);document.body.dataset.passed='false';}
