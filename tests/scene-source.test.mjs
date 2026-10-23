import test from 'node:test';
import assert from 'node:assert/strict';
import {createSceneBuilder} from '../src/scene/scene-builder.js';
import {normalizeBlasSource,INSTANCE_FLAGS,SIDE} from '../src/scene/scene-source.js';
import {bruteForceIntersect,traversePacked} from '../src/scene/scene-reference.js';
import {rng} from './scene-fixtures.js';

/** Ghost-like geometry: native streams as plain arrays, no three.js objects. */
function grid(n,size,{uint16=false}={}){
  const positions=new Float32Array((n+1)*(n+1)*3),indices=new (uint16?Uint16Array:Uint32Array)(n*n*6);
  for(let j=0;j<=n;j++)for(let i=0;i<=n;i++){const k=(j*(n+1)+i)*3;positions[k]=(i/n-.5)*size;positions[k+1]=Math.sin(i*.37)*Math.cos(j*.23)*size*.02;positions[k+2]=(j/n-.5)*size;}
  let t=0;for(let j=0;j<n;j++)for(let i=0;i<n;i++){const a=j*(n+1)+i,b=a+1,c=a+n+1,d=c+1;indices.set([a,c,b,b,c,d],t);t+=6;}
  return {positions,indices};
}
function leaf(){ // non-indexed card with uv and rgb colour, no normals
  const positions=new Float32Array([-.2,0,0,.2,0,0,0,.5,0, -.2,0,0,0,.5,0,-.2,.5,0]);
  return {positions,uvs:new Float32Array(12),colors:new Float32Array(18).fill(.5)};
}
const translate=(x,y,z,s=1)=>[s,0,0,0,0,s,0,0,0,0,s,0,x,y,z,1];
const flags=SIDE.DOUBLE|INSTANCE_FLAGS.RECEIVE_SHADOW;

function ghostScene({terrain=64,trees=200,origin=[50000,120,-30000]}={}){
  const r=rng(9),instanceMatrices=new Float32Array(trees*16);
  for(let k=0;k<trees;k++){const a=r()*Math.PI*2,s=.6+r();instanceMatrices.set([Math.cos(a)*s,0,-Math.sin(a)*s,0,0,s,0,0,Math.sin(a)*s,0,Math.cos(a)*s,0,(r()-.5)*180,0,(r()-.5)*180,1],k*16);}
  return {
    blas:[{key:'terrain',...grid(terrain,200)},{key:'rock',...grid(6,2,{uint16:true})},{key:'leaf',...leaf()}],
    instances:[
      {blas:0,matrixWorld:translate(...origin),material:0,flags:SIDE.FRONT},
      {blas:1,matrixWorld:translate(origin[0]+3,origin[1]+1,origin[2]-4,1.5),material:1,flags},
      {blas:2,matrixWorld:translate(...origin),instanceMatrices,count:trees,colors:new Float32Array(trees*3).fill(1),material:2,flags},
    ]};
}

test('scene sources accept optional attributes, Uint16/absent indices and per-instance records',()=>{
 const card=normalizeBlasSource({key:'leaf',...leaf()});
 assert.deepEqual(Array.from(card.indices),[0,1,2,3,4,5]);assert.equal(card.colorSize,3);assert.equal(card.hasNormal,false);
 assert.ok(card.points.length===card.vertexCount*3,'small meshes keep exact-bound points');
 assert.throws(()=>normalizeBlasSource({key:'x',positions:new Float32Array(9),indices:new Uint32Array([0,1,7])}),/outside 3 vertices/);
 assert.throws(()=>normalizeBlasSource({key:'x',positions:new Float32Array(9),alphaMask:{}}),/alpha masks/);
 const builder=createSceneBuilder(),source=ghostScene({terrain:16,trees:40,origin:[0,0,0]});
 const {packed,instances}=builder.build(source);
 assert.equal(instances.count,42);
 // Default attributes: normal +y, uv 0, white; rgb colours get alpha 1.
 const v=new Float32Array(packed.vertices),leafVertex=(17*17+7*7)*12;
 assert.deepEqual(Array.from(v.subarray(leafVertex,leafVertex+3)),[0,1,0]);assert.deepEqual(Array.from(v.subarray(leafVertex+8,leafVertex+12)),[.5,.5,.5,1]);
});

test('scene source -> packed BVH equals f64 brute force on a recentred Ghost-like scene',()=>{
 const origin=[50000,120,-30000],builder=createSceneBuilder(),source=ghostScene({terrain:24,trees:60,origin});
 // Recentred: the world frame starts at the camera's neighbourhood, transforms stay f32-exact near it.
 const {packed,instances}=builder.build({...source,origin});
 const reference={blas:source.blas.map(b=>{const n=normalizeBlasSource(b);return {...n,primitiveIds:Uint32Array.from({length:n.triangleCount},(_,i)=>i)};}),instances};
 const r=rng(4);let hits=0;
 for(let i=0;i<600;i++){
  const o=[(r()-.5)*150,2+r()*20,(r()-.5)*150],d=[(r()-.5),-.3-r(),(r()-.5)];
  const ref=bruteForceIntersect(reference,o,d),got=traversePacked(packed,o,d).hit;
  assert.equal(!!got,!!ref,`ray ${i} hit/miss`);
  if(!ref)continue;hits++;
  assert.ok(Math.abs(got.t-ref.t)<=1e-4*Math.max(1,ref.t),`ray ${i} t ${got.t} vs ${ref.t}`);
  assert.equal(got.primitive,ref.primitive);assert.equal(got.material,ref.material);
 }
 assert.ok(hits>300,`hits ${hits}`);
 // Transform-only update: BLAS sources by key, TLAS rebuilt only.
 const again=builder.build({blas:source.blas.map(b=>({key:b.key})),instances:source.instances,origin:[origin[0]+1,origin[1],origin[2]]});
 assert.equal(again.packed.stats.timing.blasRebuilt,0);assert.equal(again.packed.stats.timing.blasReused,3);
 assert.throws(()=>builder.build({blas:[{key:'unknown'}],instances:[]}),/no BLAS source unknown/);
});

test('large instanced/indexed scene source: build time and packed memory',()=>{
 const before=process.memoryUsage().heapUsed+process.memoryUsage().arrayBuffers,started=performance.now();
 // ~1.3 M unique triangles (one indexed terrain) and 100 k leaf-card instances.
 const source=ghostScene({terrain:800,trees:100000});
 const {packed,instances}=createSceneBuilder().build({...source,origin:[50000,120,-30000]});
 const ms=performance.now()-started,bytes=Object.values(packed.stats.bytes).reduce((a,b)=>a+b,0);
 const after=process.memoryUsage().heapUsed+process.memoryUsage().arrayBuffers;
 const t=packed.stats.timing;
 console.log(`[scene-source] ${packed.stats.triangles} triangles, ${instances.count} instances: wall ${ms.toFixed(0)} ms (normalize ${t.normalizeMs}, BLAS ${t.blasMs}, expand ${t.expandMs}, TLAS ${t.tlasMs}, pack ${t.packMs} ms); GPU buffers ${(bytes/2**20).toFixed(1)} MiB; JS heap+buffers +${((after-before)/2**20).toFixed(0)} MiB; stack bound ${packed.stats.stackBound}`);
 assert.equal(packed.stats.triangles,800*800*2+6*6*2+2);assert.equal(instances.count,100002);
 assert.ok(packed.stats.stackBound<=64);
 // Rays from above land on the terrain or a leaf; no traversal of everything.
 const r=rng(5);let hit=0,maxVisits=0;
 for(let i=0;i<50;i++){const res=traversePacked(packed,[(r()-.5)*150,30,(r()-.5)*150],[r()-.5,-1,r()-.5]);if(res.hit)hit++;maxVisits=Math.max(maxVisits,res.visits);}
 assert.ok(hit>=45&&maxVisits<20000,`hits ${hit}, visits ${maxVisits}`);
});
