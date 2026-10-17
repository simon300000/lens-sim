import * as THREE from 'three/webgpu';
import {createLensRig,emissivePanel} from './gpu-fixtures.js';
import {traceLens} from '../src/optics/optical-reference.js';
import {sampleDimension,concentricDisk} from '../src/spectral/sampler.js';
import {spectralXYZContribution} from '../src/spectral/reconstruction.js';
const out=document.querySelector('#result');
const check=(c,m)=>{if(!c)throw new Error(m);};
const ids=['fujifilm-gf-250mm-f4-r-lm-ois-wr','hasselblad-xcd-65mm-f2-8','nikon-z-100-400mm-f4-5-5-6-vr-s','smc-pentax-da-55mm-f1-4-sdm','fujifilm-gf-23mm-f4-r-lm-wr','fujifilm-gf-30mm-f3-5-r-wr','fujifilm-xf-14mm-f2-8-r','fujifilm-xf-60mm-f2-4-r-macro'];
const report={passed:false,userAgent:navigator.userAgent,visibility:document.visibilityState,focused:document.hasFocus(),cases:[],failures:[],errors:[]};
try{
  const renderer=new THREE.WebGPURenderer({antialias:false});await renderer.init();renderer.setSize(480,320);document.body.appendChild(renderer.domElement);
  const camera=new THREE.PerspectiveCamera(40,1.5,.02,450);camera.updateMatrixWorld();
  const scene=new THREE.Scene();emissivePanel(scene,{z:-10});
  const {engine,interop}=await createLensRig({renderer,scene,camera,width:48});
  interop.device.addEventListener('uncapturederror',e=>report.errors.push(e.error.message));
  const W=48,H=32,SPP=128,seed=214;
  for(const id of ids){
    const asset=await(await fetch(`/lenses/${id}.json`)).json();
    for(let index=0;index<asset.configurations.length;index++){
      out.textContent=`Checking ${id} #${index}…`;
      const lens=asset.configurations[index];check(lens,`${id} #${index} unavailable`);
      const packed=engine.setLens(lens,{sensorZMm:lens.sensorZMm,dispersion:false});
      check(packed.region.directional,'native gap must use full hemisphere');
      check(packed.sensorZMm===lens.sensorZMm,'prescribed sensor was moved');
      // The f64 reference below uses independent per-pixel sample keys. Do not
      // compare that finite sample sequence with the shared mirror estimator.
      for(let i=0;i<SPP/4;i++)engine.sample({batchSpp:4,targetSpp:SPP,seed,constantEnvironment:[1,1,1],mirrorReuse:false});
      const raw=await engine.readAccumulation(),f=new Float32Array(raw),u=new Uint32Array(raw);let sumY=0;
      for(let p=0;p<W*H;p++){check(u[p*16+3]===SPP,'fixed attempt budget changed');sumY+=f[p*16+1]/SPP;}
      const stats=await engine.statistics();
      report.currentCase={id,index,...stats};
      const row={id,index,gapMm:packed.sensorZMm-lens.lastVertexZMm,sensorZMm:packed.sensorZMm,meanY:sumY/(W*H),...stats};
      report.cases.push(row);
      if(stats.opticalPassRate<=0||stats.numericalErrorRate!==0||!Number.isFinite(sumY)||sumY<=0)report.failures.push(row);
    }
  }
  // Independent f64 integrand on the SAME deterministic samples of a real
  // cover-glass lens. Compare radiometry, including the hemisphere PDF, not
  // merely parser support or absence of shader compilation errors.
  const id='hasselblad-xcd-65mm-f2-8',lens=(await(await fetch(`/lenses/${id}.json`)).json()).configurations[0];
  const packed=engine.setLens(lens,{sensorZMm:lens.sensorZMm,dispersion:false});
  let cpuY=0,passed=0;
  for(let pixel=0;pixel<W*H;pixel++)for(let i=0;i<SPP;i++){
    const x=pixel%W,y=Math.floor(pixel/W),u=(x+sampleDimension(pixel,i,0,seed))/W,v=(y+sampleDimension(pixel,i,1,seed))/H;
    const xy=concentricDisk(sampleDimension(pixel,i,2,seed),sampleDimension(pixel,i,3,seed));
    const direction=[...xy,-Math.sqrt(Math.max(0,1-xy[0]*xy[0]-xy[1]*xy[1]))];
    const ray=traceLens(lens,[-(u-.5)*36,(v-.5)*24,lens.sensorZMm],direction,{dispersion:false,stopRadiusMm:packed.stopRadiusMm});
    if(ray.status!==0)continue;
    const wavelength=380+400*sampleDimension(pixel,i,4,seed);
    cpuY+=spectralXYZContribution([1,1,1],wavelength,1/400,4)[1];passed++;
  }
  cpuY/=W*H*SPP;
  const gpu=report.cases.find(c=>c.id===id&&c.index===0);
  report.radiometry={cpuY,gpuY:gpu.meanY,relativeError:Math.abs(cpuY-gpu.meanY)/cpuY,cpuPassed:passed,gpuPassed:gpu.opticalPassRate*W*H*SPP};
  check(report.radiometry.relativeError<.01,'CPU/GPU full integrand radiometry differs >1%');
  check(report.failures.length===0,`${report.failures.length} native configurations have numerical errors or zero/nonfinite signal`);
  check(report.errors.length===0,'GPU validation errors');
  report.passed=true;engine.dispose();renderer.dispose();
}catch(error){report.error=String(error)+"\n"+(error.stack??"");console.error(error);}
report.finishedVisibility=document.visibilityState;report.finishedFocused=document.hasFocus();
out.textContent=JSON.stringify(report,null,2);document.body.dataset.passed=String(report.passed);window.__nativeGapReport=report;
await fetch('/__native_report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report,null,2)}).catch(()=>{});
