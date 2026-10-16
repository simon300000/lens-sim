import * as THREE from 'three/webgpu';
import {createLensRig,emissivePanel} from './gpu-fixtures.js';
const report={kind:'default-pupil',browser:navigator.userAgent,timingKind:'correctness only, no performance measurements',errors:[],passed:false};let renderer,rig;
const check=(v,m)=>{if(!v)throw Error(m);};
try{
 renderer=new THREE.WebGPURenderer();await renderer.init();renderer.setSize(48,32);const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(40,1.5,.01,100);camera.updateMatrixWorld();emissivePanel(scene,{z:-1});
 rig=await createLensRig({renderer,scene,camera,width:48});rig.interop.device.addEventListener('uncapturederror',e=>report.errors.push(e.error.message));
 const lens=(await(await fetch('/lenses/7artisans-af-135mm-f1-8-max.json')).json()).configurations[0],state={sensorZMm:lens.sensorZMm};
 rig.engine.setLens(lens,state);const table=rig.engine.pupilTable;
 check(table.movingCenter&&table.bins===128&&table.globalMix===.05,'Wrong engine pupil defaults');
 rig.engine.updateOptics({...state,pupilMovingCenter:false});check(!rig.engine.pupilTable.movingCenter,'Fixed opt-out broken');
 rig.engine.updateOptics(state);check(rig.engine.pupilTable===table,'Default/cache restoration broken');
 for(let i=0;i<256;i+=4){rig.engine.sample({batchSpp:4,targetSpp:256,seed:505,constantEnvironment:[1,1,1]});if(i%64===0)await rig.interop.device.queue.onSubmittedWorkDone();}
 const stats=await rig.engine.statistics();check(stats.attemptedSamples===48*32*256&&stats.opticalPassRate>0,'Attempt count/throughput mismatch');
 rig.engine.resolve();const image=await rig.interop.readTexture(rig.engine.outputGPU);check(image.every(Number.isFinite),'Nonfinite HDR output');check(!report.errors.length,report.errors.join('\n'));
 report.defaults={movingCenter:table.movingCenter,bins:table.bins,globalMix:table.globalMix};report.stats=stats;report.passed=true;
}catch(e){report.error=e.stack;}
finally{if(rig){rig.engine.dispose();rig.sceneResources.dispose();rig.lighting.dispose();rig.interop.dispose();}renderer?.dispose();document.querySelector('#result').textContent=JSON.stringify(report,null,2);document.body.dataset.passed=String(report.passed);await fetch('/__pupil-report',{method:'POST',body:JSON.stringify(report)});}
