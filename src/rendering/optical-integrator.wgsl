// Shared staged shading/launch helpers and diagnostic reference integration.
// Reference path: pixel/pupil/wavelength sample -> reverse real-lens
// trace -> BVH nearest real surface -> material + raster-resource lighting ->
// RGB->spectral XYZ -> f32 progressive accumulation. One invocation per pixel.
// Validation explicitly retraces each quadrant; production uses staged-integrator.js.
struct RenderParameters {
  cameraToWorld: mat4x4<f32>,
  size: vec4<u32>,      // width, height, batch spp, target attempted spp
  settings: vec4<u32>,  // seed, diagnostic mode, test constant environment, tile y offset
  environment: vec4<f32>, // xyz: test constant radiance; w: bitcast paired band half-height
  debug: vec4<u32>,     // x: 0 independent, 1 pinhole, 2 mirror, 3 hybrid, 4 retraced reference; yzw: chunk layout
  pinholeClipToCamera: mat4x4<f32>,
};
// 64 bytes. failures: optical blocked, TIR, optical numerical, BVH traversal error.
// queries: scene hit, background, optical passed, scene unsupported.
// extra: transparency limit, invalid radiance, water reflection outside the
// reference view, transparent layers traversed.
struct PixelAccum {
  xyz: vec3<f32>, attempts: u32,
  failures: vec4<u32>,
  queries: vec4<u32>,
  extra: vec4<u32>,
};
@group(0) @binding(0) var<uniform> optics: OpticsParameters;
@group(0) @binding(1) var<storage,read> opticalSurfaces: array<OpticalSurface>;
@group(0) @binding(2) var<storage,read> glassLut: array<f32>;
@group(0) @binding(3) var<uniform> render: RenderParameters;
@group(0) @binding(4) var<storage,read_write> accumulation: array<PixelAccum>;
@group(0) @binding(5) var lensImage: texture_storage_2d<rgba16float,write>;
@group(0) @binding(6) var<storage,read> sceneNodes: array<BvhNode>;
@group(0) @binding(7) var<storage,read> sceneInstances: array<SceneInstance>;
@group(0) @binding(8) var<storage,read> sceneTriangles: array<SceneTriangle>;
@group(0) @binding(9) var<storage,read> sceneVertices: array<SceneVertex>;
@group(0) @binding(10) var<storage,read> sceneTables: array<vec4<u32>>;
@group(0) @binding(11) var<uniform> sceneLighting: SceneLighting;
@group(0) @binding(12) var sceneSunShadow: texture_depth_2d;
@group(0) @binding(13) var sceneMoonShadow: texture_depth_2d;
@group(0) @binding(14) var scenePointShadow0: texture_depth_cube;
@group(0) @binding(15) var scenePointShadow1: texture_depth_cube;
@group(0) @binding(16) var sceneEnvironment: texture_2d<f32>;
@group(0) @binding(17) var sceneReflection: texture_2d<f32>;
@group(0) @binding(18) var sceneCompareSampler: sampler_comparison;
@group(0) @binding(19) var sceneLinearSampler: sampler;
// WORK-COUNTING-BEGIN  (compiled only into the diagnostics variant; needs a 9th storage buffer)
// 64-bit work totals as (low, high) u32 pairs.
@group(0) @binding(21) var<storage,read_write> workTotals: array<atomic<u32>>;
// One 64-bit add per lane and nonzero counter. A workgroup-memory pre-reduction
// measured slower on the RTX 4090 (its barrier and serial sums cost more than the
// L2 atomics) and doubled the lens kernel's time.
fn workAdd(counter: u32, v: u32) {
  if (v == 0u) { return; }
  let old = atomicAdd(&workTotals[counter * 2u], v);
  if (old > 0xffffffffu - v) { atomicAdd(&workTotals[counter * 2u + 1u], 1u); }
}
// WORK-COUNTING-END

const LINEAR_SRGB_TO_XYZ_M = mat3x3<f32>(
  vec3<f32>(0.4124564, 0.2126729, 0.0193339),
  vec3<f32>(0.3575761, 0.7151522, 0.1191920),
  vec3<f32>(0.1804375, 0.0721750, 0.9503041));
const MODE_BEAUTY: u32 = 0u;
const MODE_GEOMETRY_DEPTH: u32 = 3u;
const MODE_GEOMETRY_NORMAL: u32 = 4u;
const MODE_GEOMETRY_MATERIAL: u32 = 5u;

fn resolvePixel(a: PixelAccum)->vec4<f32>{
  let n=f32(max(a.attempts,1u));
  var rgb=xyzToLinearSRGB(a.xyz/n);
  let passed=f32(max(a.queries.z,1u));
  if(render.settings.y==1u){rgb=vec3<f32>(f32(a.failures.w+a.extra.x)/passed,f32(a.queries.w)/passed,f32(a.extra.z)/passed);}
  if(render.settings.y==2u){rgb=vec3<f32>(f32(a.failures.z+a.extra.y)/n,f32(a.failures.x+a.failures.y)/n,f32(a.queries.x)/n);}
  // Negative RGB after XYZ conversion is out-of-gamut, not negative photon flux.
  return vec4<f32>(clamp(rgb,vec3<f32>(0),vec3<f32>(65000)),1);
}
fn materialDebugColour(index: u32) -> vec3<f32> {
  let h = spectralHash32(index * 0x9e3779b9u + 17u);
  return vec3<f32>(f32(h & 255u), f32((h >> 8u) & 255u), f32((h >> 16u) & 255u)) / 255.0 * 0.8 + 0.1;
}
fn geometryDebug(scene: SceneSample) -> vec3<f32> {
  if (scene.firstT < 0.0) { return vec3<f32>(0.0); }
  if (render.settings.y == MODE_GEOMETRY_DEPTH) { return vec3<f32>(exp(-scene.firstT / 15.0)); }
  if (render.settings.y == MODE_GEOMETRY_NORMAL) { return scene.firstNormal * 0.5 + 0.5; }
  return materialDebugColour(scene.firstMaterial);
}
fn recordScene(a: ptr<function, PixelAccum>, scene: SceneSample) {
  switch scene.status {
    case 4u: { (*a).queries.x++; }
    case 5u: { (*a).queries.y++; }
    case 7u: { (*a).queries.w++; }
    case 8u: { (*a).failures.w++; }
    case 9u: { (*a).extra.x++; }
    default: { (*a).failures.w++; }
  }
  if (scene.reflectionOutside) { (*a).extra.z++; }
  (*a).extra.w += scene.layers;
}

@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3<u32>){
  if(render.debug.x>=2u){integrateMirrors(id);}else{integratePixel(id);}
  // WORK-COUNTING-BEGIN
  // Constant indices only: a dynamic index would move workCounters out of registers
  // and slow every tally in the traversal loops.
  workAdd(0u, workCounters[0]);
  workAdd(1u, workCounters[1]);
  workAdd(2u, workCounters[2]);
  workAdd(3u, workCounters[3]);
  workAdd(4u, workCounters[4]);
  workAdd(5u, workCounters[5]);
  workAdd(6u, workCounters[6]);
  workAdd(7u, workCounters[7]);
  workAdd(8u, workCounters[8]);
  workAdd(9u, workCounters[9]);
  workAdd(10u, workCounters[10]);
  workAdd(11u, workCounters[11]);
  workAdd(12u, workCounters[12]);
  workAdd(13u, workCounters[13]);
  workAdd(14u, workCounters[14]);
  workAdd(15u, workCounters[15]);
  // WORK-COUNTING-END
}
fn integratePixel(id:vec3<u32>){
  // Storage tiles keep their original layout. Scheduling chunks only select
  // workgroups within that tile, preserving pixel IDs and random sequences.
  let groupsX=(render.size.x+7u)/8u;
  let chunkGroup=(id.y/8u)*render.debug.z+id.x/8u;
  if(render.debug.w!=0u&&chunkGroup>=render.debug.w){return;}
  let linearGroup=render.debug.y+chunkGroup;
  let imageX=select(id.x,(linearGroup%groupsX)*8u+id.x%8u,render.debug.w!=0u);
  let localY=select(id.y,(linearGroup/groupsX)*8u+id.y%8u,render.debug.w!=0u);
  let halfHeight=bitcast<u32>(render.environment.w);
  if(halfHeight>0u&&localY>=halfHeight*2u){return;}
  let imageY=select(localY+render.settings.w,render.size.y-1u-render.settings.w-(localY-halfHeight),halfHeight>0u&&localY>=halfHeight);
  if(imageX>=render.size.x||imageY>=render.size.y){return;}
  let pixel=localY*render.size.x+imageX;
  var a=accumulation[pixel];
  let remaining=select(render.size.w-min(render.size.w,a.attempts),0xffffffffu-a.attempts,render.size.w==0u);
  let batch=min(render.size.z,remaining);
  let geometryMode=render.settings.y>=MODE_GEOMETRY_DEPTH;
  // batch <= 4 is a runtime value, so this loop is not unrolled.
  for(var j=0u;j<min(batch,4u);j++){
    let index=a.attempts;
    workCounters[WORK_PATH]++;
    let globalPixel=imageY*render.size.x+imageX;
    let key=spectralHash32(globalPixel^spectralHash32(index+render.settings.x*0x632be5abu));
    a.attempts++;
    var worldOrigin:vec3<f32>;var worldDirection:vec3<f32>;
    var lambda=0.0;var weight=1.0;
    let pinhole=render.debug.x==1u;
    if(pinhole){
      // Diagnostic pinhole: pixel-centre ray of the reference camera. Used
      // only by the raster/compute shading comparison test.
      let ndc=vec2<f32>((f32(imageX)+0.5)/f32(render.size.x)*2.0-1.0,1.0-(f32(imageY)+0.5)/f32(render.size.y)*2.0);
      let viewH=render.pinholeClipToCamera*vec4<f32>(ndc,0.5,1.0);
      workCounters[WORK_CAMERA_TRANSFORM]++;
      worldOrigin=(render.cameraToWorld*vec4<f32>(0,0,0,1)).xyz;
      worldDirection=normalize((render.cameraToWorld*vec4<f32>(viewH.xyz/viewH.w,0)).xyz);
    }else{
      workCounters[WORK_OPTICAL_LAUNCH]++;
      let jitter=vec2<f32>(sampleDimension(globalPixel,index,0u,render.settings.x),sampleDimension(globalPixel,index,1u,render.settings.x));
      let uv=(vec2<f32>(f32(imageX),f32(imageY))+jitter)/vec2<f32>(render.size.xy);
      // A real sensor image is inverted. Stored output y=0 is the displayed top.
      let sensor=vec3<f32>(-(uv.x-.5)*optics.sensor.x,(uv.y-.5)*optics.sensor.y,optics.geometry.x);
      let pupilUV=vec2<f32>(sampleDimension(globalPixel,index,2u,render.settings.x),sampleDimension(globalPixel,index,3u,render.settings.x));
      var direction:vec3<f32>;
      var inSamplingDomain=true;
      if(optics.sensor.w>0.5){
        // Contact-plane sampling: pdf_omega=cos(theta)/pi gives weight 4.
        let disk=sampleDisk(pupilUV);
        direction=vec3<f32>(disk,-sqrt(max(0.0,1.0-dot(disk,disk))));
        weight=4.0;
      }else{
        let pupil=sampleExitPupil(sensor.xy,pupilUV);
        inSamplingDomain=pupil.inGlobal;
        let reference=vec3<f32>(pupil.point,optics.geometry.y);
        direction=normalize(reference-sensor);
        let dz=optics.geometry.x-optics.geometry.y;
        let cosTheta=abs(direction.z);
        // Full mixture area PDF in mm^-2. No successful-ray normalization.
        weight=(4./3.141592653589793)*pow(cosTheta,4.)/(dz*dz*pupil.pdf);
      }
      lambda=optics.wavelength.x+(optics.wavelength.y-optics.wavelength.x)*sampleDimension(globalPixel,index,4u,render.settings.x);
      // Physically blocked / TIR / numerical optical paths: zero contribution,
      // counted as attempts, and the scene query is skipped entirely.
      let ray=traceOptics(sensor,direction,lambda,true);
      if(ray.status==1u){a.failures.x++;continue;}
      if(ray.status==2u){a.failures.y++;continue;}
      if(ray.status!=0u){a.failures.z++;continue;}
      // The proposal rectangle can extend outside the original numerical
      // domain. Keep that domain unchanged; never retry this zero attempt.
      if(!inSamplingDomain){a.failures.x++;continue;}
      workCounters[WORK_CAMERA_TRANSFORM]++;
      worldOrigin=(render.cameraToWorld*vec4<f32>(ray.p*.001,1)).xyz;
      worldDirection=normalize((render.cameraToWorld*vec4<f32>(ray.v,0)).xyz);

    }
    a.queries.z++;
    var rgb=render.environment.xyz;
    if(render.settings.z==0u){
      // The single SceneRadianceProvider call site (BVH first hit + shading).
      let scene=sceneRadiance(worldOrigin,worldDirection,key);
      recordScene(&a,scene);
      if(scene.status!=SCENE_HIT&&scene.status!=SCENE_BACKGROUND){continue;}
      rgb=scene.rgb;
      if(geometryMode){rgb=geometryDebug(scene);}
    }
    // The chosen nonnegative emission basis cannot represent materially
    // negative scene RGB. Diagnose it instead of silently changing its colour.
    if(any(rgb<vec3<f32>(-1e-5))||any(abs(rgb)>vec3<f32>(1e30))||any(rgb!=rgb)){a.extra.y++;continue;}
    if(pinhole||geometryMode){a.xyz+=LINEAR_SRGB_TO_XYZ_M*rgb;continue;}
    workCounters[WORK_SPECTRAL]++;
    let contribution=spectralXYZContribution(max(rgb,vec3<f32>(0)),lambda,1./(optics.wavelength.y-optics.wavelength.x),weight);
    if(any(abs(contribution)>vec3<f32>(1e30))||any(contribution!=contribution)){a.extra.y++;continue;}
    a.xyz+=contribution;
  }
  accumulation[pixel]=a;
  textureStore(lensImage,vec2<i32>(i32(imageX),i32(imageY)),resolvePixel(a));
}

// Lens-space ray, before the camera pose. Reflections are applied to BOTH p/v.
struct OpticalSample {
  p:vec3<f32>, status:u32,
  v:vec3<f32>, lambda:f32,
  weight:f32,
};
fn sampleOptical(image:vec2<u32>,index:u32,seed:u32,reflection:vec2<f32>)->OpticalSample {
  workCounters[WORK_OPTICAL_LAUNCH]++;
  let imageX=image.x;let imageY=image.y;
  let globalPixel=imageY*render.size.x+imageX;
  var lambda=0.0;var weight=1.0;
  let jitter=vec2<f32>(sampleDimension(globalPixel,index,0u,seed),sampleDimension(globalPixel,index,1u,seed));
  let uv=(vec2<f32>(f32(imageX),f32(imageY))+jitter)/vec2<f32>(render.size.xy);
  // A real sensor image is inverted. Stored output y=0 is the displayed top.
  let sensor=vec3<f32>(-(uv.x-.5)*optics.sensor.x,(uv.y-.5)*optics.sensor.y,optics.geometry.x);
  let pupilUV=vec2<f32>(sampleDimension(globalPixel,index,2u,seed),sampleDimension(globalPixel,index,3u,seed));
  var direction:vec3<f32>;
  var inSamplingDomain=true;
  if(optics.sensor.w>0.5){
    // Contact-plane sampling: pdf_omega=cos(theta)/pi gives weight 4.
    let disk=sampleDisk(pupilUV);
    direction=vec3<f32>(disk,-sqrt(max(0.0,1.0-dot(disk,disk))));
    weight=4.0;
}else{
  let pupil=sampleExitPupil(sensor.xy,pupilUV);
  inSamplingDomain=pupil.inGlobal;
  let reference=vec3<f32>(pupil.point,optics.geometry.y);
  direction=normalize(reference-sensor);
  let dz=optics.geometry.x-optics.geometry.y;
  let cosTheta=abs(direction.z);
  // Full mixture area PDF in mm^-2. No successful-ray normalization.
  weight=(4./3.141592653589793)*pow(cosTheta,4.)/(dz*dz*pupil.pdf);
}
lambda=optics.wavelength.x+(optics.wavelength.y-optics.wavelength.x)*sampleDimension(globalPixel,index,4u,seed);
let ray=traceOptics(sensor*vec3<f32>(reflection,1),direction*vec3<f32>(reflection,1),lambda,true);
// Reflected proposal densities use the SAME original mixture measure.
// Do not retry a miss or renormalize by successful paths.
let status=select(ray.status,1u,ray.status==0u&&!inSamplingDomain);
return OpticalSample(ray.p,status,ray.v,lambda,weight);
}
fn accumulateOptical(a:ptr<function,PixelAccum>,optical:OpticalSample,sign:vec2<f32>,key:u32){
  if(optical.status==1u){(*a).failures.x++;return;}
  if(optical.status==2u){(*a).failures.y++;return;}
  if(optical.status!=0u){(*a).failures.z++;return;}
  workCounters[WORK_CAMERA_TRANSFORM]++;
  let worldOrigin=(render.cameraToWorld*vec4<f32>(optical.p*vec3<f32>(sign,1)*.001,1)).xyz;
  let worldDirection=normalize((render.cameraToWorld*vec4<f32>(optical.v*vec3<f32>(sign,1),0)).xyz);
  let lambda=optical.lambda;let weight=optical.weight;
  let geometryMode=render.settings.y>=MODE_GEOMETRY_DEPTH;
    (*a).queries.z++;
    var rgb=render.environment.xyz;
    if(render.settings.z==0u){
      // BVH first hit and shading use the same SceneRadianceProvider.
      let scene=sceneRadiance(worldOrigin,worldDirection,key);
      recordScene(a,scene);
      if(scene.status!=SCENE_HIT&&scene.status!=SCENE_BACKGROUND){return;}
      rgb=scene.rgb;
      if(geometryMode){rgb=geometryDebug(scene);}
    }
    // The chosen nonnegative emission basis cannot represent materially
    // negative scene RGB. Diagnose it instead of silently changing its colour.
    if(any(rgb<vec3<f32>(-1e-5))||any(abs(rgb)>vec3<f32>(1e30))||any(rgb!=rgb)){(*a).extra.y++;return;}
    if(geometryMode){(*a).xyz+=LINEAR_SRGB_TO_XYZ_M*rgb;return;}
    workCounters[WORK_SPECTRAL]++;
    let contribution=spectralXYZContribution(max(rgb,vec3<f32>(0)),lambda,1./(optics.wavelength.y-optics.wavelength.x),weight);
    if(any(abs(contribution)>vec3<f32>(1e30))||any(contribution!=contribution)){(*a).extra.y++;return;}
    (*a).xyz+=contribution;
}

// Reflection has unit absolute Jacobian: reflect the pixel jitter, pupil point,
// outgoing ray and its existing importance weight together. Each destination
// still counts ONE attempt, including misses; never divide weight by four.
// Optical noise is shared across the orbit. Scene RNG keys remain per-pixel,
// and sharing is never selected based on visibility, throughput or ray status.
fn integrateMirrors(id:vec3<u32>){
  let halfHeight=bitcast<u32>(render.environment.w);
  let halfWidth=(render.size.x+1u)/2u;
  let groupsX=(halfWidth+7u)/8u;
  let chunkGroup=(id.y/8u)*render.debug.z+id.x/8u;
  let group=render.debug.y+chunkGroup;
  let canonicalLocal=vec2<u32>((group%groupsX)*8u+id.x%8u,(group/groupsX)*8u+id.y%8u);
  if(chunkGroup>=render.debug.w||canonicalLocal.x>=halfWidth||canonicalLocal.y>=halfHeight){return;}
  let canonical=canonicalLocal+vec2<u32>(0,render.settings.w);
  let first=accumulation[canonicalLocal.y*render.size.x+canonical.x].attempts;
  for(var j=0u;j<min(render.size.z,4u);j++){
    let index=first+j;
    if(render.size.w!=0u&&index>=render.size.w){break;}
    // Only one accumulator is live during the large BVH/shading call. Keeping
    // four full records live, or adding workgroup barriers around that call,
    // can spill registers and erase the optical savings on desktop GPUs.
    for(var quadrant=0u;quadrant<4u;quadrant++){
      let mirrorX=(quadrant&1u)!=0u;let mirrorY=(quadrant&2u)!=0u;
      let image=vec2<u32>(select(canonical.x,render.size.x-1u-canonical.x,mirrorX),select(canonical.y,render.size.y-1u-canonical.y,mirrorY));
      if(mirrorX&&image.x==canonical.x){continue;}
      let pixel=(canonicalLocal.y+select(0u,halfHeight,mirrorY))*render.size.x+image.x;
      var a=accumulation[pixel];
      var sign=vec2<f32>(select(1.0,-1.0,mirrorX),select(1.0,-1.0,mirrorY));
      // Matched-sample validation explicitly traces each reflected input ray.
      let optical=sampleOptical(canonical,index,render.settings.x,sign);sign=vec2<f32>(1);
      let globalPixel=image.y*render.size.x+image.x;
      let key=spectralHash32(globalPixel^spectralHash32(a.attempts+render.settings.x*0x632be5abu));
      a.attempts++;workCounters[WORK_PATH]++;
      accumulateOptical(&a,optical,sign,key);
      accumulation[pixel]=a;textureStore(lensImage,vec2<i32>(image),resolvePixel(a));
    }
  }
}
