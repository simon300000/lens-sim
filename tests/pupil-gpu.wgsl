// Diagnostic kernel sharing the production tracer, proposal map and spectra.
// Independent invocations integrate disjoint sample prefixes at a fixed sensor.
@group(0) @binding(0) var<uniform> optics:OpticsParameters;
@group(0) @binding(1) var<storage,read> opticalSurfaces:array<OpticalSurface>;
@group(0) @binding(2) var<storage,read> glassLut:array<f32>;
struct Probe { sensor:vec4f, settings:vec4u }; // xy, fixed nm (0=spectral), count/seed/offset
@group(0) @binding(3) var<uniform> probe:Probe;
@group(0) @binding(4) var<storage,read_write> output:array<vec4f>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id:vec3u){
  var xyz=vec3f(0);var energy=0.0;var passed=0u;var numerical=0u;var sum2=0.0;var maximum=0.0;var omitted=0.0;
  for(var j=0u;j<probe.settings.x;j++){
    let index=probe.settings.z+id.x*probe.settings.x+j;
    let uv=vec2f(sampleDimension(0u,index,2u,probe.settings.y),sampleDimension(0u,index,3u,probe.settings.y));
    let sample=sampleExitPupil(probe.sensor.xy,uv);
    let origin=vec3f(probe.sensor.xy,optics.geometry.x);
    let direction=normalize(vec3f(sample.point,optics.geometry.y)-origin);
    var nm=probe.sensor.z;
    if(nm==0.0){nm=380.0+400.0*sampleDimension(0u,index,4u,probe.settings.y);}
    let ray=traceOptics(origin,direction,nm,true);
    if(ray.status==3u){numerical++;}if(ray.status!=0u||!sample.inGlobal){continue;}passed++;
    let d=optics.geometry.x-optics.geometry.y;
    let w=(4.0/3.141592653589793)*pow(abs(direction.z),4.0)/(d*d*sample.pdf);
    energy+=w;sum2+=w*w;maximum=max(maximum,w);
    let b=pupilBounds(probe.sensor.xy);
    // Test cases are on +x; the omission diagnostic uses that radial frame.
    if(sample.point.x<b.x||sample.point.x>b.y||sample.point.y<b.z||sample.point.y>b.w){omitted+=w;}
    if(probe.sensor.z==0.0){xyz+=spectralXYZContribution(vec3f(1),nm,1.0/400.0,w);}
  }
  output[id.x*3u]=vec4f(xyz,energy);
  output[id.x*3u+1u]=vec4f(f32(passed),sum2,maximum,f32(numerical));
  output[id.x*3u+2u]=vec4f(omitted,0,0,0);
}
