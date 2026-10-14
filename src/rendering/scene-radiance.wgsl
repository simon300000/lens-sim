// Independent bounded single-layer radiance provider. World distances are metres.
// McGuire/Mara, Efficient GPU Screen-Space Ray Tracing, JCGT 3(4), 2014.
// Requires globals captureColor, captureDepth, sceneUniform; no bindings declared here.
struct SceneQueryParameters {
  worldToClip: mat4x4<f32>,
  clipToWorld: mat4x4<f32>,
  worldToView: mat4x4<f32>,
  viewport: vec4<f32>, // width, height, near metres, far metres
  trace: vec4<f32>, // max distance metres, depth slab metres, pixels/step, steps <=128
  skyZenith: vec4<f32>,
  skyHorizon: vec4<f32>,
  skyGround: vec4<f32>,
};
struct SceneQueryResult { rgb: vec3<f32>, position: vec3<f32>, status: u32 };
struct SQProbe {
  point: vec3<f32>, surface: vec3<f32>, rgb: vec3<f32>, gap: f32,
  sceneDepth: f32, kind: u32, // 0 invalid, 1 foreground, 2 background
};
fn sceneEnvironment(direction: vec3<f32>) -> vec3<f32> {
  if (direction.y >= 0.0) {
    return mix(sceneUniform.skyHorizon.rgb, sceneUniform.skyZenith.rgb, sqrt(min(1.0, direction.y)));
  }
  return mix(sceneUniform.skyHorizon.rgb, sceneUniform.skyGround.rgb, sqrt(min(1.0, -direction.y)));
}
fn sqPlane(c:vec4<f32>, i:u32) -> f32 {
  switch i {
    case 0u: { return c.x+c.w; }
    case 1u: { return c.w-c.x; }
    case 2u: { return c.y+c.w; }
    case 3u: { return c.w-c.y; }
    case 4u: { return c.z; }
    case 5u: { return c.w-c.z; }
    default: { return c.w-0.000001; }
  }
}
fn sqProbe(point:vec3<f32>) -> SQProbe {
  var probe:SQProbe;
  probe.point=point;
  let clip=sceneUniform.worldToClip*vec4<f32>(point,1.0);
  if (clip.w<=0.0) { return probe; }
  let uv=vec2<f32>(clip.x/clip.w*0.5+0.5,0.5-clip.y/clip.w*0.5);
  if (any(uv<vec2<f32>(0.0)) || any(uv>=vec2<f32>(1.0))) { return probe; }
  let pixel=vec2<i32>(floor(uv*sceneUniform.viewport.xy));
  let depth=textureLoad(captureDepth,pixel,0);
  if (depth!=depth || depth<0.0 || depth>1.0) { return probe; }
  if (depth>=0.9999999) {
    probe.rgb=textureLoad(captureColor,pixel,0).rgb;
    if (any(probe.rgb!=probe.rgb) || any(abs(probe.rgb)>vec3<f32>(1e30))) { return probe; }
    probe.kind=2u; probe.gap=-1e30; probe.sceneDepth=1e30; return probe;
  }
  // Sample colour from precisely the same texel as depth, avoiding cross-edge bleed.
  let centre=(vec2<f32>(pixel)+vec2<f32>(0.5))/sceneUniform.viewport.xy;
  let h=sceneUniform.clipToWorld*vec4<f32>(centre.x*2.0-1.0,1.0-centre.y*2.0,depth,1.0);
  if (abs(h.w)<1e-12) { return probe; }
  probe.surface=h.xyz/h.w;
  probe.sceneDepth=-(sceneUniform.worldToView*vec4<f32>(probe.surface,1.0)).z;
  probe.gap=-(sceneUniform.worldToView*vec4<f32>(point,1.0)).z-probe.sceneDepth;
  probe.rgb=textureLoad(captureColor,pixel,0).rgb;
  if (any(probe.rgb!=probe.rgb) || any(abs(probe.rgb)>vec3<f32>(1e30))) { return probe; }
  probe.kind=1u;
  return probe;
}
fn queryScene(originWorld:vec3<f32>, directionWorld:vec3<f32>) -> SceneQueryResult {
  let magnitude=length(directionWorld);
  if (magnitude!=magnitude || magnitude<1e-10 || magnitude>1e30 || any(originWorld!=originWorld) || any(abs(originWorld)>vec3<f32>(1e30))) {
    return SceneQueryResult(sceneUniform.skyHorizon.rgb,vec3<f32>(0.0),6u);
  }
  let direction=directionWorld/magnitude;
  let environment=sceneEnvironment(direction);
  let miss=SceneQueryResult(environment,originWorld,6u);
  let endpoint=originWorld+direction*sceneUniform.trace.x;
  let c0=sceneUniform.worldToClip*vec4<f32>(originWorld,1.0);
  let c1=sceneUniform.worldToClip*vec4<f32>(endpoint,1.0);
  var lo=0.0; var hi=1.0; var clippedSide=false;
  for (var p=0u;p<7u;p++) {
    let f0=sqPlane(c0,p); let f1=sqPlane(c1,p);
    if (f0<0.0 && f1<0.0) { return miss; }
    if (f0<0.0 || f1<0.0) {
      let t=f0/(f0-f1);
      if (f0<0.0) { lo=max(lo,t); }
      else if (t<hi) { hi=t; clippedSide=p<4u; }
    }
  }
  if (hi<=lo) { return miss; }
  // Open texture-boundary entry: advance only along the SAME ray, by a finite
  // f32-scale numerical inset. Evaluating exactly the homogeneous side-plane
  // boundary can round to UV=1 and fabricate a cache miss. This is neither UV
  // clamping nor a changed optical sample; true side exits remain cache misses.
  let entry=mix(originWorld,endpoint,lo);
  let insetM=0.000003814697265625*max(1.0,max(length(originWorld),length(entry)));
  let insetT=min((hi-lo)*0.0001,insetM/sceneUniform.trace.x);
  if (lo>0.0) { lo+=insetT; }
  if (hi<1.0) { hi-=insetT; }
  let a=mix(originWorld,endpoint,lo); let b=mix(originWorld,endpoint,hi);
  let ca=sceneUniform.worldToClip*vec4<f32>(a,1.0);
  let cb=sceneUniform.worldToClip*vec4<f32>(b,1.0);
  let ka=1.0/ca.w; let kb=1.0/cb.w;
  let qa=a*ka; let qb=b*kb;
  let pa=vec2<f32>(ca.x/ca.w*0.5+0.5,0.5-ca.y/ca.w*0.5);
  let pb=vec2<f32>(cb.x/cb.w*0.5+0.5,0.5-cb.y/cb.w*0.5);
  let delta=abs((pb-pa)*sceneUniform.viewport.xy);
  let pixelLength=max(delta.x,delta.y);
  let steps=u32(clamp(ceil(pixelLength/max(0.5,sceneUniform.trace.z)),1.0,min(128.0,max(1.0,sceneUniform.trace.w))));
  let thickness=max(0.0001,sceneUniform.trace.y);
  var previous=sqProbe(a);
  var seenGeometry=previous.kind==1u;
  if (previous.kind==0u || previous.gap>thickness) { return miss; }
  for (var i=1u;i<=128u;i++) {
    if (i>steps) { break; }
    let s=f32(i)/f32(steps);
    let point=mix(qa,qb,s)/mix(ka,kb,s);
    let current=sqProbe(point);
    if (current.kind==0u) { return miss; }
    seenGeometry=seenGeometry || current.kind==1u;
    if (current.kind==1u && current.gap>=0.0 && previous.gap<=0.0) {
      let discontinuity=max(0.15,0.05*current.sceneDepth);
      if (previous.kind==2u || abs(previous.sceneDepth-current.sceneDepth)>discontinuity) { return miss; }
      var low=previous; var high=current; var best=current;
      for (var j=0u;j<8u;j++) {
        // Secant in world distance is exact for a fronto-parallel depth layer.
        // Bounded interpolation keeps the same ray and never resamples its origin.
        let f=clamp(-low.gap/max(1e-12,high.gap-low.gap),0.001,0.999);
        let trial=sqProbe(mix(low.point,high.point,f));
        if (trial.kind!=1u || abs(trial.sceneDepth-current.sceneDepth)>discontinuity) { return miss; }
        best=trial;
        if (abs(trial.gap)<=thickness) { break; }
        if (trial.gap<0.0) { low=trial; } else { high=trial; }
      }
      if (abs(best.gap)>thickness) { return miss; }
      // Return the same physical query ray's slab intersection. The texel-centre
      // surface estimates layer depth, but is not a target point on this ray.
      return SceneQueryResult(best.rgb,best.point,4u);
    }
    if (current.kind==1u && current.gap>thickness) { return miss; }
    previous=current;
  }
  if (!seenGeometry && !clippedSide && previous.kind==2u) { return SceneQueryResult(previous.rgb,b,5u); }
  return miss;
}
