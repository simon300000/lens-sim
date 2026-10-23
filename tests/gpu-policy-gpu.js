import * as THREE from 'three/webgpu';
import {createThreeInterop,cameraPose} from '../src/rendering/three-interop.js';
import {createSceneResources} from '../src/rendering/scene-resources.js';
import {createLightingResources} from '../src/rendering/lighting-resources.js';
import {createOpticalEngine} from '../src/rendering/optical-engine.js';
import {createGardenProvider} from '../src/rendering/garden-provider.js';
import {requiredGPULimits} from '../src/rendering/gpu-policy.js';
import {exportLensTexture} from '../src/rendering/image-export.js';
const check=(v,m)=>{if(!v)throw Error(m);},out=document.querySelector('#out');
document.querySelector('#run').onclick=async()=>{
 document.querySelector('#run').disabled=true;let renderer,interop,sceneResources,lighting,engine;const errors=[];let report;
 try{
  const adapter=await navigator.gpu.requestAdapter();renderer=new THREE.WebGPURenderer({requiredLimits:requiredGPULimits(adapter.limits)});await renderer.init();renderer.setSize(96,64);
  interop=createThreeInterop(renderer,{memoryBudget:{budgetBytes:128*1024**2,reserveBytes:8*1024**2}});
  interop.device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(40,1.5,.1,100);camera.updateMatrixWorld();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.MeshStandardNodeMaterial({color:0xffffff})));
  sceneResources=createSceneResources({interop,scene,camera});await sceneResources.build();lighting=createLightingResources({interop,renderer,scene,camera});lighting.refresh();
  engine=await createOpticalEngine({interop,sceneResources,provider:createGardenProvider({lighting,materials:sceneResources}),width:96});
  const lens=(await(await fetch('/lenses/canon-fl-50mm-f1-8.json')).json()).configurations[0];engine.setLens(lens,{sensorZMm:lens.sensorZMm,pupilSampling:false});engine.setPose(cameraPose(camera));
  const budget=interop.memoryBudget,before=interop.liveBuffers,dimensions=engine.dimensions;
  const pressure=()=>budget.reserve(budget.snapshot.availableBytes-32,'Test allocation pressure');
  let token=pressure(),rejected=false;
  try{await engine.resizeChecked(480);}catch(e){rejected=e.message.includes('预算不足');}budget.release(token);
  check(rejected&&JSON.stringify(engine.dimensions)===JSON.stringify(dimensions)&&interop.liveBuffers===before,'Rejected resize changed valid resources');
  token=pressure();rejected=false;try{await engine.statistics();}catch(e){rejected=e.message.includes('预算不足');}budget.release(token);
  check(rejected,'Statistics ignored replacement/readback peak');check(await engine.statistics()!==null,'Statistics promise did not recover after allocation rejection');
  const buffers=sceneResources.buffers;token=pressure();rejected=false;
  try{await sceneResources.build('budget-regression');}catch(e){rejected=e.message.includes('预算不足');}budget.release(token);
  check(rejected&&sceneResources.buffers===buffers&&sceneResources.ready&&interop.liveBuffers===before,'Rejected BVH replacement damaged old state');
  const pending=engine.statistics();engine.reset();check(await pending===null,'Reset returned stale statistics');
  for(let i=0;i<3;i++)await engine.statistics();check(interop.liveBuffers===before,'Statistics retained temporary buffers');
  token=pressure();rejected=false;try{await exportLensTexture({interop,texture:engine.outputGPU,exposure:1});}catch(e){rejected=e.message.includes('预算不足');}budget.release(token);
  check(rejected&&interop.liveBuffers===before,'PNG staging ignored budget or leaked');
  const png=await exportLensTexture({interop,texture:engine.outputGPU,exposure:1});check(png.size>0&&interop.liveBuffers===before,'PNG export retained staging');
  await interop.device.queue.onSubmittedWorkDone();check(!errors.length,errors.join('\n'));
  engine.dispose();sceneResources.dispose();lighting.dispose();interop.dispose();check(budget.snapshot.managedBytes===0,'Managed allocation survived dispose');
  report={passed:true,memory:budget.snapshot,errors};
 }catch(e){report={passed:false,error:e.message+'\n'+e.stack,errors};}
 finally{engine?.dispose();sceneResources?.dispose();lighting?.dispose();interop?.dispose();renderer?.dispose();out.textContent=JSON.stringify(report,null,2);document.querySelector('#run').disabled=false;if(new URLSearchParams(location.search).has('save'))await fetch('/__integration?name=budget.json',{method:'POST',body:JSON.stringify(report)});}
};
