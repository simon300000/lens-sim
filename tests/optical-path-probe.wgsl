// Production optical-core.wgsl is prepended. All buffers share the initialized
// renderer's GPUDevice; this probe is intentionally a diagnostic readback.
struct OpticalProbeRay {
  origin: vec4f, // xyz mm; w wavelength nm
  direction: vec4f,
  flags: vec4u, // x reverse traversal
}
@group(0) @binding(0) var<storage,read> opticalSurfaces: array<OpticalSurface>;
@group(0) @binding(1) var<storage,read> glassLut: array<f32>;
@group(0) @binding(2) var<uniform> optics: OpticsParameters;
@group(0) @binding(3) var<storage,read> opticalProbeRays: array<OpticalProbeRay>;
@group(0) @binding(4) var<storage,read_write> opticalProbeOutputs: array<vec4f>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x>=arrayLength(&opticalProbeRays)) { return; }
  let ray=opticalProbeRays[id.x];
  let reverse=ray.flags.x!=0u;
  let result=traceOptics(ray.origin.xyz,ray.direction.xyz,ray.origin.w,reverse);
  var reciprocal=RayResult(vec3f(0.0),vec3f(0.0),result.status);
  if (result.status==0u) {
    reciprocal=traceOptics(result.p,-result.v,ray.origin.w,!reverse);
  }
  let finite=opticalFinite(result.p)&&opticalFinite(result.v)&&opticalFinite(reciprocal.p)&&opticalFinite(reciprocal.v);
  opticalProbeOutputs[4u*id.x]=vec4f(result.p,f32(result.status));
  opticalProbeOutputs[4u*id.x+1u]=vec4f(result.v,select(0.0,1.0,finite));
  opticalProbeOutputs[4u*id.x+2u]=vec4f(reciprocal.p,f32(reciprocal.status));
  opticalProbeOutputs[4u*id.x+3u]=vec4f(reciprocal.v,0.0);
}
