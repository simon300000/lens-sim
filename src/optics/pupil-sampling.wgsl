struct PupilTable {
  settings: vec4<f32>, // max image height, bin count, global fraction, enabled
  boxes: array<vec4<f32>,256>,
};
@group(0) @binding(20) var<uniform> pupilTable: PupilTable;
struct PupilSample { point:vec2<f32>, pdf:f32, inGlobal:bool };
fn sampleExitPupil(sensor:vec2<f32>,uv:vec2<f32>)->PupilSample {
  let h=length(sensor);
  var axis=vec2<f32>(1,0);if(h>1e-8){axis=sensor/h;}
  let bins=clamp(u32(pupilTable.settings.y),1u,256u);
  let bin=min(bins-1u,u32(h/max(pupilTable.settings.x,1e-8)*f32(bins)));
  let b=pupilTable.boxes[bin];
  let area=(b.y-b.x)*(b.w-b.z);
  let radius=optics.geometry.z;
  let globalArea=3.141592653589793*radius*radius;
  let useLocal=pupilTable.settings.w>0.0 && area<globalArea;
  let alpha=select(1.0,pupilTable.settings.z,useLocal);
  var q:vec2<f32>;
  if(uv.x<alpha){
    let world=sampleDisk(vec2<f32>(uv.x/alpha,uv.y))*radius;
    q=vec2<f32>(dot(world,axis),dot(world,vec2<f32>(-axis.y,axis.x)));
  }else{
    q=vec2<f32>(mix(b.x,b.y,(uv.x-alpha)/(1.0-alpha)),mix(b.z,b.w,uv.y));
  }
  let inGlobal=dot(q,q)<=radius*radius;
  let inLocal=q.x>=b.x && q.x<=b.y && q.y>=b.z && q.y<=b.w;
  let pdf=select(0.0,alpha/globalArea,inGlobal)+select(0.0,(1.0-alpha)/area,inLocal);
  let point=vec2<f32>(axis.x*q.x-axis.y*q.y,axis.y*q.x+axis.x*q.y);
  return PupilSample(point,pdf,inGlobal);
}
