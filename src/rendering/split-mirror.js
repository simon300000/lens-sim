import {normalizeShaderEOL,stripWorkCounting} from './shader-source.js';
/** Derived from the separate lens/scene experiment, adapted to mirrored batches.
 * One GPU-only lens-space packet per canonical pixel/sample; scene workgroups
 * interleave q0/q1/q2/q3 for each canonical block. No CPU ray readback. */
export const SPLIT_RAY_BYTES=48;
export function splitMirrorSources({integrator,optical,work,intersector,shading,spectral,sampling,pupil,counting=false}){
  integrator=normalizeShaderEOL(integrator);
  const fused=stripWorkCounting(integrator);
  const between=(s,a,b)=>{const i=s.indexOf(a),j=s.indexOf(b,i+a.length);if(i<0||j<0)throw new Error(`Split mirror delimiter missing: ${a}/${b}`);return s.slice(i,j);};
  const types=between(fused,'struct RenderParameters','@group(0) @binding(0)');
  const opticsType=between(optical,'struct OpticsParameters','struct RayResult');
  const rayAndLaunch=between(fused,'struct OpticalSample','fn accumulateOptical');
  const rayType=between(rayAndLaunch,'struct OpticalSample','fn sampleOptical');
  const helpers=between(fused,'const LINEAR_SRGB_TO_XYZ_M','@compute @workgroup_size');
  const accumulate=between(fused,'fn accumulateOptical','// Reflection has unit absolute Jacobian');
  const sceneResources=between(fused,'@group(0) @binding(6)','const LINEAR_SRGB_TO_XYZ_M');
  const index=`
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
@group(0) @binding(21) var<storage,read_write> splitRays:array<OpticalSample>;
`+index+`
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u){
  let localGroup=(id.y/8u)*render.debug.z+id.x/8u;
  if(localGroup>=render.debug.w){return;}
  let packet=localGroup*64u+(id.y%8u)*8u+id.x%8u;
  let halfWidth=(render.size.x+1u)/2u;let halfHeight=bitcast<u32>(render.environment.w);
  let linear=render.debug.y*64u+packet;
  if(linear>=halfWidth*halfHeight){return;}
  let c=vec2u(linear%halfWidth,linear/halfWidth);
  let image=c+vec2u(0,render.settings.w);
  let first=accumulation[outputIndex(c,0u)].attempts;
  let remaining=select(render.size.w-min(render.size.w,first),0xffffffffu-first,render.size.w==0u);
  let batch=min(min(render.size.z,remaining),4u);
  let capacity=render.debug.w*64u;
  for(var j=0u;j<batch;j++){
    splitRays[j*capacity+packet]=sampleOptical(image,first+j,render.settings.x,vec2f(1));
  }
}
`;
  const scene=work+intersector+shading+spectral+sampling+opticsType+types+rayType+common+`
@group(0) @binding(4) var<storage,read_write> accumulation:array<PixelAccum>;
@group(0) @binding(5) var lensImage:texture_storage_2d<rgba16float,write>;
@group(0) @binding(21) var<storage,read> splitRays:array<OpticalSample>;
`+sceneResources+helpers+accumulate+index+`
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u){
  let sceneWidth=bitcast<u32>(render.pinholeClipToCamera[0].x);
  let sceneGroup=(id.y/8u)*sceneWidth+id.x/8u;
  if(sceneGroup>=render.debug.w*4u){return;}
  let quadrant=sceneGroup%4u;let localGroup=sceneGroup/4u;
  let packet=localGroup*64u+(id.y%8u)*8u+id.x%8u;
  let halfWidth=(render.size.x+1u)/2u;let halfHeight=bitcast<u32>(render.environment.w);
  let linear=render.debug.y*64u+packet;
  if(linear>=halfWidth*halfHeight){return;}
  let c=vec2u(linear%halfWidth,linear/halfWidth);
  let mirrorX=(quadrant&1u)!=0u;let mirrorY=(quadrant&2u)!=0u;
  let image=vec2u(select(c.x,render.size.x-1u-c.x,mirrorX),select(c.y+render.settings.w,render.size.y-1u-render.settings.w-c.y,mirrorY));
  if(mirrorX&&image.x==c.x){return;}
  let pixel=outputIndex(c,quadrant);var a=accumulation[pixel];
  let remaining=select(render.size.w-min(render.size.w,a.attempts),0xffffffffu-a.attempts,render.size.w==0u);
  let batch=min(min(render.size.z,remaining),4u);
  let capacity=render.debug.w*64u;
  let sign=vec2f(select(1.0,-1.0,mirrorX),select(1.0,-1.0,mirrorY));
  let globalPixel=image.y*render.size.x+image.x;
  for(var j=0u;j<batch;j++){
    let ray=splitRays[j*capacity+packet];
    let key=spectralHash32(globalPixel^spectralHash32(a.attempts+render.settings.x*0x632be5abu));
    a.attempts++;workCounters[WORK_PATH]++;
    accumulateOptical(&a,ray,sign,key);
  }
  accumulation[pixel]=a;textureStore(lensImage,vec2i(image),resolvePixel(a));
}
`;
  if(!counting)return {raygen,scene};
  const blocks=[...integrator.matchAll(/\/\/ WORK-COUNTING-BEGIN[^\n]*\n([\s\S]*?)\/\/ WORK-COUNTING-END/g)].map(m=>m[1]);
  if(blocks.length!==2)throw new Error('Work counter reduction changed');
  const entry='@compute @workgroup_size(8,8)\nfn main(@builtin(global_invocation_id) id:vec3u)';
  const counted=source=>{
    if(!source.includes(entry))throw new Error('Split stage entry changed');
    // Early returns leave only integrateStage. All lanes, including padding,
    // always reach the reduction barrier in main.
    return source.replace(entry,'fn integrateStage(id:vec3u)')+blocks[0].replace('@binding(21)','@binding(22)')+`
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) lane:u32){
  integrateStage(id);
${blocks[1]}
}
`;
  };
  return {raygen:counted(raygen),scene:counted(scene)};
}

/** Preserve the fused GPU source/layout on devices that retain that path. */
export function linearMirrorGroups(source){
  source=normalizeShaderEOL(source);
  const old='  let groupsX=(halfWidth+7u)/8u;\n  let chunkGroup=(id.y/8u)*render.debug.z+id.x/8u;\n  let group=render.debug.y+chunkGroup;\n  let canonicalLocal=vec2<u32>((group%groupsX)*8u+id.x%8u,(group/groupsX)*8u+id.y%8u);\n  if(chunkGroup>=render.debug.w||canonicalLocal.x>=halfWidth||canonicalLocal.y>=halfHeight){return;}\n';
  const next='  let chunkGroup=(id.y/8u)*render.debug.z+id.x/8u;\n  let group=render.debug.y+chunkGroup;\n  let linear=group*64u+(id.y%8u)*8u+id.x%8u;\n  if(chunkGroup>=render.debug.w||linear>=halfWidth*halfHeight){return;}\n  let canonicalLocal=vec2<u32>(linear%halfWidth,linear/halfWidth);\n';
  if(!source.includes(old))throw new Error('Mirror group mapping changed');
  return source.replace(old,next);
}
