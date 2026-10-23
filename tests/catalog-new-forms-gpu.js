import * as THREE from 'three/webgpu';
import {createLensRig,emissivePanel} from './gpu-fixtures.js';
import {traceLens} from '../src/optics/optical-reference.js';
import {normalizeAsphere} from '../src/optics/lens-state.js';
import {sampleDimension,concentricDisk} from '../src/spectral/sampler.js';
const out=document.querySelector('#result'),check=(c,m)=>{if(!c)throw new Error(m);};
const report={passed:false,cases:[],errors:[],userAgent:navigator.userAgent,visibility:document.visibilityState,focused:document.hasFocus()};
let engine,renderer;
// Missing physical aperture data cannot prove a ray is physically blocked
// outside a conic's finite primary domain. Retain status 3. Only accept such
// diagnostic rows when independent f64 tracing accounts for EVERY numerical
// GPU result, by pixel, at an explicitly unknown/truncated surface domain.
function verifyUnknownDomain(lens,packed,u,spp){
  let checkedPixels=0,gpuNumerical=0,cpuUnknown=0;
  for(let pixel=0;pixel<48*32;pixel++){
    const gpu=u[pixel*16+6];if(!gpu)continue;
    checkedPixels++;gpuNumerical+=gpu;let pixelUnknown=0;
    for(let i=0;i<spp;i++){
      const dim=d=>sampleDimension(pixel,i,d,185),x=pixel%48,y=Math.floor(pixel/48);
      let point=[-((x+dim(0))/48-.5)*36,((y+dim(1))/32-.5)*24,packed.sensorZMm];
      const disk=concentricDisk(dim(2),dim(3));
      let direction=packed.region.directional?[...disk,-Math.sqrt(Math.max(0,1-disk[0]**2-disk[1]**2))]:[disk[0]*packed.region.radiusMm-point[0],disk[1]*packed.region.radiusMm-point[1],packed.region.zMm-point[2]];
      for(const surface of [...lens.surfaces].reverse()){
        const ray=traceLens({...lens,surfaces:[surface]},point,direction,{wavelengthNm:380+400*dim(4),stopRadiusMm:packed.stopRadiusMm});
        if(ray.status!==0){
          const primaryRadius=surface.radiusMm&&surface.conic>-1?Math.abs(surface.radiusMm)/Math.sqrt(1+surface.conic):Infinity;
          if(ray.status===3&&surface.apertureRadiusMm===null&&primaryRadius<normalizeAsphere(surface).numericalRadiusMm)pixelUnknown++;
          break;
        }
        point=ray.point;direction=ray.direction;
      }
    }
    if(pixelUnknown!==gpu)return {verified:false,checkedPixels,gpuNumerical,cpuUnknown,pixel,gpu,pixelUnknown};
    cpuUnknown+=pixelUnknown;
  }
  return {verified:gpuNumerical>0,checkedPixels,gpuNumerical,cpuUnknown};
}
try{
  renderer=new THREE.WebGPURenderer({antialias:false});await renderer.init();renderer.setSize(480,320);document.body.appendChild(renderer.domElement);
  const scene=new THREE.Scene();emissivePanel(scene,{z:-10});
  const camera=new THREE.PerspectiveCamera(40,1.5,.02,450);camera.updateMatrixWorld();
  const rig=await createLensRig({renderer,scene,camera,width:48});engine=rig.engine;
  rig.interop.device.addEventListener('uncapturederror',e=>report.errors.push(e.error.message));
  const manifest=await(await fetch('/lenses/manifest.json')).json();
  const families={xodd:{lenses:0,configs:0},doe:{lenses:0,configs:0}};
  const failures=[];
  for(const entry of manifest.lenses){
    // Source tags are retained in generated prescription surfaces.
    if(!entry.supported)continue;
    const asset=await(await fetch(new URL(entry.asset,new URL('/lenses/',location.href)))).json();
    const family=asset.configurations.some(l=>l?.surfaces.some(s=>s.xodd))?'xodd':asset.configurations.some(l=>l?.surfaces.some(s=>s.doe))?'doe':null;
    if(!family)continue;
    families[family].lenses++;
    for(const [index,lens]of asset.configurations.entries()){
      check(lens,`${entry.id} #${index} static unavailable`);families[family].configs++;
      out.textContent=`${family}: ${entry.name} #${index}…`;
      const packed=engine.setLens(lens,{sensorZMm:lens.sensorZMm,dispersion:true});
      // This long lens subtends a ~0.07mm accepted region in a 22mm
      // reference disk. A 32spp black image is finite-sample variance; use
      // the same deterministic sequence at a fixed, larger attempt budget.
      const spp=entry.id==='nikon-z-600mm-f4-vr-s'?1024:32;
      for(let i=0;i<spp/4;i++)engine.sample({batchSpp:4,targetSpp:spp,seed:185,constantEnvironment:[1,1,1]});
      const stats=await engine.statistics(),raw=await engine.readAccumulation(),f=new Float32Array(raw),u=new Uint32Array(raw);
      let y=0;for(let p=0;p<48*32;p++){check(u[p*16+3]===spp,'attempt budget');y+=f[p*16+1]/spp;}
      const row={family,id:entry.id,index,spp,meanY:y/(48*32),...stats};report.cases.push(row);
      if(stats.numericalErrorRate>0)row.unknownDomainDiagnostic=verifyUnknownDomain(lens,packed,u,spp);
      if((stats.numericalErrorRate!==0&&!row.unknownDomainDiagnostic?.verified)||stats.opticalPassRate===0||!Number.isFinite(y)||y<=0)failures.push(row);
    }
  }
  report.families=families;report.failures=failures;
  check(families.xodd.lenses===24&&families.xodd.configs===102,'incomplete XODD coverage');
  check(families.doe.lenses===7&&families.doe.configs===28,'incomplete DOE coverage');
  check(failures.length===0,`${failures.length} configurations have numerical errors or zero/nonfinite signal`);
  check(report.errors.length===0,'GPU validation errors');report.passed=true;
}catch(error){report.error=String(error)+'\n'+(error.stack??'');console.error(error);}
report.finishedVisibility=document.visibilityState;report.finishedFocused=document.hasFocus();
out.textContent=JSON.stringify(report,null,2);document.body.dataset.passed=String(report.passed);engine?.dispose();renderer?.dispose();
