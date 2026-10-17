const STATISTICS_THREADS:u32=256u;
const STATISTICS_PIXELS:u32=4096u;
struct PixelAccum {xyz:vec3<f32>,attempts:u32,failures:vec4<u32>,queries:vec4<u32>,extra:vec4<u32>};
@group(0) @binding(0) var<storage,read> pixels:array<PixelAccum>;
@group(0) @binding(1) var<storage,read_write> totals:array<vec4<f32>>;
var<workgroup> a:array<vec4<f32>,STATISTICS_THREADS>;
var<workgroup> b:array<vec4<f32>,STATISTICS_THREADS>;
var<workgroup> c:array<vec4<f32>,STATISTICS_THREADS>;
// Per-invocation partial sums stay integer; only the cross-invocation tree is f32.
@compute @workgroup_size(STATISTICS_THREADS) fn main(@builtin(local_invocation_index) i:u32,@builtin(workgroup_id) group:vec3<u32>,@builtin(num_workgroups) grid:vec3<u32>){
  let block=group.y*grid.x+group.x;
  if(block*STATISTICS_PIXELS>=arrayLength(&pixels)){return;}
  var x=vec4<u32>(0);var y=vec4<u32>(0);var z=vec4<u32>(0);
  let end=min((block+1u)*STATISTICS_PIXELS,arrayLength(&pixels));
  for(var j=block*STATISTICS_PIXELS+i;j<end;j+=STATISTICS_THREADS){let p=pixels[j];x+=p.failures;y+=vec4<u32>(p.attempts,p.queries.xyz);z+=vec4<u32>(p.queries.w,p.extra.xyz);}
  a[i]=vec4<f32>(x);b[i]=vec4<f32>(y);c[i]=vec4<f32>(z);workgroupBarrier();
  for(var stride=STATISTICS_THREADS/2u;stride>0u;stride/=2u){if(i<stride){a[i]+=a[i+stride];b[i]+=b[i+stride];c[i]+=c[i+stride];}workgroupBarrier();}
  if(i==0u){totals[block*3u]=a[0];totals[block*3u+1u]=b[0];totals[block*3u+2u]=c[0];}
}
