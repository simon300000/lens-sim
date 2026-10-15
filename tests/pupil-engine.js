// Full production scene/spectrum/HDR path acceptance. The separate pupil-gpu
// page provides timestamped fixed-ray measurements and independent references.
import * as THREE from 'three/webgpu';
import {createLensRig,emissivePanel} from './gpu-fixtures.js';
import {xyzToRGB} from '../src/spectral/reconstruction.js';
const result=document.querySelector('#result'),check=(v,m)=>{if(!v)throw new Error(m);};
let rig,renderer;const errors=[];
try{
  renderer=new THREE.WebGPURenderer();await renderer.init();renderer.setSize(96,64);
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(40,1.5,.01,100);camera.updateMatrixWorld();
  // Defocused finite bright point, sampled through actual scene BVH geometry.
  emissivePanel(scene,{z:-1,w:.035,h:.035,color:[10,10,10]});
  rig=await createLensRig({renderer,scene,camera,width:48});const {engine,interop}=rig;const {device}=interop;
  device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
  const lens=(await(await fetch('/lenses/zeiss-otus-55mm-f1-4.json')).json()).configurations[0];
  const state={sensorZMm:lens.lastVertexZMm+1.373,dispersion:false};
  async function render(enabled,spp,env){
    engine.setLens(lens,{...state,pupilSampling:enabled});
    const table=engine.pupilTable,started=performance.now();
    camera.position.x=.001;engine.setPose(camera);engine.reset();rig.lighting.refresh();engine.bindScene();
    check(engine.pupilTable===table,'Camera/scene operation rebuilt pupil cache');
    for(let i=0;i<spp;i+=4){if(i%8192===0)result.textContent=`${env?'White':'Point'} / ${enabled?'importance':'original'} ${i}/${spp} spp`;engine.sample({batchSpp:4,targetSpp:spp,seed:77,constantEnvironment:env});if(i%64===0)await device.queue.onSubmittedWorkDone();}
    const a=await engine.readAccumulation(),f=new Float32Array(a),u=new Uint32Array(a),rgb=[];
    let attempts=0,passed=0;for(let i=0;i<f.length;i+=16){attempts+=u[i+3];passed+=u[i+10];rgb.push(...xyzToRGB(Array.from(f.slice(i,i+3)).map(x=>x/u[i+3])));}
    check(attempts===48*32*spp,'Attempt normalization changed');
    engine.resolve();const tex=await interop.readTexture(engine.outputGPU);check(tex.every(Number.isFinite),'Nonfinite HDR output');
    return {wallMs:performance.now()-started,rgb,attempts,passRate:passed/attempts,stats:await engine.statistics()};
  }
  // Compare integrated flux/shape. The sparse global point estimate needs a
  // larger attempt budget; these are correctness runs, not timing comparisons.
  result.textContent='White HDR image comparison…';
  const whiteA=await render(false,2048,[1,1,1]),whiteB=await render(true,2048,[1,1,1]);
  const mean=a=>a.reduce((s,x)=>s+x,0)/a.length,whiteRatio=mean(whiteB.rgb)/mean(whiteA.rgb);
  check(Math.abs(whiteRatio-1)<.08,`White radiance changed ${whiteRatio}`);
  result.textContent='Defocused point geometry / bokeh comparison…';
  const pointA=await render(false,262144,null),pointB=await render(true,16384,null),pointRatio=mean(pointB.rgb)/mean(pointA.rgb);
  check(Math.abs(pointRatio-1)<.12,`Point emitter flux changed ${pointRatio}; hits ${JSON.stringify([pointA.stats,pointB.stats])}`);
  const shape=a=>{let flux=0,x=0,y=0,xx=0,yy=0;for(let j=0;j<32;j++)for(let i=0;i<48;i++){const v=a[(j*48+i)*3+1];flux+=v;x+=i*v;y+=j*v;xx+=i*i*v;yy+=j*j*v;}return {flux,x:x/flux,y:y/flux,xx:xx/flux,yy:yy/flux};};
  const sa=shape(pointA.rgb),sb=shape(pointB.rgb);check(Math.abs(sa.x-sb.x)<.5&&Math.abs(sa.y-sb.y)<.5,'Bokeh centre moved');
  check(Math.abs(sa.xx/sb.xx-1)<.08&&Math.abs(sa.yy/sb.yy-1)<.08,'Bokeh shape changed');
  const pointL1=pointA.rgb.reduce((s,v,i)=>s+Math.abs(v-pointB.rgb[i]),0)/pointB.rgb.reduce((s,v)=>s+Math.abs(v),0);
  const debug=document.createElement('pre');debug.id='diagnostic';debug.textContent=JSON.stringify({whiteRatio,pointRatio,pointL1,pointStats:[pointA.stats,pointB.stats],pointWallMs:[pointA.wallMs,pointB.wallMs],originalPoint:sa,importancePoint:sb});document.body.appendChild(debug);
  check(pointL1<.4,`Point spread image changed ${pointL1}`);
  const c=document.createElement('canvas');c.width=96;c.height=32;const cx=c.getContext('2d'),image=cx.createImageData(96,32);
  for(let y=0;y<32;y++)for(let x=0;x<96;x++){const rgb=(x<48?pointA:pointB).rgb,offset=(y*48+x%48)*3;for(let k=0;k<3;k++)image.data[(y*96+x)*4+k]=Math.pow(Math.max(0,rgb[offset+k])/(1+Math.max(0,rgb[offset+k])),1/2.2)*255;image.data[(y*96+x)*4+3]=255;}
  cx.putImageData(image,0,0);document.body.appendChild(c);
  check(!errors.length,errors.join('\n'));
  result.textContent=JSON.stringify({passed:true,whiteRatio,pointRatio,pointL1,pointWallMs:[pointA.wallMs,pointB.wallMs],pointAttemptedSpp:[262144,16384],timingKind:'queue-complete render/resolve/readback wall time, cached pupil; correctness runs have different sample budgets, not an equal-quality speedup',originalPoint:sa,importancePoint:sb,whitePassRates:[whiteA.passRate,whiteB.passRate],pointStats:[pointA.stats,pointB.stats],errors},null,2);document.body.dataset.passed='true';
}catch(error){result.textContent=JSON.stringify({passed:false,error:error.stack,errors});document.body.dataset.passed='false';}
finally{rig?.engine.dispose();rig?.sceneResources.dispose();rig?.lighting.dispose();rig?.interop.dispose();renderer?.dispose();}
