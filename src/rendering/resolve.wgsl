// Display-only resolve: no lens tracing and no sample counter changes.
struct PixelAccum { xyz:vec3<f32>, attempts:u32, failures:vec4<u32>, queries:vec4<u32>, extra:vec4<u32> };
struct ResolveParameters {size:vec4<u32>};
@group(0) @binding(0) var<uniform> settings:ResolveParameters;
@group(0) @binding(1) var<storage,read> accumulation:array<PixelAccum>;
@group(0) @binding(2) var image:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3<u32>){
  let halfHeight=settings.size.z>>8u;
  if(halfHeight>0u&&id.y>=halfHeight*2u){return;}
  let mode=settings.size.z&255u;
  let imageY=select(id.y+settings.size.w,settings.size.y-1u-settings.size.w-(id.y-halfHeight),halfHeight>0u&&id.y>=halfHeight);
  if(id.x>=settings.size.x||imageY>=settings.size.y){return;}
  let a=accumulation[id.y*settings.size.x+id.x];let n=f32(max(a.attempts,1u));
  if(a.attempts==0u){textureStore(image,vec2<i32>(i32(id.x),i32(imageY)),vec4<f32>(0,0,0,1));return;}
  var rgb=xyzToLinearSRGB(a.xyz/n);
  let passed=f32(max(a.queries.z,1u));
  // scene-error: R = BVH error + transparency limit, G = unsupported material, B = reflection outside reference view
  if(mode==1u){rgb=vec3<f32>(f32(a.failures.w+a.extra.x)/passed,f32(a.queries.w)/passed,f32(a.extra.z)/passed);}
  if(mode==2u){rgb=vec3<f32>(f32(a.failures.z+a.extra.y)/n,f32(a.failures.x+a.failures.y)/n,f32(a.queries.x)/n);}
  textureStore(image,vec2<i32>(i32(id.x),i32(imageY)),vec4<f32>(clamp(rgb,vec3<f32>(0),vec3<f32>(65000)),1));
}
