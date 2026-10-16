// Fused lens integrator: pixel/pupil/wavelength sample -> reverse real-lens
// trace -> BVH nearest real surface -> material + raster-resource lighting ->
// RGB->spectral XYZ -> f32 progressive accumulation. One invocation per pixel.
struct RenderParameters {
  cameraToWorld: mat4x4<f32>,
  size: vec4<u32>,      // width, height, batch spp, target attempted spp
  settings: vec4<u32>,  // seed, diagnostic mode, test constant environment, tile y offset
  environment: vec4<f32>, // RGB constant radiance for numerical GPU acceptance only
  debug: vec4<u32>,     // x: 0 lens, 1 diagnostic pinhole (tests only, bypasses optics and spectra)
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
// Per-lane staging (14 x 64 u32): plain stores, no shared-memory atomics.
var<workgroup> workgroupWork: array<array<u32, 64>, 14>;
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
fn main(@builtin(global_invocation_id) id:vec3<u32>,@builtin(local_invocation_index) lane:u32){
  integratePixel(id);
  // WORK-COUNTING-BEGIN
  // Every invocation reaches the barrier: integratePixel returns, never exits main.
  // Constant indices only: a dynamic index would move workCounters out of registers
  // and slow every tally in the traversal loops.
  workgroupWork[0][lane]=workCounters[0];
  workgroupWork[1][lane]=workCounters[1];
  workgroupWork[2][lane]=workCounters[2];
  workgroupWork[3][lane]=workCounters[3];
  workgroupWork[4][lane]=workCounters[4];
  workgroupWork[5][lane]=workCounters[5];
  workgroupWork[6][lane]=workCounters[6];
  workgroupWork[7][lane]=workCounters[7];
  workgroupWork[8][lane]=workCounters[8];
  workgroupWork[9][lane]=workCounters[9];
  workgroupWork[10][lane]=workCounters[10];
  workgroupWork[11][lane]=workCounters[11];
  workgroupWork[12][lane]=workCounters[12];
  workgroupWork[13][lane]=workCounters[13];
  workgroupBarrier();
  // One lane per counter sums the 64 lanes, then a single global 64-bit add.
  if(lane<WORK_COUNTERS){
    var v=0u;
    for(var i=0u;i<64u;i++){v+=workgroupWork[lane][i];}
    if(v!=0u){let old=atomicAdd(&workTotals[lane*2u],v);if(old>0xffffffffu-v){atomicAdd(&workTotals[lane*2u+1u],1u);}}
  }
  // WORK-COUNTING-END
}
fn integratePixel(id:vec3<u32>){
  let imageY=id.y+render.settings.w;
  if(id.x>=render.size.x||imageY>=render.size.y){return;}
  let pixel=id.y*render.size.x+id.x;
  var a=accumulation[pixel];
  let remaining=select(render.size.w-min(render.size.w,a.attempts),0xffffffffu-a.attempts,render.size.w==0u);
  let batch=min(render.size.z,remaining);
  let geometryMode=render.settings.y>=MODE_GEOMETRY_DEPTH;
  // batch <= 4 is a runtime value, so this loop is not unrolled.
  for(var j=0u;j<min(batch,4u);j++){
    let index=a.attempts;
    workCounters[WORK_PATH]++;
    let globalPixel=imageY*render.size.x+id.x;
    let key=spectralHash32(globalPixel^spectralHash32(index+render.settings.x*0x632be5abu));
    a.attempts++;
    var worldOrigin:vec3<f32>;var worldDirection:vec3<f32>;
    var lambda=0.0;var weight=1.0;
    let pinhole=render.debug.x==1u;
    if(pinhole){
      // Diagnostic pinhole: pixel-centre ray of the reference camera. Used
      // only by the raster/compute shading comparison test.
      let ndc=vec2<f32>((f32(id.x)+0.5)/f32(render.size.x)*2.0-1.0,1.0-(f32(imageY)+0.5)/f32(render.size.y)*2.0);
      let viewH=render.pinholeClipToCamera*vec4<f32>(ndc,0.5,1.0);
      worldOrigin=(render.cameraToWorld*vec4<f32>(0,0,0,1)).xyz;
      worldDirection=normalize((render.cameraToWorld*vec4<f32>(viewH.xyz/viewH.w,0)).xyz);
    }else{
      let jitter=vec2<f32>(sampleDimension(globalPixel,index,0u,render.settings.x),sampleDimension(globalPixel,index,1u,render.settings.x));
      let uv=(vec2<f32>(f32(id.x),f32(imageY))+jitter)/vec2<f32>(render.size.xy);
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
  textureStore(lensImage,vec2<i32>(i32(id.x),i32(imageY)),resolvePixel(a));
}
