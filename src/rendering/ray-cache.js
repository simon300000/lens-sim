/** Ray cache: the lens side runs first and keeps a batch of S spp of optical
 * samples on the GPU, rays are binned by where they leave the front element,
 * and a host renders one view per cell and resolves just that cell's rays with
 * its ray radiance provider; a final pass accumulates every attempt exactly as
 * the direct staged path does.
 *
 * Cache layout (no quantization): the staged lens packets themselves, one
 * 48-byte OpticalSample per canonical pixel and sample shared by its four
 * mirrored rays (p and v negate per quadrant), i.e. 12 bytes per ray, plus a
 * 4-byte cell-sorted ray index and an 8-byte result per ray:
 *   ray index = (j * 4 + quadrant) * capacity + packet   (as the staged hit records)
 *   result    = (f32 spectral radiance at the sample's wavelength, flags)
 *   flags     = status | 256 invalid radiance | 512 reflection outside | layers << 16
 * Optical failures (blocked, TIR, numerical) are never binned; the accumulate
 * pass counts them as attempts like the direct path.
 *
 * Cells: an n x n grid over the exit disk (radius R, lens space mm) after a
 * per-batch rotation and sub-cell jitter, so cell borders move between batches.
 * Per cell the GPU records the ray count, sorted range, fixed-point exit-point
 * sum (centroid), exit bounds and lens-space direction bounds. */
export const CACHE_RAY_BYTES=48;           // per canonical sample (four rays)
export const CACHE_RESULT_BYTES=8;         // per ray
export const CACHE_INDEX_BYTES=4;          // per ray
export const CACHE_CELLS_MAX=256;          // n <= 16
export const CELL_STRIDE=20;               // u32 per cell record
export const CELL_FIXED_PER_MM=256;        // fixed-point exit sums: 1/256 mm
export const CACHE_SPP_LIMIT=64;           // compile-time bound of one batch
/** Bytes one canonical pixel needs per cached spp (packet + 4 results + 4 indices). */
export const CACHE_BYTES_PER_SAMPLE=CACHE_RAY_BYTES+4*(CACHE_RESULT_BYTES+CACHE_INDEX_BYTES);
const CELL={count:0,offset:1,cursor:2,sumX:4,sumY:6,minX:8,maxX:9,minY:10,maxY:11,dirMin:12,dirMax:15};
export const RAY_FLAGS=Object.freeze({INVALID:256,REFLECTION_OUTSIDE:512});

/** Batch size S and the number of canonical 8x8 packet groups that fit the
 * memory budget and the device's buffer limits; a frame that does not fit in
 * one batch is split by groups (resolved in several batches). */
export function planRayBatch({totalGroups,spp,memoryBytes,maxBufferBytes,fixedSpp=false}){
  const perGroup=s=>64*s*CACHE_BYTES_PER_SAMPLE;
  const limit=s=>Math.floor(Math.min(memoryBytes/perGroup(s),maxBufferBytes/(64*s*Math.max(CACHE_RAY_BYTES,4*CACHE_RESULT_BYTES))));
  let s=Math.max(1,Math.min(CACHE_SPP_LIMIT,Math.floor(spp)));
  // Prefer covering the whole tile per batch (fewer views); keep S once a round runs.
  while(!fixedSpp&&s>1&&limit(s)<totalGroups)s--;
  const groups=Math.min(totalGroups,limit(s));
  if(groups<1)throw new RangeError('Ray cache memory budget below one packet group');
  return {spp:s,groups,bytes:groups*perGroup(s)};
}

/** JS mirror of cacheCell() (f32 rounding aside): exit point (lens mm) -> cell. */
export function cellOf([x,y],{n,radiusMm,rotation=0,jitter=[0,0]}){
  const c=Math.cos(rotation),s=Math.sin(rotation),rx=c*x-s*y,ry=s*x+c*y;
  const q=(v,j)=>Math.min(n-1,Math.max(0,Math.floor((v/(2*radiusMm)+.5)*n+j)));
  return q(ry,jitter[1])*n+q(rx,jitter[0]);
}
/** Order-preserving f32 <-> u32 (atomicMin/Max on floats). */
export function orderedBits(x){const f=new Float32Array([x]),b=new Uint32Array(f.buffer)[0];return (b&0x80000000?~b:b|0x80000000)>>>0;}
export function fromOrderedBits(u){const b=new Uint32Array([(u&0x80000000)?u&0x7fffffff:~u]);return new Float32Array(b.buffer)[0];}
/** Read-back cell table -> per-cell statistics (lens space). */
export function decodeCells(words,{n,radiusMm}){
  const cells=[];
  for(let k=0;k<n*n;k++){
    const o=k*CELL_STRIDE,count=words[o+CELL.count];
    if(!count){cells.push({index:k,count:0,offset:words[o+CELL.offset]});continue;}
    const sum=a=>(words[o+a]+words[o+a+1]*4294967296)/CELL_FIXED_PER_MM;
    const centroidMm=[sum(CELL.sumX)/count-radiusMm,sum(CELL.sumY)/count-radiusMm];
    const exitBoundsMm=[CELL.minX,CELL.minY,CELL.maxX,CELL.maxY].map(a=>fromOrderedBits(words[o+a]));
    const directionMin=[0,1,2].map(a=>fromOrderedBits(words[o+CELL.dirMin+a])),directionMax=[0,1,2].map(a=>fromOrderedBits(words[o+CELL.dirMax+a]));
    // Largest exit-point distance from the centroid: the parallax baseline a centroid view must correct.
    const parallaxResidualMm=Math.max(...[[exitBoundsMm[0],exitBoundsMm[1]],[exitBoundsMm[2],exitBoundsMm[1]],[exitBoundsMm[0],exitBoundsMm[3]],[exitBoundsMm[2],exitBoundsMm[3]]].map(([x,y])=>Math.hypot(x-centroidMm[0],y-centroidMm[1])));
    cells.push({index:k,count,offset:words[o+CELL.offset],centroidMm,exitBoundsMm,directionMin,directionMax,parallaxResidualMm});
  }
  return cells;
}

/** Kernels of the cached path, from the staged integrator's pieces. */
export function rayCacheSources({work,types,opticsType,rayType,helpers,index,shading,sample,spectral,sampling}){
  const common=`
const CACHE_CELLS_MAX: u32 = ${CACHE_CELLS_MAX}u;
const CELL_STRIDE: u32 = ${CELL_STRIDE}u;
struct CacheParameters { grid: vec4f, jitter: vec4f, cell: vec4u }
@group(0) @binding(3) var<uniform> render:RenderParameters;
@group(0) @binding(19) var<uniform> cache:CacheParameters;
@group(0) @binding(21) var<storage,read> stagedRays:array<OpticalSample>;
fn cacheOrdered(x: f32) -> u32 { let b=bitcast<u32>(x); return select(b|0x80000000u,~b,(b&0x80000000u)!=0u); }
// grid: cos, sin, 1/(2R), n; jitter: xy cell offset, fixed-point scale, R
fn cacheCell(p: vec2f) -> u32 {
  let r=vec2f(cache.grid.x*p.x-cache.grid.y*p.y,cache.grid.y*p.x+cache.grid.x*p.y);
  let n=cache.grid.w;
  let q=clamp(floor((r*cache.grid.z+0.5)*n+cache.jitter.xy),vec2f(0.0),vec2f(n-1.0));
  return u32(q.y)*u32(n)+u32(q.x);
}
struct CachedRay { valid: bool, packet: u32, quadrant: u32, batch: u32, capacity: u32, sign: vec2f, c: vec2u, image: vec2u }
// The staged scene kernel's (packet, quadrant) mapping and per-destination batch.
fn cachedRay(id: vec3u) -> CachedRay {
  var r: CachedRay;
  let sceneWidth=bitcast<u32>(render.pinholeClipToCamera[0].x);
  let sceneGroup=(id.y/8u)*sceneWidth+id.x/8u;
  r.quadrant=sceneGroup%4u;let localGroup=sceneGroup/4u;
  let lane=(id.y%8u)*8u+id.x%8u;r.packet=localGroup*64u+lane;
  let halfWidth=(render.size.x+1u)/2u;let halfHeight=bitcast<u32>(render.environment.w);
  r.c=mirrorPixel(render.debug.y+localGroup,lane,halfWidth);
  let mirrorX=(r.quadrant&1u)!=0u;let mirrorY=(r.quadrant&2u)!=0u;
  r.image=vec2u(select(r.c.x,render.size.x-1u-r.c.x,mirrorX),select(r.c.y+render.settings.w,render.size.y-1u-render.settings.w-r.c.y,mirrorY));
  r.valid=sceneGroup<render.debug.w*4u&&r.c.x<halfWidth&&r.c.y<halfHeight&&!(mirrorX&&r.image.x==r.c.x);
  r.sign=vec2f(select(1.0,-1.0,mirrorX),select(1.0,-1.0,mirrorY));
  r.capacity=render.debug.w*64u;
  if(r.valid){
    let attempts=accumulation[outputIndex(r.c,r.quadrant)].attempts;
    let remaining=select(render.size.w-min(render.size.w,attempts),0xffffffffu-attempts,render.size.w==0u);
    r.batch=min(min(render.size.z,remaining),ROUND_SPP_LIMIT);
  }
  return r;
}
`;
  const prelude=work+types+rayType+index+common;
  const cellTable='@group(0) @binding(16) var<storage,read_write> cells:array<atomic<u32>>;\n';
  const readAccumulation='@group(0) @binding(4) var<storage,read> accumulation:array<PixelAccum>;\n';
  // Workgroup histograms, then one global update per (workgroup, cell).
  const bin=prelude+readAccumulation+cellTable+`
var<workgroup> wgCount: array<atomic<u32>, CACHE_CELLS_MAX>;
var<workgroup> wgSumX: array<atomic<u32>, CACHE_CELLS_MAX>;
var<workgroup> wgSumY: array<atomic<u32>, CACHE_CELLS_MAX>;
var<workgroup> wgBounds: array<atomic<u32>, ${CACHE_CELLS_MAX*10}>;
fn add64(word: u32, v: u32) {
  if (v == 0u) { return; }
  let old = atomicAdd(&cells[word], v);
  if (old > 0xffffffffu - v) { atomicAdd(&cells[word + 1u], 1u); }
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) li:u32){
  let K=u32(cache.grid.w)*u32(cache.grid.w);
  for(var k=li;k<K;k+=64u){
    atomicStore(&wgCount[k],0u);atomicStore(&wgSumX[k],0u);atomicStore(&wgSumY[k],0u);
    for(var b=0u;b<10u;b++){atomicStore(&wgBounds[k*10u+b],select(0u,0xffffffffu,b<2u||(b>=4u&&b<7u)));}
  }
  workgroupBarrier();
  let r=cachedRay(id);
  if(r.valid){
    for(var j=0u;j<r.batch;j++){
      let optical=stagedRays[j*r.capacity+r.packet];
      if(optical.status!=0u){continue;}
      let p=optical.p.xy*r.sign;let v=optical.v*vec3f(r.sign,1.0);
      let k=cacheCell(p);
      atomicAdd(&wgCount[k],1u);
      let R=cache.jitter.w;
      atomicAdd(&wgSumX[k],u32(round(clamp(p.x+R,0.0,2.0*R)*cache.jitter.z)));
      atomicAdd(&wgSumY[k],u32(round(clamp(p.y+R,0.0,2.0*R)*cache.jitter.z)));
      // 0 minX, 1 minY, 2 maxX, 3 maxY, 4..6 dirMin, 7..9 dirMax
      atomicMin(&wgBounds[k*10u],cacheOrdered(p.x));atomicMin(&wgBounds[k*10u+1u],cacheOrdered(p.y));
      atomicMax(&wgBounds[k*10u+2u],cacheOrdered(p.x));atomicMax(&wgBounds[k*10u+3u],cacheOrdered(p.y));
      for(var a=0u;a<3u;a++){atomicMin(&wgBounds[k*10u+4u+a],cacheOrdered(v[a]));atomicMax(&wgBounds[k*10u+7u+a],cacheOrdered(v[a]));}
    }
  }
  workgroupBarrier();
  for(var k=li;k<K;k+=64u){
    let count=atomicLoad(&wgCount[k]);
    if(count==0u){continue;}
    let o=k*CELL_STRIDE;
    atomicAdd(&cells[o],count);
    add64(o+4u,atomicLoad(&wgSumX[k]));add64(o+6u,atomicLoad(&wgSumY[k]));
    atomicMin(&cells[o+8u],atomicLoad(&wgBounds[k*10u]));atomicMax(&cells[o+9u],atomicLoad(&wgBounds[k*10u+2u]));
    atomicMin(&cells[o+10u],atomicLoad(&wgBounds[k*10u+1u]));atomicMax(&cells[o+11u],atomicLoad(&wgBounds[k*10u+3u]));
    for(var a=0u;a<3u;a++){atomicMin(&cells[o+12u+a],atomicLoad(&wgBounds[k*10u+4u+a]));atomicMax(&cells[o+15u+a],atomicLoad(&wgBounds[k*10u+7u+a]));}
  }
}
`;
  // Exclusive prefix sum over at most 256 cells: one invocation is enough.
  const scan=`
const CELL_STRIDE: u32 = ${CELL_STRIDE}u;
struct CacheParameters { grid: vec4f, jitter: vec4f, cell: vec4u }
@group(0) @binding(19) var<uniform> cache:CacheParameters;
${cellTable}
@compute @workgroup_size(1)
fn main(){
  let K=u32(cache.grid.w)*u32(cache.grid.w);
  var running=0u;
  for(var k=0u;k<K;k++){
    let o=k*CELL_STRIDE;let count=atomicLoad(&cells[o]);
    atomicStore(&cells[o+1u],running);atomicStore(&cells[o+2u],running);running+=count;
  }
}
`;
  // Workgroup-local slots after one global reservation per (workgroup, cell).
  const scatter=prelude+readAccumulation+cellTable+`
@group(0) @binding(17) var<storage,read_write> rayIndices:array<u32>;
var<workgroup> wgCount: array<atomic<u32>, CACHE_CELLS_MAX>;
var<workgroup> wgBase: array<u32, CACHE_CELLS_MAX>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) li:u32){
  let K=u32(cache.grid.w)*u32(cache.grid.w);
  for(var k=li;k<K;k+=64u){atomicStore(&wgCount[k],0u);}
  workgroupBarrier();
  let r=cachedRay(id);
  if(r.valid){for(var j=0u;j<r.batch;j++){let optical=stagedRays[j*r.capacity+r.packet];if(optical.status==0u){atomicAdd(&wgCount[cacheCell(optical.p.xy*r.sign)],1u);}}}
  workgroupBarrier();
  for(var k=li;k<K;k+=64u){
    let count=atomicLoad(&wgCount[k]);
    if(count>0u){wgBase[k]=atomicAdd(&cells[k*CELL_STRIDE+2u],count);}
    atomicStore(&wgCount[k],0u);
  }
  workgroupBarrier();
  if(r.valid){
    for(var j=0u;j<r.batch;j++){
      let optical=stagedRays[j*r.capacity+r.packet];
      if(optical.status!=0u){continue;}
      let k=cacheCell(optical.p.xy*r.sign);
      rayIndices[wgBase[k]+atomicAdd(&wgCount[k],1u)]=(j*4u+r.quadrant)*r.capacity+r.packet;
    }
  }
}
`;
  // One cell: the provider sees exactly the world ray and key of the direct path.
  const resolve=work+shading+spectral+sampling+opticsType+types+rayType+index+`
struct CacheParameters { grid: vec4f, jitter: vec4f, cell: vec4u }
@group(0) @binding(3) var<uniform> render:RenderParameters;
@group(0) @binding(4) var<storage,read> accumulation:array<PixelAccum>;
@group(0) @binding(17) var<storage,read> rayIndices:array<u32>;
@group(0) @binding(18) var<storage,read_write> rayResults:array<vec2u>;
@group(0) @binding(19) var<uniform> cache:CacheParameters;
@group(0) @binding(21) var<storage,read> stagedRays:array<OpticalSample>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id:vec3u){
  // cell: index, first sorted slot, ray count, dispatch width in workgroups
  let i=id.x+id.y*cache.cell.w*64u;
  if(i>=cache.cell.z){return;}
  let index=rayIndices[cache.cell.y+i];
  let capacity=render.debug.w*64u;let packet=index%capacity;let jq=index/capacity;let j=jq/4u;let quadrant=jq%4u;
  let halfWidth=(render.size.x+1u)/2u;
  let c=mirrorPixel(render.debug.y+packet/64u,packet%64u,halfWidth);
  let mirrorX=(quadrant&1u)!=0u;let mirrorY=(quadrant&2u)!=0u;
  let image=vec2u(select(c.x,render.size.x-1u-c.x,mirrorX),select(c.y+render.settings.w,render.size.y-1u-render.settings.w-c.y,mirrorY));
  let sign=vec2f(select(1.0,-1.0,mirrorX),select(1.0,-1.0,mirrorY));
  let attempts=accumulation[outputIndex(c,quadrant)].attempts+j;
  let key=spectralHash32((image.y*render.size.x+image.x)^spectralHash32(attempts+render.settings.x*0x632be5abu));
  let optical=stagedRays[j*capacity+packet];
  let worldOrigin=(render.cameraToWorld*vec4<f32>(optical.p*vec3<f32>(sign,1)*.001,1)).xyz;
  let worldDirection=normalize((render.cameraToWorld*vec4<f32>(optical.v*vec3<f32>(sign,1),0)).xyz);
  let scene=sceneRadianceFromRay(worldOrigin,worldDirection,optical.lambda,optical.weight,key);
  var flags=scene.status|select(0u,${RAY_FLAGS.REFLECTION_OUTSIDE}u,scene.reflectionOutside)|(scene.layers<<16u);
  var value=0.0;
  if(scene.status==SCENE_HIT||scene.status==SCENE_BACKGROUND){
    let rgb=scene.rgb;
    if(any(rgb<vec3<f32>(-1e-5))||any(abs(rgb)>vec3<f32>(1e30))||any(rgb!=rgb)){flags|=${RAY_FLAGS.INVALID}u;}
    else{value=spectralRadiance(max(rgb,vec3<f32>(0)),optical.lambda);}
  }
  rayResults[index]=vec2u(bitcast<u32>(value),flags);
}
`;
  // accumulateOptical with the scene answer read from the cell results.
  const accumulate=work+sample+spectral+sampling+opticsType+types+rayType+helpers+index+`
@group(0) @binding(0) var<uniform> optics:OpticsParameters;
@group(0) @binding(3) var<uniform> render:RenderParameters;
@group(0) @binding(4) var<storage,read_write> accumulation:array<PixelAccum>;
@group(0) @binding(5) var lensImage:texture_storage_2d<rgba16float,write>;
@group(0) @binding(18) var<storage,read> rayResults:array<vec2u>;
@group(0) @binding(21) var<storage,read> stagedRays:array<OpticalSample>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u){
  let sceneWidth=bitcast<u32>(render.pinholeClipToCamera[0].x);
  let sceneGroup=(id.y/8u)*sceneWidth+id.x/8u;
  if(sceneGroup>=render.debug.w*4u){return;}
  let quadrant=sceneGroup%4u;let localGroup=sceneGroup/4u;
  let lane=(id.y%8u)*8u+id.x%8u;let packet=localGroup*64u+lane;
  let halfWidth=(render.size.x+1u)/2u;let halfHeight=bitcast<u32>(render.environment.w);
  let c=mirrorPixel(render.debug.y+localGroup,lane,halfWidth);
  if(c.x>=halfWidth||c.y>=halfHeight){return;}
  let mirrorX=(quadrant&1u)!=0u;let mirrorY=(quadrant&2u)!=0u;
  let image=vec2u(select(c.x,render.size.x-1u-c.x,mirrorX),select(c.y+render.settings.w,render.size.y-1u-render.settings.w-c.y,mirrorY));
  if(mirrorX&&image.x==c.x){return;}
  let pixel=outputIndex(c,quadrant);var a=accumulation[pixel];
  let remaining=select(render.size.w-min(render.size.w,a.attempts),0xffffffffu-a.attempts,render.size.w==0u);
  let batch=min(min(render.size.z,remaining),ROUND_SPP_LIMIT);
  let capacity=render.debug.w*64u;
  for(var j=0u;j<batch;j++){
    let optical=stagedRays[j*capacity+packet];
    a.attempts++;workCounters[WORK_PATH]++;
    if(optical.status==1u){a.failures.x++;continue;}
    if(optical.status==2u){a.failures.y++;continue;}
    if(optical.status!=0u){a.failures.z++;continue;}
    a.queries.z++;
    let result=rayResults[(j*4u+quadrant)*capacity+packet];
    var scene:SceneSample;scene.status=result.y&255u;scene.reflectionOutside=(result.y&${RAY_FLAGS.REFLECTION_OUTSIDE}u)!=0u;scene.layers=result.y>>16u;
    recordScene(&a,scene);
    if(scene.status!=SCENE_HIT&&scene.status!=SCENE_BACKGROUND){continue;}
    if((result.y&${RAY_FLAGS.INVALID}u)!=0u){a.extra.y++;continue;}
    let contribution=cieXYZ(optical.lambda)*(bitcast<f32>(result.x)*optical.weight*SPECTRAL_XYZ_NORMALIZATION/(1./(optics.wavelength.y-optics.wavelength.x)));
    if(any(abs(contribution)>vec3<f32>(1e30))||any(contribution!=contribution)){a.extra.y++;continue;}
    a.xyz+=contribution;
  }
  accumulation[pixel]=a;textureStore(lensImage,vec2i(image),resolvePixel(a));
}
`;
  return {bin,scan,scatter,resolve,accumulate};
}
