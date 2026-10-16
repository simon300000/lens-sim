import * as THREE from 'three/webgpu';
import {createLensRig,stripedPanel} from './gpu-fixtures.js';
import {createFocusSolver} from '../src/optics/focus-solver.js';
import {focusedPrescription} from '../src/optics/focus-motion.js';
import {apertureLimits} from '../src/optics/lens-state.js';
const report={kind:'noct-focus',passed:false,errors:[],cases:[],userAgent:navigator.userAgent};
let renderer,rig,solver;
try{
 renderer=new THREE.WebGPURenderer({antialias:false});await renderer.init();renderer.setSize(48,32);
 const D=5.999000549316406,scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(40,1.5,.02,450);camera.updateMatrixWorld();
 stripedPanel(scene,{z:-D,w:1.5,h:1.5,stripes:32,color:[1,1,1],dim:.02});
 rig=await createLensRig({renderer,scene,camera,width:480});rig.interop.device.addEventListener('uncapturederror',e=>report.errors.push(e.error.message));
 const base=(await(await fetch('/lenses/nikon-z-58mm-f0-95-noct-s.json')).json()).configurations[0],R=apertureLimits(base).maxStopRadiusMm;
 // Reconstruct the exact retired behavior and supplied URL's sensor gap.
 const old=focusedPrescription(base,D).lens;old.sensorZMm=base.sensorZMm;old.imageDistanceMm=base.sensorZMm-old.lastVertexZMm;old.surfaces.at(-1).thicknessMm=old.imageDistanceMm;
 solver=createFocusSolver();const solved=await solver.solve(base,D,{stopRadiusMm:R,dispersion:true,currentLens:old});
 report.solve={...solved,lens:{sensorZMm:solved.lens.sensorZMm,gapMm:solved.lens.imageDistanceMm,T21:solved.lens.surfaces[21].thicknessMm}};
 for(const [name,lens] of [['old',old],['new',solved.lens]]){
  document.querySelector('#result').textContent=`Rendering ${name} at 480×320, 512 spp…`;
  const limits=apertureLimits(lens),fNumber=Math.abs(limits.focalLengthMm*limits.pupilMagnification)/(2*R),options={sensorZMm:lens.sensorZMm,fNumber,dispersion:true};
  await rig.engine.prepareLens(lens,options);rig.engine.setLens(lens,options);rig.engine.bindScene();
  for(let i=0;i<128;i++){
   rig.engine.sample({batchSpp:4,targetSpp:512,seed:217});
   if(i%4===3){await rig.interop.device.queue.onSubmittedWorkDone();await new Promise(r=>setTimeout(r,0));}
  }
  const stats=await rig.engine.statistics(),pixels=await rig.interop.readTexture(rig.engine.outputGPU);
  const canvas=document.createElement('canvas');canvas.width=480;canvas.height=320;canvas.style.width='480px';const ctx=canvas.getContext('2d'),im=ctx.createImageData(480,320);
  let finite=true;const profile=[];
  for(let x=0;x<480;x++){let sum=0;for(let y=150;y<170;y++)sum+=pixels[(y*480+x)*4+1];profile.push(sum/20);}
  // Central stripes: remove panel boundaries and compare normalized modulation.
  const central=profile.slice(182,298),mean=central.reduce((s,x)=>s+x,0)/central.length;
  const modulation=Math.sqrt(central.reduce((s,x)=>s+(x-mean)**2,0)/central.length)/mean;
  for(let i=0;i<pixels.length;i+=4){finite&&=Number.isFinite(pixels[i]+pixels[i+1]+pixels[i+2]);for(let c=0;c<3;c++)im.data[i+c]=255*Math.pow(Math.max(0,Math.min(1,pixels[i+c])),1/2.2);im.data[i+3]=255;}
  ctx.putImageData(im,0,0);const box=document.createElement('div');box.textContent=`${name}: modulation ${modulation.toFixed(3)}`;box.appendChild(canvas);document.querySelector('#images').appendChild(box);
  report.cases.push({name,gapMm:lens.imageDistanceMm,sensorZMm:lens.sensorZMm,fNumber,modulation,finite,stats,image:canvas.toDataURL('image/png')});
 }
 if(report.errors.length)throw Error(report.errors.join(';'));
 if(report.cases.some(c=>!c.finite||c.stats.bvhErrorRate>0||c.stats.radianceInvalidRate>0))throw Error('Invalid GPU output');
 if(!(report.cases[1].modulation>report.cases[0].modulation*2))throw Error('Insufficient stripe contrast improvement');
 report.passed=true;
}catch(error){report.error=error.message+'\n'+error.stack;}
finally{
 solver?.dispose();rig?.engine.dispose();rig?.sceneResources.dispose();rig?.lighting.dispose();rig?.interop.dispose();renderer?.dispose();
 document.title=`Noct focus ${report.passed?'PASS':'FAIL'}`;document.querySelector('#result').textContent=JSON.stringify({...report,cases:report.cases.map(({image,...rest})=>rest)},null,2);
 await fetch('/__chart-report',{method:'POST',body:JSON.stringify(report)}).catch(()=>{});
}
