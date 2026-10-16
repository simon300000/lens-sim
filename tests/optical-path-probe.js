import opticalCoreRaw from '../src/optics/optical-core.wgsl?raw';
import workCounters from '../src/rendering/work-counters.wgsl?raw';
const opticalCore=workCounters+opticalCoreRaw;
import probeKernel from './optical-path-probe.wgsl?raw';
import { AIR, modelGlass } from '../src/optics/glass.js';
import { packOpticalSurfaces, packLens } from '../src/optics/lens-state.js';
import { traceLens, unit, add } from '../src/optics/optical-reference.js';
import { sampleDimension, concentricDisk } from '../src/spectral/sampler.js';

const WAVELENGTHS=[390,550,770];
const POSITION_TOLERANCE_MM=1e-3,DIRECTION_TOLERANCE=2e-5;
const makeSurface=(index,zMm,extra={})=>({index,zMm,radiusMm:0,conic:0,aspheric:[],apertureRadiusMm:50,drawRadiusMm:50,mediumBefore:'air',mediumAfter:'air',thicknessMm:5,...extra});
const makeRay=(origin,direction,wavelengthNm,reverse=false)=>({origin,direction:unit(direction),wavelengthNm,reverse});
const distance=(a,b)=>Math.hypot(...a.map((x,i)=>x-b[i]));
const check=(condition,message)=>{if(!condition)throw new Error(message);};

// Afocal fixtures have no first-order focus/f-number, so cannot use packLens's
// camera controls. Their surface/LUT/uniform layout is the production ABI.
function packAfocal(lens,dispersion=true) {
  const {surfaces,lut}=packOpticalSurfaces(lens);
  const parameters=new ArrayBuffer(64),pf=new Float32Array(parameters),pu=new Uint32Array(parameters);
  pu.set([lens.surfaces.length,lut.count,0xffffffff,dispersion?1:0]);
  pf.set([lut.minNm,lut.maxNm,lut.stepNm,587.5618,80,30,50,50,36,24,0,0],4);
  return {surfaces,parameters:new Uint8Array(parameters),lut,stopRadiusMm:null};
}

async function loadLens(id){
  const response=await fetch(`/lenses/${id}.json`);
  if(!response.ok)throw new Error(`Optical probe needs generated lens data ${id}: HTTP ${response.status}`);
  const asset=await response.json(),lens=asset.configurations[0];
  if(!lens)throw new Error(`Optical probe lens ${id} configuration0 is unavailable`);
  return lens;
}

/** Native GPU path validation on caller's existing initialized device.
 * No renderer/device creation, CPU imaging, RGB post-shift or pass-rate scaling.
 * Returns small diagnostic results; elapsedMs is CPU wall time, NOT GPU time.
 */
export async function runOpticalPathProbe(interop){
  if(!interop?.device||!interop.computePipeline||!interop.storage||!interop.uniform||!interop.readBuffer||!interop.release)throw new TypeError('runOpticalPathProbe requires initialized shared-device interop');
  const started=performance.now(),compilationsBefore=interop.compilations;
  const pipeline=await interop.computePipeline(opticalCore+'\n'+probeKernel,'Production optical path / reciprocity probe');
  const glass=modelGlass(1.62,25,0,'diagnostic 1.62/25'),strongGlass=modelGlass(1.8,12,0,'diagnostic strong dispersion 1.8/12');
  const airLens=surfaces=>({surfaces,glasses:{air:AIR},stopIndex:-1});
  const plate={...airLens([makeSurface(0,0,{mediumAfter:glass.id}),makeSurface(1,5,{mediumBefore:glass.id})]),glasses:{air:AIR,[glass.id]:glass}};
  const sphere={...plate,surfaces:[makeSurface(0,0,{radiusMm:50,apertureRadiusMm:15,mediumAfter:glass.id}),makeSurface(1,5,{radiusMm:-50,apertureRadiusMm:15,mediumBefore:glass.id})]};
  const conic={...sphere,surfaces:sphere.surfaces.map((s,i)=>({...s,conic:i===0?-.6:-1.2}))};
  const coefficients=Array(12).fill(0);coefficients[0]=1e-9;coefficients[10]=-1e-43;coefficients[11]=2e-46;
  const asphere={...plate,surfaces:[makeSurface(0,0,{radiusMm:200,aspheric:coefficients,mediumAfter:glass.id}),makeSurface(1,30,{mediumBefore:glass.id})]};
  const tir={...plate,surfaces:[makeSurface(0,0,{mediumBefore:glass.id,mediumAfter:'air'})]};
  const dispersion={...sphere,glasses:{air:AIR,[strongGlass.id]:strongGlass},surfaces:sphere.surfaces.map(s=>({...s,mediumBefore:s.mediumBefore==='air'?'air':strongGlass.id,mediumAfter:s.mediumAfter==='air'?'air':strongGlass.id}))};
  const cases=[],doeCatalogPairs=[];
  const addFixture=(name,lens,rays,{dispersionEnabled=true,packed=null}={})=>cases.push({name,lens,rays,dispersionEnabled,packed:packed??packAfocal(lens,dispersionEnabled)});
  const surfaceRays=[];
  for(const nm of WAVELENGTHS)for(const x of [0,3,8]){
    surfaceRays.push(makeRay([x,1,-10],[.015,-.01,1],nm));
    surfaceRays.push(makeRay([x,1,15],[-.01,.015,-1],nm,true));
  }
  addFixture('plane no refraction',airLens([makeSurface(0,0)]),surfaceRays);
  addFixture('parallel glass plate',plate,surfaceRays);
  addFixture('signed spherical lens',sphere,surfaceRays);
  addFixture('conic lens',conic,surfaceRays);
  const highOrderRays=[];
  for(const nm of WAVELENGTHS)for(const x of [0,10,35,49]){
    highOrderRays.push(makeRay([x,1,-10],[0,0,1],nm));
    highOrderRays.push(makeRay([x,1,40],[0,0,-1],nm,true));
  }
  addFixture('normalized A4/A24/A26 asphere',asphere,highOrderRays);
  for(const [name,rn,coefficients]of [
    ['A1 off-axis',2.5,[.001,.002,-.0003,.00001]],
    ['A2/A3/A5',2.8,[0,.002,-.0003,0,.00001]],
    ['A20/A28',50,Array.from({length:28},(_,j)=>j===2?.01:j===19?-.002:j===27?.001:0)],
  ]){
    const extended={...plate,surfaces:[makeSurface(0,0,{radiusMm:200,xodd:{normalizationRadiusMm:rn,coefficients},mediumAfter:glass.id}),makeSurface(1,30,{mediumBefore:glass.id})]};
    const rays=[];for(const nm of WAVELENGTHS)for(const x of name==='A20/A28'?[10,25,40,49]:[.1,.5,1,2]){
      rays.push(makeRay([x,.1,-10],[.001,-.002,1],nm));
      rays.push(makeRay([x,.1,40],[.001,-.002,-1],nm,true));
    }
    if(name!=='A1 off-axis')for(const nm of WAVELENGTHS){
      rays.push(makeRay([0,0,-10],[0,0,1],nm));
      rays.push(makeRay([0,0,40],[0,0,-1],nm,true));
    }
    addFixture(`XODD ${name} Rn=${rn}`,extended,rays);
  }
  addFixture('explicit total internal reflection',tir,WAVELENGTHS.map(nm=>makeRay([0,0,-2],[.9,0,.3],nm)));
  const dispersionRays=WAVELENGTHS.map(nm=>makeRay([7,2,-10],[.01,0,1],nm));
  addFixture('strong dispersion ON',dispersion,dispersionRays);
  addFixture('strong dispersion OFF',dispersion,dispersionRays,{dispersionEnabled:false});
  for(const id of ['canon-fl-50mm-f1-8','canon-ef-40mm-f2-8-stm']){
    const lens=await loadLens(id),packed=packLens(lens,{fNumber:id.includes('fl-50')?2.8:4}),rays=[];
    for(const [pixelId,xy]of [[0,[0,0]],[1,[12,0]],[2,[17.9,11.9]]])for(let i=0;i<64;i++){
      const disk=concentricDisk(sampleDimension(pixelId,i,2,1234),sampleDimension(pixelId,i,3,1234));
      const origin=[...xy,packed.sensorZMm],pupil=[disk[0]*packed.region.radiusMm,disk[1]*packed.region.radiusMm,packed.region.zMm];
      for(const nm of WAVELENGTHS)rays.push(makeRay(origin,add(pupil,origin,-1),nm,true));
    }
    addFixture(`catalog ${id} cfg0`,lens,rays,{packed});
  }
  for(const id of ['canon-rf-28mm-f2-8-stm','fujifilm-xf-18mm-f1-4-r-lm-wr','fujifilm-gf-50mm-f3-5-r-lm-wr']){
    const lens=await loadLens(id),packed=packLens(lens,{sensorZMm:lens.sensorZMm}),rays=[];
    for(const nm of WAVELENGTHS)for(const xy of [[0,0],[1,.3],[3,1],[6,2]]){
      rays.push(makeRay([xy[0],xy[1],-10],[.005,-.003,1],nm));
      rays.push(makeRay([xy[0],xy[1],lens.sensorZMm],[.005,-.003,-1],nm,true));
    }
    addFixture(`XODD catalog ${id} cfg0`,lens,rays,{packed});
  }
  // Pinned Noct S28 rays: disjoint sag/cylinder intervals and a cylinder miss.
  // These are physical misses, not failed numerical solves. Include an axial
  // hit and an edge hit to ensure the conservative bound does not clip rays.
  const noct=await loadLens('nikon-z-58mm-f0-95-noct-s');
  const rearAsphere={...noct.surfaces[27],index:0,mediumBefore:'air',mediumAfter:'air'};
  addFixture('Noct S28 physical misses',airLens([rearAsphere]),[
    makeRay([3.227754412035264,-10.20743269177128,158.12413412796502],[-.9776382086592235,.17401968388867986,-.1180706677751448],550,true),
    makeRay([19.55068530743874,-6.371049982955646,158.12413412796502],[.5515627268993667,.8062670439127602,-.21380367675864184],550,true),
    makeRay([0,0,158.12413412796502],[0,0,-1],550,true),
    makeRay([18.798,0,158.12413412796502],[0,0,-1],550,true),
  ]);
  const phaseSurface=makeSurface(0,0,{doe:{order:1,normalizationRadiusMm:10,coefficients:[-Math.PI*100/(550e-6*100)]}});
  const phaseRays=WAVELENGTHS.flatMap(nm=>[makeRay([5,0,-1],[0,0,1],nm),makeRay([5,0,1],[0,0,-1],nm,true)]);
  addFixture('DOE analytic plane phase lens',airLens([phaseSurface]),phaseRays);
  addFixture('DOE dispersion OFF',airLens([phaseSurface]),phaseRays,{dispersionEnabled:false});
  addFixture('DOE negative order curved carrier',airLens([{...phaseSurface,radiusMm:100,aspheric:[1e-9],doe:{...phaseSurface.doe,order:-2}}]),surfaceRays);
  addFixture('DOE forbidden order',airLens([{...phaseSurface,doe:{...phaseSurface.doe,order:100}}]),WAVELENGTHS.map(nm=>makeRay([5,0,-1],[0,0,1],nm)));
  const doeIds=['canon-ef-400mm-f4-do-is-ii-usm','canon-ef-400mm-f4-do-is-usm','canon-rf-600mm-f11-is-stm','canon-rf-800mm-f11-is-stm','nikon-af-s-nikkor-300mm-f4e-pf-ed-vr','nikon-af-s-nikkor-500mm-f5-6e-pf-ed-vr','nikon-z-600mm-f4-vr-s'];
  for(const id of doeIds){
    const asset=await (await fetch(`/lenses/${id}.json`)).json();
    for(const lens of asset.configurations){
      check(lens?.surfaces.some(s=>s.doe),`${id}: missing DOE configuration`);
      const packed=packLens(lens,{sensorZMm:lens.sensorZMm}),rays=[];
      for(const nm of WAVELENGTHS)for(const x of [0,2,5,10])for(const field of [0,.005])rays.push(makeRay([x,1,-1],[field,0,1],nm));
      const name=`catalog DOE ${id} cfg${lens.configurationIndex}`;
      addFixture(name,lens,rays,{packed});
      const baseline={...lens,surfaces:lens.surfaces.map(s=>({...s,doe:null}))};
      addFixture(`no phase ${id} cfg${lens.configurationIndex}`,baseline,rays,{packed:packAfocal(baseline)});
      doeCatalogPairs.push({name,baseline:`no phase ${id} cfg${lens.configurationIndex}`});
    }
  }
  const summaries=[],allResults=new Map();let totalRays=0,totalPassed=0,peakMemoryBytes=0,maxPositionErrorMm=0,maxDirectionError=0,maxReciprocityPositionMm=0,maxReciprocityDirection=0;
  for(const fixture of cases){
    const resources=[];let scopePending=false;
    try{
      const packed=fixture.packed,raw=new ArrayBuffer(fixture.rays.length*48),inputF=new Float32Array(raw),inputU=new Uint32Array(raw);
      fixture.rays.forEach((r,i)=>{inputF.set([...r.origin,r.wavelengthNm,...r.direction,0],i*12);inputU[i*12+8]=r.reverse?1:0;});
      const own=buffer=>{resources.push(buffer);return buffer;};
      const surfaces=own(interop.storage(packed.surfaces,`${fixture.name} surfaces`));
      const lut=own(interop.storage(packed.lut.values,`${fixture.name} glass LUT`));
      const parameters=own(interop.uniform(packed.parameters,`${fixture.name} uniform`));
      const inputs=own(interop.storage(new Uint8Array(raw),`${fixture.name} rays`));
      const outputs=own(interop.storage(fixture.rays.length*64,`${fixture.name} results`));
      const {device}=interop;device.pushErrorScope('validation');scopePending=true;
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[surfaces,lut,parameters,inputs,outputs].map((buffer,binding)=>({binding,resource:{buffer}}))});
      const encoder=device.createCommandEncoder({label:fixture.name}),pass=encoder.beginComputePass();
      pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(fixture.rays.length/64));pass.end();device.queue.submit([encoder.finish()]);
      const result=new Float32Array(await interop.readBuffer(outputs,fixture.rays.length*64));
      const validation=await device.popErrorScope();scopePending=false;if(validation)throw new Error(`${fixture.name}: ${validation.message}`);
      check(result.every(Number.isFinite),`${fixture.name}: nonfinite GPU data`);
      const statusCounts=[0,0,0,0],rows=[];let casePosition=0,caseDirection=0,caseReciprocity=0;
      for(let i=0;i<fixture.rays.length;i++){
        const ray=fixture.rays[i],offset=i*16,actual={point:Array.from(result.slice(offset,offset+3)),status:result[offset+3],direction:Array.from(result.slice(offset+4,offset+7))};
        const expected=traceLens(fixture.lens,ray.origin,ray.direction,{reverse:ray.reverse,wavelengthNm:ray.wavelengthNm,dispersion:fixture.dispersionEnabled,stopRadiusMm:packed.stopRadiusMm});
        check(actual.status===expected.status,`${fixture.name} ray${i} ${ray.wavelengthNm}nm: GPU status${actual.status} != f64 ${expected.status}`);
        check(actual.status!==3,`${fixture.name} ray${i}: numerical failure is not physical vignette`);
        check(result[offset+7]===1,`${fixture.name} ray${i}: finite marker failed`);
        statusCounts[actual.status]++;totalRays++;
        if(actual.status===0){
          totalPassed++;
          const ep=distance(actual.point,expected.point),ev=distance(actual.direction,expected.direction);
          check(ep<=POSITION_TOLERANCE_MM&&ev<=DIRECTION_TOLERANCE,`${fixture.name} ray${i}: path error ${ep}mm / ${ev} direction`);
          casePosition=Math.max(casePosition,ep);caseDirection=Math.max(caseDirection,ev);
          const returned={point:Array.from(result.slice(offset+8,offset+11)),status:result[offset+11],direction:Array.from(result.slice(offset+12,offset+15))};
          check(returned.status===0,`${fixture.name} ray${i}: reciprocal trace failed status${returned.status}`);
          const t=(ray.origin[2]-returned.point[2])/returned.direction[2],back=add(returned.point,returned.direction,t);
          const rp=distance(back,ray.origin),rv=distance(returned.direction,ray.direction.map(v=>-v));
          check(rp<=POSITION_TOLERANCE_MM&&rv<=DIRECTION_TOLERANCE,`${fixture.name} ray${i}: reciprocal error ${rp}mm / ${rv} direction`);
          maxReciprocityPositionMm=Math.max(maxReciprocityPositionMm,rp);maxReciprocityDirection=Math.max(maxReciprocityDirection,rv);caseReciprocity=Math.max(caseReciprocity,rp);
        }
        rows.push(actual);
      }
      maxPositionErrorMm=Math.max(maxPositionErrorMm,casePosition);maxDirectionError=Math.max(maxDirectionError,caseDirection);
      if(fixture.name.startsWith('XODD catalog'))check(statusCounts[0]>=6,`${fixture.name}: insufficient successful XODD paths`);
      if(fixture.name.startsWith('catalog'))check(statusCounts[0]>=12,`${fixture.name}: insufficient successful paths for meaningful reference comparison`);
      const memory=packed.surfaces.byteLength+packed.lut.values.byteLength+packed.parameters.byteLength+raw.byteLength+result.byteLength;
      peakMemoryBytes=Math.max(peakMemoryBytes,memory);
      summaries.push({name:fixture.name,surfaces:fixture.lens.surfaces.length,rays:fixture.rays.length,statusCounts,maxPositionErrorMm:casePosition,maxDirectionError:caseDirection,maxReciprocityPositionMm:caseReciprocity});allResults.set(fixture.name,rows);
    }finally{
      if(scopePending)await interop.device.popErrorScope();for(const resource of resources)interop.release(resource);
    }
  }
  const on=allResults.get('strong dispersion ON'),off=allResults.get('strong dispersion OFF');
  check(on.every(r=>r.status===0)&&off.every(r=>r.status===0),'Strong dispersion diagnostic rays must pass');
  const dispersionDirectionDifference=distance(on[0].direction,on[2].direction),dispersionPositionDifferenceMm=distance(on[0].point,on[2].point);
  check(dispersionDirectionDifference>1e-3,'Strong dispersion must alter actual geometric ray direction');
  const noDispersionDifference=Math.max(...off.map(r=>distance(r.direction,off[0].direction)+distance(r.point,off[0].point)));
  check(noDispersionDifference===0,'Dispersion OFF must give bit-identical paths for different sampled wavelengths');
  const doeCatalogSpectralEffects=doeCatalogPairs.map(pair=>{
    const rows=allResults.get(pair.name),baseline=allResults.get(pair.baseline);
    const wavelengthDirectionDifference=distance(rows[4].direction,rows[20].direction);
    const prescribedPhaseDirectionEffect=distance(rows[4].direction,baseline[4].direction);
    check(rows[4].status===0&&rows[20].status===0&&baseline[4].status===0,'DOE catalog comparison needs transmitted rays');
    check(wavelengthDirectionDifference>1e-8&&prescribedPhaseDirectionEffect>1e-6,`${pair.name}: lost DOE/spectral effect`);
    return {name:pair.name,wavelengthsNm:[390,770],wavelengthDirectionDifference,prescribedPhaseDirectionEffect};
  });
  const phaseOn=allResults.get('DOE analytic plane phase lens'),phaseOff=allResults.get('DOE dispersion OFF');
  for(let i=0;i<WAVELENGTHS.length;i++)check(Math.abs(phaseOn[i*2].direction[0]+.05*WAVELENGTHS[i]/550)<2e-6,'DOE plane analytic sin(theta) mismatch');
  const doeWavelengthDirectionDifference=distance(phaseOn[0].direction,phaseOn[4].direction);
  const doeDispersionOffDifference=distance(phaseOff[0].direction,phaseOff[4].direction);
  check(doeWavelengthDirectionDifference>.01&&doeDispersionOffDifference===0,'DOE wavelength/dispersion-off behavior failed');
  return {passed:true,sharedDevice:true,productionOpticalCore:true,doeCatalogSpectralEffects,cases:summaries,totalRays,totalPassed,
    tolerances:{positionMm:POSITION_TOLERANCE_MM,direction:DIRECTION_TOLERANCE},maxPositionErrorMm,maxDirectionError,maxReciprocityPositionMm,maxReciprocityDirection,
    dispersionDirectionDifference,dispersionPositionDifferenceMm,noDispersionDifference,doeWavelengthDirectionDifference,doeDispersionOffDifference,
    pipelineCompilations:interop.compilations-compilationsBefore,peakMemoryBytes,elapsedMs:performance.now()-started,
    timingKind:'CPU wall time including compilation, data loading and small diagnostic readbacks; not GPU execution time'};
}
