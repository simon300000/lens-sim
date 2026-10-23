import * as THREE from 'three/webgpu';
import opticalCoreRaw from '../src/optics/optical-core.wgsl?raw';
import workCounters from '../src/rendering/work-counters.wgsl?raw';
const opticalCore=workCounters+opticalCoreRaw;
import {createThreeInterop,cameraPose} from '../src/rendering/three-interop.js';
import {packLens} from '../src/optics/lens-state.js';
import {traceLens,unit,add,intersectSurface,refract} from '../src/optics/optical-reference.js';
import {refractiveIndex} from '../src/optics/glass.js';
import {sampleDimension,concentricDisk} from '../src/spectral/sampler.js';
const kernel=`
struct ProbeRay {origin:vec4f,direction:vec4f,flags:vec4u}
@group(0) @binding(0) var<storage,read> opticalSurfaces:array<OpticalSurface>;
@group(0) @binding(1) var<storage,read> glassLut:array<f32>;
@group(0) @binding(2) var<uniform> optics:OpticsParameters;
@group(0) @binding(3) var<storage,read> rays:array<ProbeRay>;
@group(0) @binding(4) var<storage,read_write> results:array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
if(id.x>=arrayLength(&rays)){return;}let ray=rays[id.x];let hit=traceOptics(ray.origin.xyz,ray.direction.xyz,ray.origin.w,true);
results[2u*id.x]=vec4f(hit.p,f32(hit.status));results[2u*id.x+1u]=vec4f(hit.v,select(0.0,1.0,opticalFinite(hit.p)&&opticalFinite(hit.v)));}`;
// For ?native run node scripts/prepare-xodd-native-fixtures.mjs first.
// The temporary +0.1 mm camera setup obtains only the LUT/stop; every traced
// origin and direction uses the unchanged native sensor and cosine hemisphere.
const out=document.querySelector('#result'),query=new URLSearchParams(location.search),native=query.has('native'),spp=Number(query.get('spp')??(native?128:32)),only=query.get('lens'),seed=native?214:185;
const report={passed:false,referenceConvention:{geometry:'original source f64',rayInput:'shared GPU f32 x/y and direction',nativeSensorPlane:'original source z shared with the source t=0 interface; GPU uses coherent f32 sensor/interface pair'},userAgent:navigator.userAgent,visibility:document.visibilityState,focused:document.hasFocus(),width:48,height:32,spp,seed,nativeHemisphere:native,cases:[],errors:[]};
function numericalDetail(lens,origin,direction,nm,stopRadiusMm){
 let p=origin,d=unit(direction);
 for(const raw of [...lens.surfaces].reverse()){
  const s=raw.index===lens.stopIndex?{...raw,apertureRadiusMm:stopRadiusMm}:raw,hit=intersectSurface(s,p,d);
  if(hit.status){return {status:hit.status,surfaceIndex:s.index,apertureRadiusMm:s.apertureRadiusMm,conic:s.conic,radiusMm:s.radiusMm,numericalRadiusMm:Math.max(s.apertureRadiusMm??0,2*(s.drawRadiusMm??0),100),primaryDomainRadiusMm:s.radiusMm&&1+s.conic>0?Math.abs(s.radiusMm)/Math.sqrt(1+s.conic):null,p,d};}
  const v=refract(d,hit.normal,refractiveIndex(lens.glasses[s.mediumAfter],nm),refractiveIndex(lens.glasses[s.mediumBefore],nm));
  if(!v)return {status:2};p=hit.point;d=v;
 }
 return {status:0};
}
const save=async()=>fetch('/__xodd_report',{method:'POST',body:JSON.stringify(report,null,2)});
let renderer,interop;
try{
 renderer=new THREE.WebGPURenderer();await renderer.init();renderer.setSize(480,320);document.body.appendChild(renderer.domElement);interop=createThreeInterop(renderer);
 interop.device.addEventListener('uncapturederror',e=>report.errors.push(e.error.message));
 const pipeline=await interop.computePipeline(opticalCore+'\n'+kernel,'XODD full-frame same-ray paths'),manifest=await(await fetch(native?'/artifacts/xodd-native-manifest.json':'/lenses/manifest.json')).json();
 for(const entry of manifest.lenses){
  if(!entry.supported||(only&&entry.id!==only))continue;
  const asset=await(await fetch(new URL(entry.asset,new URL(native?'/artifacts/':'/lenses/',location.href)))).json();if(!asset.configurations.some(l=>l?.surfaces.some(s=>s.xodd)))continue;
  for(const [index,lens]of asset.configurations.entries()){
   if(!lens)continue;
   out.textContent=`${entry.id} config ${index}… ${report.cases.length} completed`;
   const packed=packLens(lens,{sensorZMm:lens.sensorZMm+(native?.1:0),dispersion:!native}),count=48*32*spp,raw=new ArrayBuffer(count*48),f=new Float32Array(raw),u=new Uint32Array(raw);
   for(let pixel=0;pixel<48*32;pixel++)for(let k=0;k<spp;k++){
    const dim=j=>sampleDimension(pixel,k,j,seed),disk=concentricDisk(dim(2),dim(3));
    const origin=[-((pixel%48+dim(0))/48-.5)*36,((Math.floor(pixel/48)+dim(1))/32-.5)*24,lens.sensorZMm];
    const direction=native?[...disk,-Math.sqrt(Math.max(0,1-disk[0]**2-disk[1]**2))]:unit(add([disk[0]*packed.region.radiusMm,disk[1]*packed.region.radiusMm,packed.region.zMm],origin,-1)),i=(pixel*spp+k)*12;
    f.set([...origin,380+400*dim(4),...direction,0],i);u[i+8]=1;
   }
   const buffers=[interop.storage(packed.surfaces,'Surfaces'),interop.storage(packed.lut.values,'LUT'),interop.uniform(packed.parameters,'Optics'),interop.storage(new Uint8Array(raw),'Rays'),interop.storage(count*32,'Results')];
   const device=interop.device;device.pushErrorScope('validation');
   try{
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:buffers.map((buffer,binding)=>({binding,resource:{buffer}}))});
    const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(count/64));pass.end();device.queue.submit([encoder.finish()]);
    const result=new Float32Array(await interop.readBuffer(buffers[4],count*32)),gpu=[0,0,0,0],cpu=[0,0,0,0],mismatches=[],numericalSamples=[];let classifiedNumerical=0;let maxPositionMm=0,maxDirection=0,positionFailures=0;
    for(let j=0;j<count;j++){
     const i=j*12,o=j*8,origin=Array.from(f.slice(i,i+3)),direction=Array.from(f.slice(i+4,i+7));
     // A native t=0 interface and sensor must share the SAME prescribed plane
     // in the f64 reference, just as their packed f32 counterparts do on GPU.
     // Rounding only the origin would move it below the unchanged f64 surface.
     if(native)origin[2]=lens.sensorZMm;
     const expected=traceLens(lens,origin,direction,{wavelengthNm:f[i+3],dispersion:!native,stopRadiusMm:packed.stopRadiusMm}),status=result[o+3];gpu[status]++;cpu[expected.status]++;
     if(status===3&&expected.status===3){
      const detail=numericalDetail(lens,origin,direction,native?587.5618:f[i+3],packed.stopRadiusMm);
      if(detail.status===3&&detail.apertureRadiusMm===null&&detail.primaryDomainRadiusMm!==null&&detail.primaryDomainRadiusMm<detail.numericalRadiusMm)classifiedNumerical++;
      if(numericalSamples.length<32)numericalSamples.push({pixel:Math.floor(j/spp),sample:j%spp,wavelengthNm:f[i+3],...detail});
     }
     if(status!==expected.status){if(mismatches.length<20)mismatches.push({gpuPoint:Array.from(result.slice(o,o+3)),gpuDirection:Array.from(result.slice(o+4,o+7)),cpuDetail:numericalDetail(lens,origin,direction,native?587.5618:f[i+3],packed.stopRadiusMm),pixel:Math.floor(j/spp),sample:j%spp,gpu:status,cpu:expected.status,origin,direction,wavelengthNm:f[i+3]});continue;}
     if(status===0){
      const ep=Math.hypot(...expected.point.map((v,k)=>v-result[o+k])),ed=Math.hypot(...expected.direction.map((v,k)=>v-result[o+4+k]));
      maxPositionMm=Math.max(maxPositionMm,ep);maxDirection=Math.max(maxDirection,ed);if(ep>1e-3||ed>2e-5)positionFailures++;
     }
     if(result[o+7]!==1)throw new Error('Nonfinite GPU ray');
    }
    const error=await device.popErrorScope();if(error)throw new Error(error.message);
    report.cases.push({id:entry.id,index,rays:count,region:native?{directional:true,sensorZMm:lens.sensorZMm,source:'native cosine hemisphere; original sensor is not moved'}:packed.region,packetSensorZMm:Math.fround(lens.sensorZMm),referenceSensorZMm:lens.sensorZMm,gpu,cpu,mismatches,numericalSamples,classifiedNumerical,maxPositionMm,maxDirection,positionFailures});await save();
   }finally{for(const buffer of buffers)interop.release(buffer);}
   // Yield between configurations so progress remains observable.
   await new Promise(resolve=>setTimeout(resolve,0));
  }
 }
 report.numericalFailures=report.cases.reduce((sum,c)=>sum+c.gpu[3],0);
 report.statusMismatches=report.cases.reduce((sum,c)=>sum+c.mismatches.length,0);
 report.passed=report.errors.length===0&&report.cases.length>0&&report.cases.every(c=>c.gpu[3]===c.classifiedNumerical&&c.mismatches.length===0&&c.positionFailures===0);
}catch(error){report.error=String(error)+'\n'+(error.stack??'');}
report.finishedVisibility=document.visibilityState;report.finishedFocused=document.hasFocus();out.textContent=JSON.stringify(report,null,2);document.body.dataset.passed=String(report.passed);await save().catch(()=>{});interop?.dispose();renderer?.dispose();
