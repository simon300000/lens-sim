// AF target acquisition: the current lens's reference chief ray, traced in
// reverse through the real prescription, then intersected with the REAL
// scene BVH. Rule: the first OPAQUE surface; alpha-blended layers (water,
// glass, fins) are passed through along the same ray and counted.
// Output: xyz world point, w status (4 hit, 5 background, 1-3 optical
// failure, 8 BVH error, 9 transparent-layer limit); second vec4: t, layers.
struct CameraParameters {cameraToWorld:mat4x4<f32>};
@group(0) @binding(0) var<uniform> optics:OpticsParameters;
@group(0) @binding(1) var<storage,read> opticalSurfaces:array<OpticalSurface>;
@group(0) @binding(2) var<storage,read> glassLut:array<f32>;
@group(0) @binding(3) var<uniform> camera:CameraParameters;
@group(0) @binding(4) var<storage,read_write> focusTarget:array<vec4<f32>>;
@group(0) @binding(6) var<storage,read> sceneNodes:array<BvhNode>;
@group(0) @binding(7) var<storage,read> sceneInstances:array<SceneInstance>;
@group(0) @binding(8) var<storage,read> sceneTriangles:array<SceneTriangle>;
@compute @workgroup_size(1) fn main(){
  let ray=traceOptics(vec3<f32>(0,0,optics.geometry.x),vec3<f32>(0,0,-1),optics.wavelength.w,true);
  if(ray.status!=0u){focusTarget[0]=vec4<f32>(0,0,0,f32(ray.status));focusTarget[1]=vec4<f32>(0);return;}
  let origin=(camera.cameraToWorld*vec4<f32>(ray.p*.001,1)).xyz;
  let direction=normalize((camera.cameraToWorld*vec4<f32>(ray.v,0)).xyz);
  var tMin=0.0;
  for(var layer=0u;layer<sceneRuntimeBound(7u);layer++){
    let hit=sceneIntersect(origin,direction,tMin,1.0e7);
    if(hit.status==HIT_ERROR){focusTarget[0]=vec4<f32>(0,0,0,8.0);focusTarget[1]=vec4<f32>(0,f32(layer),f32(hit.error),0);return;}
    if(hit.status==HIT_NONE){focusTarget[0]=vec4<f32>(origin,5.0);focusTarget[1]=vec4<f32>(-1.0,f32(layer),0,0);return;}
    if((sceneInstances[hit.instance].info.z&INSTANCE_TRANSPARENT)==0u){
      focusTarget[0]=vec4<f32>(origin+direction*hit.t,4.0);focusTarget[1]=vec4<f32>(hit.t,f32(layer),0,0);return;
    }
    tMin=hit.t+1.0e-4+2.0e-6*hit.t;
  }
  focusTarget[0]=vec4<f32>(0,0,0,9.0);focusTarget[1]=vec4<f32>(0,7.0,0,0);
}
