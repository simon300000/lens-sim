import * as THREE from 'three/webgpu';
import {pass,mrt,normalView,vec4,builtinAOContext,Fn,float} from 'three/tsl';
import {woodMat} from '../src/kit.js';
import {applyWaterSurface} from '../src/scene/procedural-materials.js';
import {installNormalPassReuse} from '../src/rendering/pass-reuse.js';
import {createGPUInterop} from '../src/rendering/three-interop.js';
import {createLightingResources} from '../src/rendering/lighting-resources.js';
import {createPupilPrecomputer} from '../src/optics/pupil-precompute.js';
import {buildPupilTable} from '../src/optics/pupil-sampling.js';
import {packLens} from '../src/optics/lens-state.js';
const report={kind:'startup-reuse-gpu',userAgent:navigator.userAgent,errors:[],passed:false,normal:[],reflection:[]};
let renderer,interop,reuse,lighting,precomputer;const check=(ok,text)=>{if(!ok)throw Error(text);};
function compare(a,b){check(a.length===b.length,'Image dimensions changed');let max=0,different=0,nonzero=0;for(let i=0;i<a.length;i++){check(Number.isFinite(a[i]+b[i]),'Nonfinite pixel');const d=Math.abs(a[i]-b[i]);max=Math.max(max,d);if(d>0)different++;if(Math.abs(a[i])>.001)nonzero++;}return {max,different,nonzero};}
try{
 renderer=new THREE.WebGPURenderer({antialias:false});await renderer.init();renderer.setSize(192,128);renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
 document.body.append(renderer.domElement);interop=createGPUInterop(renderer);interop.device.addEventListener('uncapturederror',e=>report.errors.push(e.error.message));
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(40,1.5,.1,50);camera.position.set(4,3,5);camera.lookAt(0,.5,0);camera.updateMatrixWorld();
 const sun=new THREE.DirectionalLight(0xffffff,3);sun.position.set(3,5,2);sun.castShadow=true;sun.shadow.mapSize.set(256,256);scene.add(sun,new THREE.HemisphereLight(0x8899bb,0x333322,1));
 const wood=woodMat(),box=new THREE.Mesh(new THREE.BoxGeometry(1.8,1.2,1.3),wood);box.position.y=.7;box.castShadow=box.receiveShadow=true;scene.add(box);
 const floor=new THREE.Mesh(new THREE.PlaneGeometry(8,8),new THREE.MeshStandardNodeMaterial({color:0x778877,roughness:.9}));floor.rotation.x=-Math.PI/2;floor.receiveShadow=true;scene.add(floor);
 const water=new THREE.Mesh(new THREE.PlaneGeometry(2.8,2.8).rotateX(-Math.PI/2),new THREE.MeshPhysicalNodeMaterial({transparent:true,opacity:.4,side:THREE.DoubleSide,depthWrite:false,clearcoat:1}));water.position.set(1.4,.05,1.3);water.receiveShadow=true;scene.add(water);const mirror=applyWaterSurface(water);
 const old=pass(scene,camera,{type:THREE.HalfFloatType});old.setMRT(mrt({output:normalView}));
 const newer=pass(scene,camera,{type:THREE.HalfFloatType}),normalMRT=mrt({output:normalView});newer.setMRT(normalMRT);
 const oldPipeline=new THREE.RenderPipeline(renderer),newPipeline=new THREE.RenderPipeline(renderer);oldPipeline.outputNode=vec4(old.getTextureNode('output').rgb,1);newPipeline.outputNode=vec4(newer.getTextureNode('output').rgb,1);
 reuse=installNormalPassReuse({renderer,normalMRT,beautyTarget:null,camera});
 for(let view=0;view<3;view++){
  camera.position.x=4-view;camera.lookAt(0,.5,0);camera.updateMatrixWorld();sun.shadow.needsUpdate=true;
  await new Promise(requestAnimationFrame);oldPipeline.render();await interop.device.queue.onSubmittedWorkDone();const a=await interop.readTexture(interop.texture(old.renderTarget.texture));
  await new Promise(requestAnimationFrame);newPipeline.render();await interop.device.queue.onSubmittedWorkDone();const b=await interop.readTexture(interop.texture(newer.renderTarget.texture));
  const diff=compare(a,b);report.normal.push({view,...diff});check(diff.max===0&&diff.nonzero>1000,'Wood/water normal prepass changed');
 }
 reuse.dispose();reuse=null;
 const baseContext=renderer.contextNode,mainAO=float(.2),cameraAO=Fn(builder=>builder.camera===camera?mainAO:float(1))();
 const beautyContext=builtinAOContext(cameraAO);
 lighting=createLightingResources({interop,renderer,scene,camera,refreshContext:()=>beautyContext});
 const target=new THREE.RenderTarget(16,11,{type:THREE.HalfFloatType});
 async function reflection(){const base=mirror.reflector,virtual=base.virtualCameras.get(camera),rt=base.renderTargets.get(virtual);return interop.readTexture(interop.texture(rt.texture));}
 for(let change=0;change<3;change++){
  camera.position.x=3-change*.7;camera.lookAt(0,.5,0);camera.updateMatrixWorld();sun.position.x=3-change*2;sun.intensity=3-change*.8;sun.shadow.needsUpdate=true;
  // Legacy full refresh has no view-space AO. New sparse refresh must match it.
  renderer.contextNode=baseContext;renderer.setRenderTarget(target);renderer.render(scene,camera);renderer.setRenderTarget(null);await interop.device.queue.onSubmittedWorkDone();const a=await reflection();
  sun.shadow.needsUpdate=true;lighting.refresh();await interop.device.queue.onSubmittedWorkDone();const b=await reflection();
  const diff=compare(a,b);report.reflection.push({change,...diff,status:lighting.status});check(diff.max===0&&lighting.status.ok,'Sparse refresh changed reflected radiance');
 }
 const asset=await(await fetch('/lenses/canon-fl-50mm-f1-8.json')).json(),lens=asset.configurations[0],packed=packLens(lens,{sensorZMm:lens.sensorZMm,dispersion:true});
 precomputer=createPupilPrecomputer();const table=await precomputer.prepare(lens,packed),reference=buildPupilTable(structuredClone(lens),packed);
 check(table.data.every((v,i)=>Object.is(v,reference.data[i])),'Worker pupil table differs from synchronous physical tracing');
 report.pupil={bins:table.bins,movingCenter:table.movingCenter,globalMix:table.globalMix,workerBuildMs:table.buildMs,bytewiseEqual:true};
 check(!report.errors.length,report.errors.join('\n'));report.passed=true;
}catch(error){report.error=String(error)+'\n'+(error.stack||'');}
finally{
 precomputer?.dispose();reuse?.dispose();lighting?.dispose();interop?.dispose();renderer?.dispose();
 window.__reuseReport=report;document.querySelector('#result').textContent=JSON.stringify(report,null,2);document.body.dataset.passed=String(report.passed);
 await fetch('http://127.0.0.1:5175/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)}).catch(()=>{});
}
