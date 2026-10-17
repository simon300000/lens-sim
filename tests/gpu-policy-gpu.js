import * as THREE from 'three/webgpu';
import {createLensRig,emissivePanel} from './gpu-fixtures.js';
import {createOpticalEngine} from '../src/rendering/optical-engine.js';
import {exportLensTexture} from '../src/rendering/image-export.js';
const check=(v,m)=>{if(!v)throw Error(m);},out=document.querySelector('#result'),errors=[];let rig,renderer,small;
try{
 renderer=new THREE.WebGPURenderer();await renderer.init();renderer.setSize(96,64);
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(40,1.5,.01,100);camera.updateMatrixWorld();emissivePanel(scene,{z:-6});
 rig=await createLensRig({renderer,scene,camera,width:99});const {engine:e,interop,sceneResources,lighting}=rig,{device,memoryBudget:b}=interop;
 device.addEventListener('uncapturederror',event=>errors.push(event.error.message));
 const lens=(await(await fetch('/lenses/canon-fl-50mm-f1-8.json')).json()).configurations[0];e.setLens(lens,{sensorZMm:lens.sensorZMm,dispersion:true});
 const pressure=()=>b.reserve(b.snapshot.availableBytes-32,'Simulated allocation pressure');
 const before=interop.liveBuffers,dimensions=e.dimensions;let token=pressure(),failed=false;
 try{await e.resizeChecked(480);}catch(error){failed=error.message.includes('预算不足');}
 check(failed&&JSON.stringify(e.dimensions)===JSON.stringify(dimensions)&&interop.liveBuffers===before,'rejected resize replaced current image or leaked resources');b.release(token);
 token=pressure();failed=false;try{await e.statistics();}catch(error){failed=error.message.includes('预算不足');}b.release(token);
 check(failed,'statistics ignored its allocation peak');check(await e.statistics()!==null,'rejected statistics left a permanently rejected pending promise');
 const oldBuffers=sceneResources.buffers;token=pressure();failed=false;try{await sceneResources.build('budget-regression');}catch(error){failed=error.message.includes('预算不足');}b.release(token);
 check(failed&&sceneResources.buffers===oldBuffers&&sceneResources.ready&&interop.liveBuffers===before,'rejected BVH replacement changed the valid scene or leaked');
 const limitedDevice=new Proxy(device,{get(target,key){if(key==='limits')return new Proxy(target.limits,{get(l,k){return k==='maxComputeWorkgroupsPerDimension'?7:Reflect.get(l,k,l);}});const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
 small=await createOpticalEngine({interop:{...interop,device:limitedDevice},sceneResources,lighting,width:480});small.setLens(lens,{sensorZMm:lens.sensorZMm,dispersion:true});small.setPose(camera);
 while(small.spp<4){small.sample({batchSpp:4,targetSpp:4,seed:7,chunked:true});await device.queue.onSubmittedWorkDone();}
 const stats=await small.statistics();check(stats.attemptedSamples===480*320*4,'2D dispatch or padded statistics blocks missed/duplicated pixels');
 small.resolve();await device.queue.onSubmittedWorkDone();const beforeExport=interop.liveBuffers;
 token=pressure();failed=false;try{await exportLensTexture({interop,texture:small.outputGPU,exposure:1});}catch(error){failed=error.message.includes('预算不足');}b.release(token);
 check(failed&&interop.liveBuffers===beforeExport,'PNG export staging ignored budget or leaked');
 const png=await exportLensTexture({interop,texture:small.outputGPU,exposure:1});check(png.type==='image/png'&&png.size>0&&interop.liveBuffers===beforeExport,'PNG export failed or retained staging');check(!errors.length,errors.join('\n'));
 small.dispose();small=null;const memory=b.snapshot;e.dispose();sceneResources.dispose();lighting.dispose();interop.dispose();
 check(b.snapshot.managedBytes===0,'managed allocations remained after dispose');
 out.textContent=JSON.stringify({passed:true,memory,stats,errors},null,2);document.body.dataset.passed='true';
}catch(error){out.textContent=JSON.stringify({passed:false,error:error.stack,errors},null,2);document.body.dataset.passed='false';}
finally{small?.dispose();rig?.engine.dispose();rig?.sceneResources.dispose();rig?.lighting.dispose();rig?.interop.dispose();renderer?.dispose();}
