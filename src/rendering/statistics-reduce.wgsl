// The first pass scans bounded 4096-pixel blocks across many SMs. This pass
// reads only their compact partials, never the full accumulation image.
const STATISTICS_THREADS:u32=256u;
@group(0) @binding(0) var<storage,read> partials:array<vec4<f32>>;
@group(0) @binding(1) var<storage,read_write> totals:array<vec4<f32>>;
var<workgroup> a:array<vec4<f32>,STATISTICS_THREADS>;
var<workgroup> b:array<vec4<f32>,STATISTICS_THREADS>;
var<workgroup> c:array<vec4<f32>,STATISTICS_THREADS>;
@compute @workgroup_size(STATISTICS_THREADS) fn main(@builtin(local_invocation_index) i:u32){
  var x=vec4<f32>(0);var y=vec4<f32>(0);var z=vec4<f32>(0);
  for(var j=i;j<arrayLength(&partials)/3u;j+=STATISTICS_THREADS){x+=partials[j*3u];y+=partials[j*3u+1u];z+=partials[j*3u+2u];}
  a[i]=x;b[i]=y;c[i]=z;workgroupBarrier();
  for(var stride=STATISTICS_THREADS/2u;stride>0u;stride/=2u){if(i<stride){a[i]+=a[i+stride];b[i]+=b[i+stride];c[i]+=c[i+stride];}workgroupBarrier();}
  if(i==0u){totals[0]=a[0];totals[1]=b[0];totals[2]=c[0];}
}
