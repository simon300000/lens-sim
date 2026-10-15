import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { loadUpstreamCatalog } from '../scripts/build-lens-data.mjs';
import { parsePrescriptionText, adaptLensRecord } from '../src/optics/prescription.js';
import { phaseGradient, diffractivePower, normalizeDiffraction } from '../src/optics/diffractive.js';
import { AIR, refractiveIndex } from '../src/optics/glass.js';
import { traceLens, unit, add } from '../src/optics/optical-reference.js';
import { firstOrder, packOpticalSurfaces, SURFACE_BYTES, SURFACE_FLOATS } from '../src/optics/lens-state.js';
import { preflightLens } from '../src/optics/capabilities.js';
const close=(a,b,t=1e-11)=>assert.ok(Math.abs(a-b)<=t,`${a} != ${b}, tolerance ${t}`);
const distance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
const catalog=await loadUpstreamCatalog();
const directory=new URL('../vendor/lens-bench/data/lenses/',import.meta.url);
const names=(await fs.readdir(directory)).filter(f=>f.endsWith('.json'));
const records=[];for(const name of names){const r=JSON.parse(await fs.readFile(new URL(name,directory),'utf8'));if(/\bDOE\b/.test(r.tx))records.push(r);}
const surface=(extra={})=>({index:0,zMm:0,radiusMm:0,conic:0,aspheric:[],apertureRadiusMm:20,drawRadiusMm:20,mediumBefore:'air',mediumAfter:'air',...extra});
const lensFor=s=>({surfaces:[s],glasses:{air:AIR},stopIndex:-1});
const phaseLens=(order=1)=>lensFor(surface({doe:{order,normalizationRadiusMm:10,coefficients:[-Math.PI*100/(550e-6*100)]}}));

test('DOE grammar retains carrier sag, radians, order and normalized phase; invalid data reject',()=>{
  const s=parsePrescriptionText('50 2 air 10 -.4 1e-6 -2e-9 DOE -2 100 7 8 0')[0];
  assert.deepEqual(s.aspheric,[1e-6,-2e-9]);assert.equal(s.radiusMm,50);assert.equal(s.conic,-.4);
  assert.deepEqual(s.doe,{order:-2,normalizationRadiusMm:100,coefficients:[7,8]});
  for(const tail of ['DOE','DOE 1 10','DOE .5 10 2','DOE 1 0 2','DOE 1 -1 2','DOE 1 10 bad','DOE 1 1 '+Array(13).fill(1).join(' ')])assert.throws(()=>parsePrescriptionText('0 10 air 10 0 '+tail));
  const d=s.doe,r2=25,expected=d.order*(2*7/100**2+4*8*r2/100**4);
  assert.deepEqual(phaseGradient(s,3,4),[3*expected,4*expected,0]);
});

test('analytic plane phase lens uses sin(theta), wavelength scaling, order sign and first-order power',()=>{
  for(const order of [-2,-1,0,1,2])for(const nm of [390,550,770]){
    const lens=phaseLens(order),ray=traceLens(lens,[5,0,-1],[0,0,1],{reverse:false,wavelengthNm:nm});
    assert.equal(ray.status,0);close(ray.direction[0],-order*5/100*nm/550);close(ray.direction[1],0);
    close(ray.direction[2],Math.sqrt(1-ray.direction[0]**2));
    close(diffractivePower(lens.surfaces[0],nm),order/100*nm/550);
    if(order)close(firstOrder({...lens,stopIndex:0},nm).focalLengthMm,100/order*550/nm);
    const reverse=traceLens(lens,ray.point,ray.direction.map(x=>-x),{reverse:true,wavelengthNm:nm});
    assert.equal(reverse.status,0);assert.ok(distance(reverse.direction,[0,0,-1])<1e-14);
  }
  const off=[390,770].map(wavelengthNm=>traceLens(phaseLens(),[5,0,-1],[0,0,1],{reverse:false,wavelengthNm,dispersion:false}));
  assert.deepEqual(off[0],off[1]);
  const impossible=phaseLens(100);assert.equal(traceLens(impossible,[5,0,-1],[0,0,1],{reverse:false}).status,2);
});

test('curved carrier projects phase gradient onto tangent and retraces across unequal refractive media',()=>{
  const glass={id:'constant',formula:'L',coefficients:[2.25],rangeNm:[380,780]};
  const lens={...phaseLens(-2),glasses:{air:AIR,constant:glass}};
  lens.surfaces[0]={...lens.surfaces[0],radiusMm:40,conic:-.5,aspheric:[1e-7],mediumAfter:'constant'};
  for(const nm of [390,550,770]){
    const origin=[7,1,-10],direction=unit([.03,-.01,1]);
    const a=traceLens(lens,origin,direction,{reverse:false,wavelengthNm:nm});assert.equal(a.status,0);
    const b=traceLens(lens,a.point,a.direction.map(x=>-x),{reverse:true,wavelengthNm:nm});assert.equal(b.status,0);
    const originalPlane=add(b.point,b.direction,(origin[2]-b.point[2])/b.direction[2]);
    assert.ok(distance(originalPlane,origin)<1e-8);assert.ok(distance(b.direction,direction.map(x=>-x))<1e-10);
  }
});

test('joint surface ABI stores normalized phase without altering physical carrier or silently dropping terms',()=>{
  const lens=phaseLens(-2),s=lens.surfaces[0];
  const {surfaces}=packOpticalSurfaces(lens),f=new Float32Array(surfaces.buffer);
  assert.equal(SURFACE_BYTES,224);assert.equal(SURFACE_FLOATS,56);assert.equal(surfaces.byteLength,224);
  assert.equal(f[40],1);assert.equal(f[41],20);assert.equal(f[42],-2);assert.equal(f[43],10);
  close(f[44],Math.fround(-2*s.doe.coefficients[0]*4),0);assert.equal(f[8],0);
  const high=surface({doe:{order:1,normalizationRadiusMm:1,coefficients:Array(11).fill(0).concat(1e-45)}});
  assert.ok(normalizeDiffraction(high,100)[11]>0);
  high.doe.coefficients[11]=1e-100;assert.throws(()=>normalizeDiffraction(high,100),/cannot be represented/);
  const record={id:'validation',name:'validation',stop:1,fno:4,tx:'50 3 N-BK7 10 0 DOE 1 10 1\n-50 40 - 10'};
  const valid=adaptLensRecord(record,catalog);assert.equal(preflightLens(valid).supported,true);
  valid.surfaces[0].doe.normalizationRadiusMm=0;assert.match(preflightLens(valid).reason,/invalid DOE/);
});

test('all 7 DOE lenses / 28 configurations retain phase and agree with independent pinned upstream tracing',async()=>{
  assert.equal(records.length,7);
  const context=vm.createContext({});
  vm.runInContext(await fs.readFile(new URL('../vendor/lens-bench/js/glassdb.js',import.meta.url),'utf8')+'\n'+await fs.readFile(new URL('../vendor/lens-bench/js/optics.js',import.meta.url),'utf8'),context,{timeout:5000});
  let configurations=0,compared=0,maxPosition=0,maxDirection=0,maxPhaseDirectionEffect=0;
  for(const record of records)for(let config=0;config<record.cfgs.length;config++){
    const lens=adaptLensRecord(record,catalog,{configurationIndex:config});assert.equal(preflightLens(lens).supported,true);configurations++;
    assert.ok(lens.surfaces.some(s=>s.doe));
    const parsed=context.OPT.parsePrescription(record.tx),S=parsed.surfaces;
    for(const [i,s] of S.entries()){
      const own=lens.surfaces[i];s.T=own.thicknessMm;s.R=own.radiusMm;s.sd=own.apertureRadiusMm;
      // Give both tracers identical refractive-index functions to isolate the
      // independent phase/intersection law from glass-catalog approximations.
      s.n=lambdaUm=>refractiveIndex(lens.glasses[own.mediumAfter],lambdaUm*1000);
      if(s.doe)for(let j=0;j<s.doe.b.length;j++)close(s.doe.b[j],own.doe.order*own.doe.coefficients[j]/own.doe.normalizationRadiusMm**(2+2*j),1e-14);
    }
    const sys={surfaces:S,zVertex:lens.surfaces.map(s=>s.zMm)};
    let successful=0;
    for(const nm of [390,550,770])for(const x of [0,2,5,10])for(const field of [0,.005]){
      const origin=[x,1,-1],direction=unit([field,0,1]);
      const own=traceLens(lens,origin,direction,{reverse:false,wavelengthNm:nm});
      const reference=context.OPT.traceRay(sys,origin,direction,nm/1000,false);
      assert.equal(own.status===0,reference.ok,`${record.id} cfg${config} ${x},${field}@${nm}`);
      if(!reference.ok)continue;
      const ep=distance(own.point,reference.P),ed=distance(own.direction,reference.D);
      assert.ok(ep<1e-6&&ed<1e-8,`${record.id}: ${ep} mm,${ed} direction`);maxPosition=Math.max(maxPosition,ep);maxDirection=Math.max(maxDirection,ed);successful++;compared++;
      const reverse=traceLens(lens,own.point,own.direction.map(v=>-v),{reverse:true,wavelengthNm:nm});assert.equal(reverse.status,0);
      const back=add(reverse.point,reverse.direction,(-1-reverse.point[2])/reverse.direction[2]);
      assert.ok(distance(back,origin)<1e-6&&distance(reverse.direction,direction.map(v=>-v))<1e-8);
      const disabled={...lens,surfaces:lens.surfaces.map(s=>({...s,doe:null}))};
      const noPhase=traceLens(disabled,origin,direction,{reverse:false,wavelengthNm:nm});
      if(noPhase.status===0)maxPhaseDirectionEffect=Math.max(maxPhaseDirectionEffect,distance(own.direction,noPhase.direction));
    }
    assert.ok(successful>=12,record.id+' needs actual transmitted reference rays');
  }
  assert.equal(configurations,28);assert.ok(maxPhaseDirectionEffect>1e-3);
  console.log(JSON.stringify({configurations,compared,maxPosition,maxDirection,maxPhaseDirectionEffect}));
});
