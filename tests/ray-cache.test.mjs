import test from 'node:test';
import assert from 'node:assert/strict';
import {planRayBatch,cellOf,orderedBits,fromOrderedBits,decodeCells,CELL_STRIDE,CELL_FIXED_PER_MM,CACHE_BYTES_PER_SAMPLE,CACHE_SPP_LIMIT} from '../src/rendering/ray-cache.js';
import {stagedIntegratorSources} from '../src/rendering/staged-integrator.js';
import {SCENE_RAY_WGSL,SCENE_SAMPLE_WGSL,WORK_COUNTERS_WGSL} from '../src/rendering/scene-wgsl.js';
import {providerSource,createConstantRayProvider} from '../src/rendering/radiance-provider.js';
import integrator from '../src/rendering/optical-integrator.wgsl.js';
import optical from '../src/optics/optical-core.wgsl.js';
import {rng} from './scene-fixtures.js';

test('ordered float bits keep order and round-trip exactly (atomic min/max on floats)',()=>{
 const values=[-1e30,-12.5,-1,-1e-20,-0,0,1e-20,.25,1,7.5,3e38].map(Math.fround);
 const bits=values.map(orderedBits);
 for(let i=1;i<bits.length;i++)assert.ok(bits[i]>=bits[i-1],`${values[i-1]} < ${values[i]}`);
 for(const v of values)assert.equal(fromOrderedBits(orderedBits(v)),v);
});

test('exit-point cells tile the disk; rotation and jitter move the borders, not the coverage',()=>{
 const r=rng(3),R=20,n=4,counts=new Map();
 for(let i=0;i<20000;i++){
  const a=r()*Math.PI*2,rad=R*Math.sqrt(r()),p=[rad*Math.cos(a),rad*Math.sin(a)];
  const k=cellOf(p,{n,radiusMm:R});assert.ok(k>=0&&k<n*n);counts.set(k,(counts.get(k)??0)+1);
  // A quarter turn of the grid equals the point turned the other way.
  assert.equal(cellOf(p,{n,radiusMm:R,rotation:Math.PI/2}),cellOf([-p[1],p[0]],{n,radiusMm:R}));
  const jittered=cellOf(p,{n,radiusMm:R,jitter:[.5,.5]});assert.ok(jittered>=0&&jittered<n*n);
 }
 assert.equal(counts.size,16,'a 4x4 grid over the exit disk uses every cell');
});

test('batch planning picks S for the budget and splits a tile that does not fit',()=>{
 const tile=1200,perSpp=64*CACHE_BYTES_PER_SAMPLE;
 assert.deepEqual(planRayBatch({totalGroups:tile,spp:16,memoryBytes:Infinity,maxBufferBytes:2**31}),{spp:16,groups:tile,bytes:tile*perSpp*16});
 const tight=planRayBatch({totalGroups:tile,spp:16,memoryBytes:tile*perSpp*5.5,maxBufferBytes:2**31});
 assert.equal(tight.spp,5);assert.equal(tight.groups,tile);
 const split=planRayBatch({totalGroups:tile,spp:16,memoryBytes:tile*perSpp*.5,maxBufferBytes:2**31});
 assert.equal(split.spp,1);assert.equal(split.groups,tile/2);
 assert.equal(planRayBatch({totalGroups:tile,spp:16,memoryBytes:tile*perSpp*.5,maxBufferBytes:2**31,fixedSpp:true}).groups,Math.floor(tile/32));
 assert.equal(planRayBatch({totalGroups:tile,spp:999,memoryBytes:Infinity,maxBufferBytes:2**40}).spp,CACHE_SPP_LIMIT);
 assert.throws(()=>planRayBatch({totalGroups:tile,spp:1,memoryBytes:10,maxBufferBytes:2**31}),/below one packet group/);
});

test('cell table decoding: fixed-point centroid, exit and direction bounds, parallax residual',()=>{
 const n=2,R=10,words=new Uint32Array(n*n*CELL_STRIDE),points=[[-3,4],[-1,2],[-2,1]],dirs=[[.1,.2,-.97],[.0,-.1,-.99],[-.2,0,-.98]];
 const o=1*CELL_STRIDE;words[o]=points.length;words[o+1]=7;
 const sum=a=>points.reduce((s,p)=>s+Math.round((p[a]+R)*CELL_FIXED_PER_MM),0);
 words[o+4]=sum(0);words[o+6]=sum(1);
 const min=a=>orderedBits(Math.min(...points.map(p=>p[a]))),max=a=>orderedBits(Math.max(...points.map(p=>p[a])));
 words[o+8]=min(0);words[o+9]=max(0);words[o+10]=min(1);words[o+11]=max(1);
 for(let a=0;a<3;a++){words[o+12+a]=orderedBits(Math.min(...dirs.map(d=>d[a])));words[o+15+a]=orderedBits(Math.max(...dirs.map(d=>d[a])));}
 const [empty,cell]=decodeCells(words,{n,radiusMm:R});
 assert.equal(empty.count,0);assert.equal(cell.count,3);assert.equal(cell.offset,7);
 assert.ok(Math.abs(cell.centroidMm[0]+2)<1/CELL_FIXED_PER_MM&&Math.abs(cell.centroidMm[1]-7/3)<1/CELL_FIXED_PER_MM);
 assert.deepEqual(cell.exitBoundsMm,[-3,1,-1,4]);
 assert.ok(Math.abs(cell.directionMin[2]-Math.fround(-.99))<1e-7&&Math.abs(cell.directionMax[0]-Math.fround(.1))<1e-7);
 assert.ok(Math.abs(cell.parallaxResidualMm-Math.hypot(-1-(-2),4-7/3))<1e-2);
});

test('cached kernels reuse the direct path\'s world ray, key and spectral contribution',()=>{
 const shading=SCENE_RAY_WGSL+providerSource(createConstantRayProvider());
 const common={integrator,optical,work:WORK_COUNTERS_WGSL,intersector:'',shading,spectral:'',sampling:'',pupil:'',sample:SCENE_SAMPLE_WGSL};
 const cached=stagedIntegratorSources({...common,mode:'cached',roundSppLimit:CACHE_SPP_LIMIT});
 assert.deepEqual(Object.keys(cached),['raygen','bin','scan','scatter','resolve','accumulate']);
 const direct=stagedIntegratorSources({...common,mode:'ray'});
 // The lens packets are lossless: the cache stores the raygen output unchanged (12 bytes per mirrored ray).
 assert.equal(cached.raygen.replace(`ROUND_SPP_LIMIT: u32 = ${CACHE_SPP_LIMIT}u`,'ROUND_SPP_LIMIT: u32 = 4u'),direct.raygen);
 for(const line of ['let worldOrigin=(render.cameraToWorld*vec4<f32>(optical.p*vec3<f32>(sign,1)*.001,1)).xyz;',
  'let worldDirection=normalize((render.cameraToWorld*vec4<f32>(optical.v*vec3<f32>(sign,1),0)).xyz);'])
  {assert.ok(direct.scene.includes(line));assert.ok(cached.resolve.includes(line));}
 assert.match(direct.scene,/spectralHash32\(globalPixel\^spectralHash32\(a\.attempts\+render\.settings\.x\*0x632be5abu\)\)/);
 assert.match(cached.resolve,/attempts=accumulation\[outputIndex\(c,quadrant\)\]\.attempts\+j;\s*let key=spectralHash32\(\(image\.y\*render\.size\.x\+image\.x\)\^spectralHash32\(attempts\+render\.settings\.x\*0x632be5abu\)\);/);
 assert.match(cached.accumulate,/cieXYZ\(optical\.lambda\)\*\(bitcast<f32>\(result\.x\)\*optical\.weight\*SPECTRAL_XYZ_NORMALIZATION\/\(1\.\/\(optics\.wavelength\.y-optics\.wavelength\.x\)\)\)/);
 assert.doesNotMatch(cached.accumulate,/rayRadiance/,'accumulation never calls the provider');
});
