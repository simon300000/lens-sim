// Entry point only. The production, binding-free spectral and Sobol math modules
// are prepended by spectral-optical-probe.js. This is native WebGPU, not a mock.
@group(0) @binding(0) var<storage,read> probeInputs: array<vec4u>;
@group(0) @binding(1) var<storage,read_write> probeOutputs: array<vec4f>;

/*PROBE_COLORS*/

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let fixtureCount=probeInputs[0].x;
  let wavelengthStrata=probeInputs[0].y;
  let colorCount=probeInputs[0].z;
  if(id.x<fixtureCount){
    let fixture=probeInputs[id.x+1u];
    let value=sampleDimension(fixture.x,fixture.y,fixture.z,fixture.w);
    probeOutputs[id.x]=vec4f(value,0.0,0.0,1.0);
    return;
  }
  let colorIndex=id.x-fixtureCount;
  if(colorIndex>=colorCount){return;}
  let rgb=PROBE_COLORS[colorIndex];
  var sumXYZ=vec3f(0.0);
  for(var i=0u;i<wavelengthStrata;i=i+1u){
    // Continuous-domain one-dimensional stratified quadrature: one wavelength
    // per iteration. No RGB ray triplet, wavelength bin/color hack or clipping.
    let wavelengthNm=380.0+(f32(i)+0.5)*(400.0/f32(wavelengthStrata));
    sumXYZ=sumXYZ+spectralXYZContribution(rgb,wavelengthNm,1.0/400.0,1.0);
  }
  let meanXYZ=sumXYZ/f32(wavelengthStrata);
  let meanRGB=xyzToLinearSRGB(meanXYZ);
  let finite=select(0.0,1.0,all(abs(meanXYZ)<vec3f(3.0e38)) && all(abs(meanRGB)<vec3f(3.0e38)));
  probeOutputs[fixtureCount+2u*colorIndex]=vec4f(meanXYZ,finite);
  probeOutputs[fixtureCount+2u*colorIndex+1u]=vec4f(meanRGB,finite);
}
