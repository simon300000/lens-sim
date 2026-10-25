import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planRayBatch,cellOf,diskCells,cellShift,orderedBits,fromOrderedBits,decodeCells,CELL_STRIDE,CELL_FIXED_PER_MM,CACHE_BYTES_PER_SAMPLE,CACHE_SPP_LIMIT,CACHE_RETRY_BIT,CACHE_RESCUE_BIT} from '../src/rendering/ray-cache.js';
import {stagedIntegratorSources} from '../src/rendering/staged-integrator.js';
import {SCENE_RAY_WGSL,SCENE_SAMPLE_WGSL,WORK_COUNTERS_WGSL} from '../src/rendering/scene-wgsl.js';
import {providerSource,createConstantRayProvider} from '../src/rendering/radiance-provider.js';
import integrator from '../src/rendering/optical-integrator.wgsl.js';
import optical from '../src/optics/optical-core.wgsl.js';
import {rng} from './scene-fixtures.js';
import {createFakeDevice} from './fake-gpu.mjs';
import {createLensTracer} from '../src/lens-tracer.js';

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
 assert.deepEqual(Object.keys(cached),['raygen','bin','scan','scatter','resolve','accumulate','preview']);
 const direct=stagedIntegratorSources({...common,mode:'ray'});
 // The lens packets are lossless: the cache stores the raygen output unchanged (12 bytes per mirrored ray),
 // starting after the attempts of held batches over the same pixels.
 const offset='+bitcast<u32>(render.pinholeClipToCamera[0].y)';
 // Sensor tiles: cached batches may cover a column window of group rows; width 0 is the direct mapping.
 const windowed=/\/\/ Cached batches may cover[\s\S]*?\n}\n/,plain=direct.raygen.match(/fn windowPixel\(.*\n/)[0];
 assert.match(cached.raygen,windowed);assert.match(cached.raygen,/if\(w==0u\)\{return mirrorPixel\(render\.debug\.y\+local,lane,halfWidth\);\}/);
 assert.equal(cached.raygen.replace(`ROUND_SPP_LIMIT: u32 = ${CACHE_SPP_LIMIT}u`,'ROUND_SPP_LIMIT: u32 = 4u').replace(offset,'').replace(windowed,plain),direct.raygen);
 for(const name of ['bin','scatter','resolve','accumulate','preview'])assert.match(cached[name],/cacheAttempts\(/,name+' counts held attempts');
 for(const line of ['let worldOrigin=(render.cameraToWorld*vec4<f32>(optical.p*vec3<f32>(sign,1)*.001,1)).xyz;',
  'let worldDirection=normalize((render.cameraToWorld*vec4<f32>(optical.v*vec3<f32>(sign,1),0)).xyz);'])
  {assert.ok(direct.scene.includes(line));assert.ok(cached.resolve.includes(line));}
 assert.match(direct.scene,/spectralHash32\(globalPixel\^spectralHash32\(a\.attempts\+render\.settings\.x\*0x632be5abu\)\)/);
 assert.match(cached.resolve,/attempts=cacheAttempts\(accumulation\[outputIndex\(c,quadrant\)\]\.attempts\)\+j;\s*let key=spectralHash32\(\(image\.y\*render\.size\.x\+image\.x\)\^spectralHash32\(attempts\+render\.settings\.x\*0x632be5abu\)\);/);
 assert.match(cached.accumulate,/cieXYZ\(optical\.lambda\)\*\(bitcast<f32>\(result\.x\)\*optical\.weight\*SPECTRAL_XYZ_NORMALIZATION\/\(1\.\/\(optics\.wavelength\.y-optics\.wavelength\.x\)\)\)/);
 assert.doesNotMatch(cached.accumulate,/rayRadiance/,'accumulation never calls the provider');
 // The preview estimate uses the same contribution and never the provider; retries skip resolved rays.
 assert.ok(cached.preview.includes('cieXYZ(optical.lambda)*(bitcast<f32>(result.x)*optical.weight*SPECTRAL_XYZ_NORMALIZATION'));
 assert.doesNotMatch(cached.preview,/rayRadiance/);
 assert.match(cached.resolve,/cache\.cell\.x&2147483648u\)!=0u&&\(prior&1024u\)!=0u\)\{return;\}/);
 assert.match(cached.resolve,/cache\.cell\.x&1073741824u\)!=0u&&\(\(prior&1024u\)==0u\|\|\(prior&255u\)!=SCENE_UNSUPPORTED\)\)\{return;\}/);
 assert.match(cached.resolve,/if\(scene\.status==SCENE_DEFERRED\)\{rayResults\[index\]=vec2u\(0u,SCENE_DEFERRED\);return;\}/,'deferred rays stay unresolved');
 assert.match(SCENE_SAMPLE_WGSL,/const SCENE_DEFERRED: u32 = 10u;/,'every scene kernel knows the deferred status');
});

test('disk cells: the lattice cells the exit disk reaches, with area shares; cellShift is per serial',()=>{
 const lattice={grid:4,radiusMm:10,...cellShift(5,2)},cells=diskCells(lattice,96);
 assert.ok(Math.abs(cells.reduce((n,c)=>n+c.share,0)-1)<1e-12);
 for(const c of cells){assert.equal(cellOf(c.centroidMm,{n:4,...lattice}),c.index);assert.ok(c.exitBoundsMm[0]<=c.centroidMm[0]&&c.centroidMm[0]<=c.exitBoundsMm[2]);}
 assert.deepEqual(cellShift(5,2),cellShift(5,2));assert.notDeepEqual(cellShift(5,2),cellShift(5,3));
});

// Engine bookkeeping of the embedding hooks on the recording fake device (no kernel runs).
const lens=JSON.parse(readFileSync(new URL('../public/lenses/canon-fl-50mm-f1-8.json',import.meta.url))).configurations[0];
async function fakeTracer(options={}){
 const device=createFakeDevice(),tracer=await createLensTracer({device,provider:createConstantRayProvider(),width:96,workers:{bvh:false,pupil:false,focus:false},...options});
 await tracer.setLens(lens,{dispersion:false});tracer.setPose([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
 // The fake device runs no binning: report ten rays in cell 0 of every batch.
 const read=tracer.interop.readBuffer;
 tracer.interop.readBuffer=async(source,...rest)=>{
  const raw=await read(source,...rest);if(source.label!=='Ray cache: cell table')return raw;
  const words=new Uint32Array(raw);words[0]=10;words[1]=0;return raw;
 };
 return {device,tracer};
}
const buffersLabelled=(device,label)=>[...device.log.buffers].filter(b=>b.label===label);
const words=(buffer,offset=0,n=4)=>Array.from(new Uint32Array(buffer.data.buffer,offset,n));

test('held ray batches: trace-order finish, attempt offsets, preview, retry / rescue words and release',async()=>{
 const {device,tracer}=await fakeTracer();
 const a=await tracer.rayBatch({spp:8,targetSpp:32,hold:true}),b=await tracer.rayBatch({spp:8,targetSpp:32,hold:true});
 assert.equal(a.held,true);assert.equal(a.rays,10);
 assert.equal(tracer.tracedSpp,16);assert.equal(tracer.spp,0);assert.equal(tracer.engine.held.batches,2);
 assert.ok(tracer.engine.held.bytes>=a.bytes+b.bytes);
 // Render parameters word 33: the attempts traced before the batch over the same pixels.
 const renders=buffersLabelled(device,'Held ray batch: render parameters');
 assert.deepEqual(renders.map(r=>words(r,33*4,1)[0]),[0,8]);
 await assert.rejects(tracer.rayBatch({spp:8,targetSpp:32}),/held ray batches first/);
 assert.throws(()=>tracer.sample({batchSpp:1,targetSpp:32}),/ray batch is open/);
 assert.throws(()=>b.finish(),/trace order/);
 // Cell words at byte 32 of the batch's own parameters: index (| retry / rescue bit), first slot, count.
 const params=buffersLabelled(device,'Held ray batch: parameters');
 assert.equal(a.resolveAll(),true);assert.deepEqual(words(params[0],32,3),[0,0,10]);
 assert.equal(a.retry(0),true);assert.deepEqual(words(params[0],32,3),[CACHE_RETRY_BIT>>>0,0,10]);
 assert.equal(a.rescue(),true);assert.deepEqual(words(params[0],32,3),[CACHE_RESCUE_BIT,0,10]);
 assert.throws(()=>a.discard(),/band batch/);
 device.log.passes.length=0;tracer.resolve();
 assert.equal(device.log.passes.filter(p=>p.label==='Ray cache preview').length,2,'one preview pass per held batch');
 a.finish();
 assert.equal(tracer.spp,8);assert.equal(tracer.tracedSpp,16);assert.equal(words(renders[1],33*4,1)[0],0,'the later batch no longer counts the accumulated one');
 b.finish();
 assert.equal(tracer.spp,16);assert.equal(tracer.engine.held.batches,0);
 assert.equal(buffersLabelled(device,'Held ray batch: render parameters').length,0,'held buffers are released');
 assert.equal(buffersLabelled(device,'Ray cache: preview estimate').length,0);
 // Out of memory for a held batch: a coded error, nothing left allocated; reset drops held batches.
 const live=tracer.interop.liveBuffers;device.popErrorScope=()=>Promise.resolve({message:'Out of memory'});
 await assert.rejects(tracer.rayBatch({spp:8,targetSpp:32,hold:true}),e=>e.code==='ray-cache-memory');
 assert.equal(tracer.interop.liveBuffers,live);device.popErrorScope=()=>Promise.resolve(null);
 await tracer.rayBatch({spp:8,targetSpp:32,hold:true});tracer.reset();
 assert.equal(tracer.engine.held.batches,0);assert.equal(tracer.tracedSpp,0);
 // Without hold the cached path keeps one shared set of buffers and no attempt offset.
 const plain=await tracer.rayBatch({spp:8,targetSpp:32});
 assert.equal(plain.held,false);assert.equal(buffersLabelled(device,'Held ray batch: render parameters').length,0);
 plain.resolveAll();plain.finish();assert.equal(tracer.spp,8);
 tracer.dispose();
});

test('sensor bands: cover the frame without overlap, trace band by band, keep spp when split',async()=>{
 const {device,tracer}=await fakeTracer(),engine=tracer.engine,{blocksX,tiles}=engine.bandLayout,rows=tiles[0].rows;
 assert.equal(tiles.length,1);assert.equal(blocksX,6);assert.equal(rows,4);
 assert.throws(()=>engine.setBands([{tile:0,rows:[0,3]},{tile:0,rows:[2,4]}]),/overlap/);
 assert.throws(()=>engine.setBands([{tile:0,rows:[0,3]}]),/cover the frame/);
 assert.throws(()=>engine.setBands([{tile:0,rows:[0,4],cols:[0,7]}]),/columns/);
 engine.setBands([{tile:0,rows:[0,2]},{tile:0,rows:[2,4],cols:[0,2]},{tile:0,rows:[2,4],cols:[2,6]}]);
 assert.deepEqual(engine.bands.map(b=>[b.groups,b.spp,b.window]),[[12,0,false],[4,0,true],[8,0,true]]);
 await assert.rejects(tracer.rayBatch({spp:8,targetSpp:16,band:0}),/hold: true/);
 const first=await tracer.rayBatch({spp:8,targetSpp:16,hold:true,band:2});
 const render=buffersLabelled(device,'Held ray batch: render parameters')[0];
 // Cursor (word 29) at the band's first group; words 34/35: first column and width of the window.
 assert.equal(words(render,29*4,1)[0],2*blocksX);assert.deepEqual(words(render,34*4,2),[2,4]);
 assert.equal(engine.bands[2].held,8);assert.equal(tracer.tracedSpp,0);
 assert.throws(()=>engine.setBands([{tile:0,rows:[0,4]}]),/held ray batches/);
 first.finish();
 const again=await tracer.rayBatch({spp:8,targetSpp:16,hold:true,band:2});assert.equal(again.discard(),true);
 assert.equal(engine.bands[2].held,0);assert.equal(engine.bands[2].spp,8);
 // Splitting a traced band keeps its spp; a band across bands of different spp is refused.
 engine.setBands([{tile:0,rows:[0,2]},{tile:0,rows:[2,4],cols:[0,2]},{tile:0,rows:[2,3],cols:[2,6]},{tile:0,rows:[3,4],cols:[2,6]}]);
 assert.deepEqual(engine.bands.map(b=>b.spp),[0,0,8,8]);assert.equal(tracer.spp,0);
 assert.throws(()=>engine.setBands([{tile:0,rows:[0,2]},{tile:0,rows:[2,4]}]),/different spp/);
 for(let band=0;band<4;band++)for(let batch;(batch=await tracer.rayBatch({spp:8,targetSpp:16,hold:true,band}));)batch.finish();
 assert.deepEqual(engine.bands.map(b=>b.spp),[16,16,16,16]);assert.equal(tracer.spp,16);assert.equal(tracer.tracedSpp,16);
 tracer.reset();assert.equal(engine.bands,null);
 tracer.dispose();
});
