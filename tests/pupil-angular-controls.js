import * as THREE from 'three/webgpu';
import {createLensRig,emissivePanel} from './gpu-fixtures.js';
const report={kind:'angular-controls',passed:false,browser:navigator.userAgent,timingKind:'correctness only; timings intentionally omitted',results:[],errors:[]};let renderer,rig;
try{
 renderer=new THREE.WebGPURenderer();await renderer.init();renderer.setSize(48,32);
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(40,1.5,.01,100);camera.updateMatrixWorld();emissivePanel(scene,{z:-1});rig=await createLensRig({renderer,scene,camera,width:48});
 rig.interop.device.addEventListener('uncapturederror',e=>report.errors.push(e.error.message));
 for(const [id,sensorMm]of [['fujifilm-xf-14mm-f2-8-r',[23.6,15.6]],['hasselblad-xcd-65mm-f2-8',[44,33]]]){
  const lens=(await(await fetch(`/lenses/${id}.json`)).json()).configurations[0],images=[];let stats;
  for(const pupilMovingCenter of [false,true]){
   const p=rig.engine.setLens(lens,{sensorZMm:lens.sensorZMm,sensorMm,pupilBins:128,pupilMovingCenter});
   if(!p.region.directional||rig.engine.pupilTable.enabled)throw Error('Native angular sampler was replaced');
   for(let i=0;i<512;i+=4){rig.engine.sample({batchSpp:4,targetSpp:512,seed:505,constantEnvironment:[1,1,1]});if(i%64===0)await rig.interop.device.queue.onSubmittedWorkDone();}
   images.push(new Uint32Array(await rig.engine.readAccumulation()));stats=await rig.engine.statistics();
  }
  let differentWords=0;for(let i=0;i<images[0].length;i++)if(images[0][i]!==images[1][i])differentWords++;
  report.results.push({id,sensorMm,directional:true,pupilEnabled:false,differentWords,stats});if(differentWords||!stats.opticalPassRate)throw Error('Angular control mismatch or zero throughput');
 }
 if(report.errors.length)throw Error(report.errors.join('\n'));report.passed=true;
}catch(e){report.error=e.stack;}
finally{if(rig){rig.engine.dispose();rig.sceneResources.dispose();rig.lighting.dispose();rig.interop.dispose();}renderer?.dispose();document.querySelector('#result').textContent=JSON.stringify(report,null,2);document.body.dataset.passed=String(report.passed);await fetch('/__pupil-report',{method:'POST',body:JSON.stringify(report)});}
