struct FocusBeam {a:vec2<f32>,b:vec2<f32>,valid:u32,status:u32,pad:vec2<u32>};
struct Summary {s0:vec4<f32>,s1:vec4<f32>,s2:vec4<f32>};
@group(0) @binding(0) var<storage,read> beams:array<FocusBeam>;
@group(0) @binding(1) var<storage,read_write> summary:array<Summary>;
var<workgroup> partial:array<Summary,256>;
@compute @workgroup_size(256) fn main(@builtin(local_invocation_index) i:u32){
  var s:Summary;
  for(var j=i;j<arrayLength(&beams);j+=256u){
    let b=beams[j];
    if(b.valid==1u){
      s.s0+=vec4<f32>(b.a,b.b);
      s.s1+=vec4<f32>(dot(b.a,b.a),dot(b.a,b.b),dot(b.b,b.b),1.);
    }else if(b.status==3u){s.s2.x+=1.;}
  }
  partial[i]=s;workgroupBarrier();
  for(var stride=128u;stride>0u;stride/=2u){
    if(i<stride){partial[i].s0+=partial[i+stride].s0;partial[i].s1+=partial[i+stride].s1;partial[i].s2+=partial[i+stride].s2;}
    workgroupBarrier();
  }
  if(i==0u){summary[0]=partial[0];}
}
