struct CameraParameters {cameraToWorld:mat4x4<f32>};
@group(0) @binding(0) var<uniform> optics:OpticsParameters;
@group(0) @binding(1) var<storage,read> opticalSurfaces:array<OpticalSurface>;
@group(0) @binding(2) var<storage,read> glassLut:array<f32>;
@group(0) @binding(3) var<uniform> sceneUniform:SceneQueryParameters;
@group(0) @binding(4) var captureColor:texture_2d<f32>;
@group(0) @binding(5) var captureDepth:texture_depth_2d;
@group(0) @binding(6) var<uniform> camera:CameraParameters;
@group(0) @binding(7) var<storage,read_write> focusTarget:array<vec4<f32>>;
@compute @workgroup_size(1) fn main(){
  let ray=traceOptics(vec3<f32>(0,0,optics.geometry.x),vec3<f32>(0,0,-1),optics.wavelength.w,true);
  if(ray.status!=0u){focusTarget[0]=vec4<f32>(0,0,0,f32(ray.status));return;}
  let origin=(camera.cameraToWorld*vec4<f32>(ray.p*.001,1)).xyz;
  let direction=normalize((camera.cameraToWorld*vec4<f32>(ray.v,0)).xyz);
  let hit=queryScene(origin,direction);
  focusTarget[0]=vec4<f32>(hit.position,f32(hit.status));
}
