struct FocusParameters { objectPoint:vec4<f32>, controls:vec4<u32>, cameraToWorld:mat4x4<f32> };
// objectPoint=optical-local mm point; controls=(fixed beamCount, infinity flag,0,0)
struct FocusBeam {a:vec2<f32>,b:vec2<f32>,valid:u32,status:u32,pad:vec2<u32>};
@group(0) @binding(0) var<uniform> optics:OpticsParameters;
@group(0) @binding(1) var<storage,read> opticalSurfaces:array<OpticalSurface>;
@group(0) @binding(2) var<storage,read> glassLut:array<f32>;
@group(0) @binding(3) var<uniform> focus:FocusParameters;
@group(0) @binding(4) var<storage,read_write> beams:array<FocusBeam>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3<u32>){
  if(id.x>=focus.controls.x){return;}
  let surface=opticalSurfaces[0];
  let radius=select(surface.bounds.x,surface.geometry.w,surface.geometry.w>0.);
  // Deterministic finite first-plane aperture rays, never re-issued on failure.
  let disk=sampleDisk(vec2<f32>((f32(id.x)+.5)/f32(focus.controls.x),sampleDimension(0u,id.x,3u,17u)));
  let aim=vec3<f32>(disk*radius,0);
  let direction=select(normalize(aim-focus.objectPoint.xyz),vec3<f32>(0,0,1),focus.controls.y==1u);
  let origin=aim-direction*(max(100.,radius*4.)/max(direction.z,1e-5));
  let ray=traceOptics(origin,direction,optics.wavelength.w,false);
  var beam:FocusBeam;beam.valid=0u;beam.status=ray.status;
  if(ray.status==0u&&ray.v.z>1e-5){
    beam.b=ray.v.xy/ray.v.z;
    // Common z origin at the CURRENT sensor reduces covariance cancellation at
    // a nearly focused plane. Solve delta-z, then restore global optical z.
    beam.a=ray.p.xy-(ray.p.z-optics.geometry.x)*beam.b;beam.valid=1u;
  }
  beams[id.x]=beam;
}
