struct PixelAccum {xyz:vec3<f32>,attempts:u32,failures:vec4<u32>,queries:vec4<u32>};
@group(0) @binding(0) var<storage,read> pixels:array<PixelAccum>;
@group(0) @binding(1) var<storage,read_write> totals:array<vec4<f32>>;
var<workgroup> a:array<vec4<f32>,256>;
var<workgroup> b:array<vec4<f32>,256>;
@compute @workgroup_size(256) fn main(@builtin(local_invocation_index) i:u32){
  var x=vec4<f32>(0);var y=vec4<f32>(0);
  for(var j=i;j<arrayLength(&pixels);j+=256u){let p=pixels[j];x+=vec4<f32>(p.failures);y+=vec4<f32>(vec4<u32>(p.attempts,p.queries.xyz));}
  a[i]=x;b[i]=y;workgroupBarrier();
  for(var stride=128u;stride>0u;stride/=2u){if(i<stride){a[i]+=a[i+stride];b[i]+=b[i+stride];}workgroupBarrier();}
  if(i==0u){totals[0]=a[0];totals[1]=b[0];}
}
