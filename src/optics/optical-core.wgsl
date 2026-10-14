// lens-sim geometric optics. Coordinates: mm, +z object -> sensor.
// Packed even asphere is sag(conic) + B4*u^4 + ... + B26*u^26,
// u=r/bounds.y, Bp=Ap*bounds.y^p. Raw tiny mm coefficients are never cast to f32.
// Bindings opticalSurfaces, glassLut, optics are supplied by the integration.
struct OpticalSurface {
  geometry: vec4f, // vertex z, signed radius (0 plane), conic k, clear radius (<0 unknown)
  media: vec4u, // before/after LUT record, even coefficient count, is stop
  asphere: array<vec4f, 3>,
  bounds: vec4f, // x: numerical domain (not clear aperture), y: radial normalization mm
}
struct OpticsParameters {
  counts: vec4u, // surface count, LUT sample count, stop index, dispersion enabled
  wavelength: vec4f, // nm min/max/step/reference
  geometry: vec4f, // sensor z, rear reference z, sampling disk radius, stop radius
  sensor: vec4f, // width/height mm, focus distance m, reserved
}
struct RayResult { p: vec3f, v: vec3f, status: u32 }
struct OpticalHit { p: vec3f, n: vec3f, status: u32 }

fn opticalFinite(v: vec3f) -> bool { return all(abs(v) < vec3f(1e30)); }
fn opticalCoefficient(s: OpticalSurface, j: u32) -> f32 {
  return s.asphere[j / 4u][j % 4u];
}
// .x sag; .y 1 if in the primary conic domain, else 0.
fn opticalSag(s: OpticalSurface, xy: vec2f) -> vec2f {
  let r2 = dot(xy, xy);
  var c = 0.0;
  if (s.geometry.y != 0.0) { c = 1.0 / s.geometry.y; }
  let q = 1.0 - (1.0 + s.geometry.z) * c*c*r2;
  if (q < 0.0) { return vec2f(0.0); }
  var z = c*r2 / (1.0 + sqrt(q));
  let u2=r2/(s.bounds.y*s.bounds.y);
  var polynomial=0.0;
  for (var j = min(s.media.z,12u); j>0u; j--) {
    polynomial=polynomial*u2+opticalCoefficient(s,j-1u);
  }
  z+=(polynomial*u2)*u2;
  if (!(abs(z) < 1e30)) { return vec2f(0.0); }
  return vec2f(z,1.0);
}
fn opticalNormal(s: OpticalSurface, xy: vec2f) -> vec4f {
  let r2 = dot(xy,xy);
  var c = 0.0;
  if (s.geometry.y != 0.0) { c = 1.0/s.geometry.y; }
  let q = 1.0 - (1.0+s.geometry.z)*c*c*r2;
  if (q <= 0.0) { return vec4f(0.0); }
  var derivative = c/sqrt(q);
  let scale2=s.bounds.y*s.bounds.y;
  let u2=r2/scale2;
  var polynomial=0.0;
  for (var j=min(s.media.z,12u);j>0u;j--) {
    let index=j-1u;
    polynomial=polynomial*u2+f32(4u+2u*index)*opticalCoefficient(s,index);
  }
  derivative+=polynomial*u2/scale2;
  let n = vec3f(-xy*derivative,1.0);
  if (!opticalFinite(n)) { return vec4f(0.0); }
  return vec4f(normalize(n),1.0);
}
fn opticalResidual(s: OpticalSurface, p: vec3f) -> vec2f {
  let h = opticalSag(s,p.xy);
  return vec2f(p.z-s.geometry.x-h.x,h.y);
}
fn opticalConicRoots(s: OpticalSurface, p: vec3f, v: vec3f) -> vec3f {
  // The quadratic includes the opposite conic branch. Every candidate is
  // independently checked against primary sag below, including R < 0.
  if (s.geometry.y == 0.0) {
    if (abs(v.z)<1e-8) { return vec3f(0.0); }
    return vec3f((s.geometry.x-p.z)/v.z,0.0,1.0);
  }
  let c = 1.0/s.geometry.y;
  let k = 1.0+s.geometry.z;
  let w = p.z-s.geometry.x;
  let a = c*(dot(v.xy,v.xy)+k*v.z*v.z);
  let b = 2.0*c*(dot(p.xy,v.xy)+k*w*v.z)-2.0*v.z;
  let cc = c*(dot(p.xy,p.xy)+k*w*w)-2.0*w;
  if (abs(a)<1e-10) {
    if (abs(b)<1e-10) { return vec3f(0.0); }
    return vec3f(-cc/b,0.0,1.0);
  }
  let discriminant = b*b-4.0*a*cc;
  if (discriminant<0.0) { return vec3f(0.0); }
  let signedRoot = select(-sqrt(discriminant),sqrt(discriminant),b>=0.0);
  let q = -0.5*(b+signedRoot);
  if (abs(q)<1e-15) { return vec3f(-b/(2.0*a),0.0,1.0); }
  let t0 = q/a;
  let t1 = cc/q;
  return vec3f(min(t0,t1),max(t0,t1),2.0);
}
// Returns (t, success). This bounded same-ray fallback is not sample rejection
// or pupil resampling. It resolves a bracket on the primary sag sheet.
fn opticalBracketAsphere(s: OpticalSurface, p: vec3f, v: vec3f, tolerance: f32) -> vec2f {
  if (abs(v.z)<1e-8) { return vec2f(0.0); }
  var radius=max(s.bounds.x,1.0);
  if (s.geometry.w>0.0) { radius=min(radius,s.geometry.w); }
  if (s.geometry.y!=0.0 && s.geometry.z > -1.0) {
    radius=min(radius,abs(s.geometry.y)/sqrt(1.0+s.geometry.z)*(1.0-2e-6));
  }
  var base=s;
  base.media.z=0u;
  let edge=opticalSag(base,vec2f(radius,0.0));
  if (edge.y==0.0) { return vec2f(0.0); }
  var sagLo=min(edge.x,0.0);
  var sagHi=max(edge.x,0.0);
  let u2=radius*radius/(s.bounds.y*s.bounds.y);
  var power=u2*u2;
  for (var j=0u;j<min(s.media.z,12u);j++) {
    let term=opticalCoefficient(s,j)*power;
    sagLo+=min(term,0.0);sagHi+=max(term,0.0);power*=u2;
  }
  let ta=(s.geometry.x+sagLo-p.z)/v.z;
  let tb=(s.geometry.x+sagHi-p.z)/v.z;
  var lo=max(0.0,min(ta,tb)-tolerance);
  var hi=max(ta,tb)+tolerance;
  let a=dot(v.xy,v.xy);
  let b=2.0*dot(p.xy,v.xy);
  let cc=dot(p.xy,p.xy)-radius*radius;
  if (a>1e-12) {
    let disc=b*b-4.0*a*cc;
    if (disc<0.0) { return vec2f(0.0); }
    lo=max(lo,(-b-sqrt(disc))/(2.0*a));
    hi=min(hi,(-b+sqrt(disc))/(2.0*a));
  } else if (cc>0.0) { return vec2f(0.0); }
  if (!(hi>=lo) || !(abs(hi)<1e25)) { return vec2f(0.0); }
  var previousT=lo;
  var previousF=opticalResidual(s,p+lo*v);
  for (var j=0u;j<=64u;j++) {
    let t=mix(lo,hi,f32(j)/64.0);
    let f=opticalResidual(s,p+t*v);
    if (f.y>0.0 && abs(f.x)<=tolerance) { return vec2f(t,1.0); }
    if (f.y>0.0 && previousF.y>0.0 && f.x*previousF.x<0.0) {
      var lower=previousT;var upper=t;var lowerF=previousF.x;
      for (var iteration=0u;iteration<32u;iteration++) {
        let mid=(lower+upper)*0.5;
        let fm=opticalResidual(s,p+mid*v);
        if (fm.y==0.0) { return vec2f(0.0); }
        if (abs(fm.x)<=tolerance) { return vec2f(mid,1.0); }
        if (fm.x*lowerF>0.0) { lower=mid;lowerF=fm.x; }
        else { upper=mid; }
      }
      return vec2f((lower+upper)*0.5,1.0);
    }
    previousT=t;previousF=f;
  }
  return vec2f(0.0);
}
fn opticalIntersect(s: OpticalSurface, p: vec3f, v: vec3f) -> OpticalHit {
  let tolerance = 1e-5 + 8e-7*max(abs(s.geometry.x),length(p));
  let roots = opticalConicRoots(s,p,v);
  var t = -1e30;
  let originResidual=opticalResidual(s,p);
  if (originResidual.y>0.0 && abs(originResidual.x)<=tolerance) { t=0.0; }
  for (var i=0u; i<u32(roots.z); i++) {
    if (t==0.0) { break; }
    let candidate = roots[i];
    if (candidate < -tolerance) { continue; }
    var base = s;
    base.media.z = 0u;
    let residual = opticalResidual(base,p+candidate*v);
    if (residual.y>0.0 && abs(residual.x)<4.0*tolerance) { t=max(candidate,0.0); break; }
  }
  var hasAsphere = false;
  for (var j=0u;j<min(s.media.z,12u);j++) { hasAsphere = hasAsphere || opticalCoefficient(s,j)!=0.0; }
  if (hasAsphere) {
    // Bounded same-ray Newton. A conic root is a scale-consistent initial
    // guess. Every iterate is confined to the documented numerical domain.
    if (t < -1e20) {
      if (abs(v.z)<1e-8) { return OpticalHit(p,v,3u); }
      t=(s.geometry.x-p.z)/v.z;
    }
    var converged=false;
    let domain=max(s.bounds.x,1.0);
    for (var iteration=0u;iteration<32u;iteration++) {
      let q=p+t*v;
      if (t < -tolerance || length(q.xy)>domain || !opticalFinite(q)) { break; }
      let residual=opticalResidual(s,q);
      let normal=opticalNormal(s,q.xy);
      if (residual.y==0.0 || normal.w==0.0) { break; }
      if (abs(residual.x)<=tolerance) { converged=true;break; }
      let derivative=dot(normal.xyz,v)/normal.z;
      if (abs(derivative)<1e-7) { break; }
      t-=clamp(residual.x/derivative,-domain*0.25,domain*0.25);
    }
    if (!converged) {
      // Numerical failure is deliberately distinct from physical occlusion.
      // No different pupil point or wavelength is sampled to hide it.
      let bracket=opticalBracketAsphere(s,p,v,tolerance);
      if (bracket.y==0.0) { return OpticalHit(p,v,3u); }
      t=bracket.x;
    }
  } else if (t < -1e20) { return OpticalHit(p,v,1u); }
  let hit=p+max(t,0.0)*v;
  var radius=s.geometry.w;
  if (s.media.w!=0u) {
    if (radius>0.0) { radius=min(radius,optics.geometry.w); }
    else { radius=optics.geometry.w; }
  }
  if (radius>0.0 && dot(hit.xy,hit.xy)>radius*radius*(1.0+2e-6)) { return OpticalHit(hit,v,1u); }
  let normal=opticalNormal(s,hit.xy);
  if (!opticalFinite(hit) || normal.w==0.0) { return OpticalHit(p,v,3u); }
  return OpticalHit(hit,normal.xyz,0u);
}
fn opticalIndex(record: u32, lambdaNm: f32) -> f32 {
  let u=(lambdaNm-optics.wavelength.x)/optics.wavelength.z;
  let index=min(u32(max(floor(u),0.0)),optics.counts.y-2u);
  let fraction=u-f32(index);
  let offset=record*optics.counts.y+index;
  return mix(glassLut[offset],glassLut[offset+1u],fraction);
}
fn traceOptics(origin: vec3f, direction: vec3f, lambdaNm: f32, reverse: bool) -> RayResult {
  if (!opticalFinite(origin) || !opticalFinite(direction) || dot(direction,direction)<1e-16 || !(abs(lambdaNm)<1e10)) {
    return RayResult(vec3f(0.0),vec3f(0.0,0.0,1.0),3u);
  }
  var p=origin;
  var v=normalize(direction);
  var wavelength=lambdaNm;
  if (optics.counts.w==0u) { wavelength=optics.wavelength.w; }
  if (!opticalFinite(p) || !opticalFinite(v) || wavelength<optics.wavelength.x || wavelength>optics.wavelength.y) { return RayResult(p,v,3u); }
  for (var j=0u;j<optics.counts.x;j++) {
    let index=select(j,optics.counts.x-1u-j,reverse);
    let s=opticalSurfaces[index];
    let hit=opticalIntersect(s,p,v);
    if (hit.status!=0u) { return RayResult(hit.p,v,hit.status); }
    let before=select(s.media.x,s.media.y,reverse);
    let after=select(s.media.y,s.media.x,reverse);
    let eta=opticalIndex(before,wavelength)/opticalIndex(after,wavelength);
    var n=hit.n;
    if (dot(v,n)>0.0) { n=-n; }
    let cosine=-dot(n,v);
    let transmitted=1.0-eta*eta*(1.0-cosine*cosine);
    if (transmitted<0.0) { return RayResult(hit.p,v,2u); }
    v=normalize(eta*v+(eta*cosine-sqrt(transmitted))*n);
    p=hit.p;
    if (!opticalFinite(p) || !opticalFinite(v)) { return RayResult(p,v,3u); }
  }
  return RayResult(p,v,0u);
}
