struct PixelAccum {xyz:vec3<f32>,attempts:u32,failures:vec4<u32>,queries:vec4<u32>,extra:vec4<u32>};
@group(0) @binding(0) var<storage,read> pixels:array<PixelAccum>;
@group(0) @binding(1) var<storage,read_write> totals:array<vec4<f32>>;
var<workgroup> a:array<vec4<f32>,256>;
var<workgroup> b:array<vec4<f32>,256>;
var<workgroup> c:array<vec4<f32>,256>;
// Per-invocation partial sums stay integer; only the cross-invocation tree is f32.
@compute @workgroup_size(256) fn main(@builtin(local_invocation_index) i:u32){
  var x=vec4<u32>(0);var y=vec4<u32>(0);var z=vec4<u32>(0);
  for(var j=i;j<arrayLength(&pixels);j+=256u){let p=pixels[j];x+=p.failures;y+=vec4<u32>(p.attempts,p.queries.xyz);z+=vec4<u32>(p.queries.w,p.extra.xyz);}
  a[i]=vec4<f32>(x);b[i]=vec4<f32>(y);c[i]=vec4<f32>(z);workgroupBarrier();
  for(var stride=128u;stride>0u;stride/=2u){if(i<stride){a[i]+=a[i+stride];b[i]+=b[i+stride];c[i]+=c[i+stride];}workgroupBarrier();}
  if(i==0u){totals[0]=a[0];totals[1]=b[0];totals[2]=c[0];}
}
