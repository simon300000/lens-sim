struct RenderParameters {
  cameraToWorld: mat4x4<f32>,
  size: vec4<u32>, // width, height, batch spp, target attempted spp
  settings: vec4<u32>, // seed, diagnostic mode, test constant environment, unused
  environment: vec4<f32>, // RGB constant radiance for numerical GPU acceptance only
};
struct PixelAccum {
  xyz: vec3<f32>, attempts: u32,
  failures: vec4<u32>, // physical blocked, TIR, numerical, cache miss
  queries: vec4<u32>, // hit, background, optical passed, reserved
};
@group(0) @binding(0) var<uniform> optics: OpticsParameters;
@group(0) @binding(1) var<storage,read> opticalSurfaces: array<OpticalSurface>;
@group(0) @binding(2) var<storage,read> glassLut: array<f32>;
@group(0) @binding(3) var<uniform> sceneUniform: SceneQueryParameters;
@group(0) @binding(4) var captureColor: texture_2d<f32>;
@group(0) @binding(5) var captureDepth: texture_depth_2d;
@group(0) @binding(6) var<uniform> render: RenderParameters;
@group(0) @binding(7) var<storage,read_write> accumulation: array<PixelAccum>;
@group(0) @binding(8) var lensImage: texture_storage_2d<rgba16float,write>;

fn resolvePixel(a: PixelAccum)->vec4<f32>{
  let n=f32(max(a.attempts,1u));
  var rgb=xyzToLinearSRGB(a.xyz/n);
  if(render.settings.y==1u){rgb=vec3<f32>(f32(a.failures.w)/f32(max(a.queries.z,1u)),0.03,0.03);}
  if(render.settings.y==2u){rgb=vec3<f32>(f32(a.failures.z)/n,f32(a.failures.x+a.failures.y)/n,f32(a.queries.x)/n);}
  // Negative RGB after XYZ conversion is out-of-gamut, not negative photon flux.
  return vec4<f32>(clamp(rgb,vec3<f32>(0),vec3<f32>(65000)),1);
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3<u32>){
  if(id.x>=render.size.x||id.y>=render.size.y){return;}
  let pixel=id.y*render.size.x+id.x;
  var a=accumulation[pixel];
  let remaining=render.size.w-min(render.size.w,a.attempts);
  let batch=min(render.size.z,remaining);
  for(var j=0u;j<4u;j++){
    if(j>=batch){break;}
    let index=a.attempts;
    let jitter=vec2<f32>(sampleDimension(pixel,index,0u,render.settings.x),sampleDimension(pixel,index,1u,render.settings.x));
    let uv=(vec2<f32>(id.xy)+jitter)/vec2<f32>(render.size.xy);
    // A real sensor image is inverted. Stored output y=0 is the displayed top.
    let sensor=vec3<f32>(-(uv.x-.5)*optics.sensor.x,(uv.y-.5)*optics.sensor.y,optics.geometry.x);
    let disk=sampleDisk(vec2<f32>(sampleDimension(pixel,index,2u,render.settings.x),sampleDimension(pixel,index,3u,render.settings.x)));
    let reference=vec3<f32>(disk*optics.geometry.z,optics.geometry.y);
    let direction=normalize(reference-sensor);
    let lambda=optics.wavelength.x+(optics.wavelength.y-optics.wavelength.x)*sampleDimension(pixel,index,4u,render.settings.x);
    a.attempts++;
    let ray=traceOptics(sensor,direction,lambda,true);
    if(ray.status==1u){a.failures.x++;continue;}
    if(ray.status==2u){a.failures.y++;continue;}
    if(ray.status!=0u){a.failures.z++;continue;}
    let worldOrigin=(render.cameraToWorld*vec4<f32>(ray.p*.001,1)).xyz;
    let worldDirection=normalize((render.cameraToWorld*vec4<f32>(ray.v,0)).xyz);
    var rgb=render.environment.xyz;
    if(render.settings.z==0u){
      let scene=queryScene(worldOrigin,worldDirection);
      rgb=scene.rgb;
      if(scene.status==4u){a.queries.x++;}
      else if(scene.status==5u){a.queries.y++;}
      else {a.failures.w++;}
    }
    a.queries.z++;
    // The chosen nonnegative emission basis cannot represent materially
    // negative scene RGB. Diagnose it instead of silently changing its colour.
    if(any(rgb<vec3<f32>(-1e-5))||any(abs(rgb)>vec3<f32>(1e30))||any(rgb!=rgb)){a.failures.z++;continue;}
    let dz=optics.geometry.x-optics.geometry.y;
    let cosTheta=abs(direction.z);
    // p_A=1/(pi Rref²) in mm^-2, d in mm. T=1. No successful-ray normalization.
    // Fixed global radiometric calibration 4/pi makes ideal f/1 axial L=1 ->1.
    let weight=4.*optics.geometry.z*optics.geometry.z*pow(cosTheta,4.)/(dz*dz);
    let contribution=spectralXYZContribution(max(rgb,vec3<f32>(0)),lambda,1./(optics.wavelength.y-optics.wavelength.x),weight);
    if(any(abs(contribution)>vec3<f32>(1e30))||any(contribution!=contribution)){a.failures.z++;continue;}
    a.xyz+=contribution;
  }
  accumulation[pixel]=a;
  textureStore(lensImage,vec2<i32>(id.xy),resolvePixel(a));
}
