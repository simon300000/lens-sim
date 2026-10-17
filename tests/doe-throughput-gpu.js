import * as THREE from 'three/webgpu';
import { createLensRig, emissivePanel } from './gpu-fixtures.js';
import { traceLens, add } from '../src/optics/optical-reference.js';
import { packLens } from '../src/optics/lens-state.js';
import { sampleDimension, concentricDisk } from '../src/spectral/sampler.js';
const out=document.querySelector('#result'),check=(c,m)=>{if(!c)throw new Error(m);};
const report={passed:false,cases:[],errors:[],userAgent:navigator.userAgent,visibility:document.visibilityState,focused:document.hasFocus(),startedAt:new Date().toISOString()};
let engine,renderer;
try {
  renderer=new THREE.WebGPURenderer({antialias:false});await renderer.init();renderer.setSize(480,320);document.body.appendChild(renderer.domElement);
  const scene=new THREE.Scene();emissivePanel(scene,{z:-10});
  const camera=new THREE.PerspectiveCamera(40,1.5,.02,450);camera.updateMatrixWorld();
  const rig=await createLensRig({renderer,scene,camera,width:48});engine=rig.engine;
  rig.interop.device.addEventListener('uncapturederror',e=>report.errors.push(e.error.message));
  const asset=await(await fetch('/lenses/nikon-z-600mm-f4-vr-s.json')).json();
  for(const lens of asset.configurations){
    out.textContent=`Nikon Z600 DOE cfg${lens.configurationIndex}: uniform disk 32 → 1024 spp…`;
    const packed=packLens(lens,{sensorZMm:lens.sensorZMm});
    engine.setLens(lens,{sensorZMm:lens.sensorZMm,dispersion:true,pupilSampling:false});
    const checkpoints=[];
    for(const spp of [32,1024]) {
      const previous=checkpoints.at(-1)?.spp??0;
      // Match the independent per-pixel f64 sequence below, not shared mirror samples.
      for(let i=previous;i<spp;i+=4)engine.sample({batchSpp:4,targetSpp:spp,seed:185,constantEnvironment:[1,1,1],mirrorReuse:false});
      const statistics=await engine.statistics(),raw=await engine.readAccumulation(),f=new Float32Array(raw),u=new Uint32Array(raw);
      let meanY=0;for(let pixel=0;pixel<48*32;pixel++){check(u[pixel*16+3]===spp,'fixed attempt budget');meanY+=f[pixel*16+1]/spp/(48*32);}
      checkpoints.push({spp,meanY,...statistics});
      check(statistics.numericalErrorRate===0&&Number.isFinite(meanY),'unresolved numerical/GPU failure');
    }
    // The exact same sensor jitter, disk and wavelength sequence in f64; all
    // physically blocked samples remain attempts and no new ray replaces them.
    const referenceCounts=[0,0,0,0],referenceCounts32=[0,0,0,0];
    for(let pixel=0;pixel<48*32;pixel++)for(let sample=0;sample<1024;sample++){
      const sensor=[-((pixel%48+sampleDimension(pixel,sample,0,185))/48-.5)*36,((Math.floor(pixel/48)+sampleDimension(pixel,sample,1,185))/32-.5)*24,packed.sensorZMm];
      const disk=concentricDisk(sampleDimension(pixel,sample,2,185),sampleDimension(pixel,sample,3,185));
      const reference=[disk[0]*packed.region.radiusMm,disk[1]*packed.region.radiusMm,packed.region.zMm];
      const result=traceLens(lens,sensor,add(reference,sensor,-1),{reverse:true,wavelengthNm:380+400*sampleDimension(pixel,sample,4,185),stopRadiusMm:packed.stopRadiusMm});
      referenceCounts[result.status]++;if(sample<32)referenceCounts32[result.status]++;
    }
    const final=checkpoints[1],gpuPassed=final.opticalPassRate*final.attemptedSamples;
    check(referenceCounts[0]>0&&referenceCounts[3]===0,'f64 higher-budget paths must transmit without numerical errors');
    check(final.meanY>0&&gpuPassed>0,'higher budget must recover nonzero geometric transmission and radiance');
    check(gpuPassed===referenceCounts[0],`CPU/GPU accepted path count ${referenceCounts[0]} != ${gpuPassed}`);
    report.cases.push({id:lens.id,configurationIndex:lens.configurationIndex,rearGapMm:lens.sensorZMm-lens.lastVertexZMm,rearDiskRadiusMm:packed.region.radiusMm,stopRadiusMm:packed.stopRadiusMm,checkpoints,referenceCounts32,referenceCounts1024:referenceCounts,gpuPassed});
  }
  check(report.errors.length===0,'uncaptured GPU errors');report.passed=true;
} catch(error) {report.error=String(error)+'\n'+(error.stack??'');}
report.finishedAt=new Date().toISOString();report.finishedVisibility=document.visibilityState;report.finishedFocused=document.hasFocus();
out.textContent=JSON.stringify(report,null,2);document.body.dataset.passed=String(report.passed);
await fetch('/__doe_report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report,null,2)}).catch(()=>{});
engine?.dispose();renderer?.dispose();
