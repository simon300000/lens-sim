import {normalizeShaderEOL,stripWorkCounting} from './shader-source.js';
import {ROUND_SPP_LIMIT,roundSppWGSL} from './sampling-plan.js';
/** Three-stage mirrored integration.
 * One GPU-only lens-space packet per canonical pixel/sample; scene workgroups
 * interleave q0/q1/q2/q3 for each canonical 8x8 block. No CPU ray readback. */
export const STAGED_RAY_BYTES=48;
/** Staged mode: one first-hit record per (sample, quadrant) packet. A packet slot holds
 * ROUND_SPP_LIMIT samples of one canonical pixel, each with four quadrant hits. */
export const STAGED_HIT_BYTES=32;
/** Default bound on the lens-sample packet scratch; the hit records add 8/3 of it (so
 * 256 MiB of packets + ~683 MiB of hits at most). Images whose 4 spp round is smaller
 * allocate only what the round needs (a 1920-wide frame: 118 + 315 MiB). */
export const STAGED_SCRATCH_BYTES=256*1024**2;
/** A lean traversal kernel runs between the lens batch and shading:
 * it writes the nearest hit of every optical sample's four quadrant rays, and the
 * scene kernel composites from that record (transparent layers continue inline).
 * The traversal then runs without the shading/optics register footprint. */
export function stagedIntegratorSources({integrator,optical,work,intersector,shading,spectral,sampling,pupil,counting=false,roundSppLimit=ROUND_SPP_LIMIT}){
  work=roundSppWGSL(roundSppLimit)+work;
  integrator=normalizeShaderEOL(integrator);
  const source=stripWorkCounting(integrator);
  const between=(s,a,b)=>{const i=s.indexOf(a),j=s.indexOf(b,i+a.length);if(i<0||j<0)throw new Error(`Staged integrator delimiter missing: ${a}/${b}`);return s.slice(i,j);};
  const types=between(source,'struct RenderParameters','@group(0) @binding(0)');
  const opticsType=between(optical,'struct OpticsParameters','struct RayResult');
  const rayAndLaunch=between(source,'struct OpticalSample','fn accumulateOptical');
  const rayType=between(rayAndLaunch,'struct OpticalSample','fn sampleOptical');
  const helpers=between(source,'const LINEAR_SRGB_TO_XYZ_M','@compute @workgroup_size');
  let accumulate=between(source,'fn accumulateOptical','// Reflection has unit absolute Jacobian');
  // Same accumulation, but layer 0 comes from the traversal kernel's record.
  const signature='fn accumulateOptical(a:ptr<function,PixelAccum>,optical:OpticalSample,sign:vec2<f32>,key:u32){',call='let scene=sceneRadiance(worldOrigin,worldDirection,key);';
  if(!accumulate.includes(signature)||!accumulate.includes(call))throw new Error('Staged accumulation anchors changed');
  accumulate=accumulate.replace(signature,'fn accumulateOptical(a:ptr<function,PixelAccum>,optical:OpticalSample,sign:vec2<f32>,key:u32,hit:SceneHit){').replace(call,'let scene=sceneRadianceFromHit(worldOrigin,worldDirection,key,hit);');
  const hitRecord=`
struct SceneHitRecord { t:f32, b1:f32, b2:f32, instance:u32, triangle:u32, status:u32, error:u32, front:u32 }
fn packHit(h:SceneHit)->SceneHitRecord { return SceneHitRecord(h.t,h.b1,h.b2,h.instance,h.triangle,h.status,h.error,select(0u,1u,h.front)); }
fn unpackHit(r:SceneHitRecord)->SceneHit { var h:SceneHit; h.t=r.t; h.b1=r.b1; h.b2=r.b2; h.instance=r.instance; h.triangle=r.triangle; h.status=r.status; h.error=r.error; h.front=r.front!=0u; h.visits=0u; return h; }
`;
  const sceneResources=between(source,'@group(0) @binding(6)','const LINEAR_SRGB_TO_XYZ_M');
  const index=`
// Packet slots enumerate 8x8 blocks of the canonical quadrant: a warp then covers a compact 8x4 pixel footprint.
fn mirrorPixel(group:u32,lane:u32,halfWidth:u32)->vec2u {
  let blocksX=(halfWidth+7u)/8u;
  return vec2u((group%blocksX)*8u+lane%8u,(group/blocksX)*8u+lane/8u);
}
fn outputIndex(c:vec2u,q:u32)->u32 {
  let halfHeight=bitcast<u32>(render.environment.w);
  let x=select(c.x,render.size.x-1u-c.x,(q&1u)!=0u);
  return (c.y+select(0u,halfHeight,(q&2u)!=0u))*render.size.x+x;
}
`;
  const common=`@group(0) @binding(0) var<uniform> optics:OpticsParameters;
@group(0) @binding(3) var<uniform> render:RenderParameters;
`;
  const raygen=work+optical+sampling+pupil+types+rayAndLaunch+common+`
@group(0) @binding(1) var<storage,read> opticalSurfaces:array<OpticalSurface>;
@group(0) @binding(2) var<storage,read> glassLut:array<f32>;
@group(0) @binding(4) var<storage,read> accumulation:array<PixelAccum>;
@group(0) @binding(21) var<storage,read_write> stagedRays:array<OpticalSample>;
`+index+`
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u){
  let localGroup=(id.y/8u)*render.debug.z+id.x/8u;
  if(localGroup>=render.debug.w){return;}
  let lane=(id.y%8u)*8u+id.x%8u;let packet=localGroup*64u+lane;
  let halfWidth=(render.size.x+1u)/2u;let halfHeight=bitcast<u32>(render.environment.w);
  let c=mirrorPixel(render.debug.y+localGroup,lane,halfWidth);
  if(c.x>=halfWidth||c.y>=halfHeight){return;}
  let image=c+vec2u(0,render.settings.w);
  let first=accumulation[outputIndex(c,0u)].attempts;
  let remaining=select(render.size.w-min(render.size.w,first),0xffffffffu-first,render.size.w==0u);
  let batch=min(min(render.size.z,remaining),ROUND_SPP_LIMIT);
  let capacity=render.debug.w*64u;
  for(var j=0u;j<batch;j++){
    stagedRays[j*capacity+packet]=sampleOptical(image,first+j,render.settings.x,vec2f(1));
  }
}
`;
  let scene=work+intersector+shading+spectral+sampling+opticsType+types+rayType+common+`
@group(0) @binding(4) var<storage,read_write> accumulation:array<PixelAccum>;
@group(0) @binding(5) var lensImage:texture_storage_2d<rgba16float,write>;
@group(0) @binding(21) var<storage,read> stagedRays:array<OpticalSample>;
`+'@group(0) @binding(23) var<storage,read> stagedHits:array<SceneHitRecord>;'+hitRecord+sceneResources+helpers+accumulate+index+`
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
  let sign=vec2f(select(1.0,-1.0,mirrorX),select(1.0,-1.0,mirrorY));
  let globalPixel=image.y*render.size.x+image.x;
  for(var j=0u;j<batch;j++){
    let ray=stagedRays[j*capacity+packet];
    let key=spectralHash32(globalPixel^spectralHash32(a.attempts+render.settings.x*0x632be5abu));
    a.attempts++;workCounters[WORK_PATH]++;
    accumulateOptical(&a,ray,sign,key,unpackHit(stagedHits[(j*4u+quadrant)*capacity+packet]));
  }
  accumulation[pixel]=a;textureStore(lensImage,vec2i(image),resolvePixel(a));
}
`;
  // Traversal kernel: the same packet/quadrant mapping and the same world ray as
  // accumulateOptical, nearest hit only (SCENE_FAR = 1e7 as in scene-shading.wgsl).
  // Optical failures write nothing; the scene kernel reads the hit only for status 0.
  const trace=work+intersector+types+rayType+`
@group(0) @binding(3) var<uniform> render:RenderParameters;
@group(0) @binding(4) var<storage,read> accumulation:array<PixelAccum>;
@group(0) @binding(6) var<storage,read> sceneNodes:array<BvhNode>;
@group(0) @binding(7) var<storage,read> sceneInstances:array<SceneInstance>;
@group(0) @binding(8) var<storage,read> sceneTriangles:array<SceneTriangle>;
@group(0) @binding(21) var<storage,read> stagedRays:array<OpticalSample>;
@group(0) @binding(23) var<storage,read_write> stagedHits:array<SceneHitRecord>;
`+hitRecord+index+`
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
  let attempts=accumulation[outputIndex(c,quadrant)].attempts;
  let remaining=select(render.size.w-min(render.size.w,attempts),0xffffffffu-attempts,render.size.w==0u);
  let batch=min(min(render.size.z,remaining),ROUND_SPP_LIMIT);
  let capacity=render.debug.w*64u;
  let sign=vec2f(select(1.0,-1.0,mirrorX),select(1.0,-1.0,mirrorY));
  for(var j=0u;j<batch;j++){
    let optical=stagedRays[j*capacity+packet];
    if(optical.status!=0u){continue;}
    let worldOrigin=(render.cameraToWorld*vec4<f32>(optical.p*vec3<f32>(sign,1)*.001,1)).xyz;
    let worldDirection=normalize((render.cameraToWorld*vec4<f32>(optical.v*vec3<f32>(sign,1),0)).xyz);
    stagedHits[(j*4u+quadrant)*capacity+packet]=packHit(sceneIntersect(worldOrigin,worldDirection,0.0,1.0e7));
  }
}
`;
  if(!counting)return {raygen,trace,scene};
  const blocks=[...integrator.matchAll(/\/\/ WORK-COUNTING-BEGIN[^\n]*\n([\s\S]*?)\/\/ WORK-COUNTING-END/g)].map(m=>m[1]);
  if(blocks.length!==2)throw new Error('Work counter reduction changed');
  const entry='@compute @workgroup_size(8,8)\nfn main(@builtin(global_invocation_id) id:vec3u)';
  const counted=source=>{
    if(!source.includes(entry))throw new Error('Split stage entry changed');
    // Early returns stay inside integrateStage, so every lane, padding included,
    // reaches the tally adds in main.
    return source.replace(entry,'fn integrateStage(id:vec3u)')+blocks[0].replace('@binding(21)','@binding(22)')+`
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u){
  integrateStage(id);
${blocks[1]}
}
`;
  };
  return {raygen:counted(raygen),trace:counted(trace),scene:counted(scene)};
}
