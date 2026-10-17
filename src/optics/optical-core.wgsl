// lens-sim geometric optics. Coordinates: mm, +z object -> sensor.
// Packed sag uses u=r/bounds.y: even monomials B4*u^4...B26*u^26,
// or XODD Bernstein controls b1..bN with b0=0. Original normalized source terms
// are retained in the prescription and converted in f64 before f32 packing.
// Bindings opticalSurfaces, glassLut, optics are supplied by the integration.
struct OpticalSurface {
  geometry: vec4f, // vertex z, signed radius (0 plane), conic k, clear radius (<0 unknown)
  media: vec4u, // before/after LUT record, radial coefficient count, is stop
  asphere: array<vec4f, 7>,
  bounds: vec4f, // x: numerical domain (not clear aperture), y: radial normalization mm, z: encoding (1 radial monomial, 2 even, 3 Bernstein XODD), w: first power (1/4)
  diffraction: vec4f, // phase count, normalized radius mm, source order/radius (metadata)
  phase: array<vec4f, 3>, // order already applied, radians at normalized radius
}
struct OpticsParameters {
  counts: vec4u, // surface count, LUT sample count, stop index, dispersion enabled
  wavelength: vec4f, // nm min/max/step/reference
  geometry: vec4f, // sensor z, rear reference z, sampling disk radius, stop radius
  sensor: vec4f, // width/height mm, focus distance m, launch mode (0 disk / 1 cosine hemisphere)
}
struct RayResult { p: vec3f, v: vec3f, status: u32 }
struct OpticalHit { p: vec3f, n: vec3f, status: u32 }

fn opticalFinite(v: vec3f) -> bool { return all(abs(v) < vec3f(1e30)); }
fn opticalCoefficient(s: OpticalSurface, j: u32) -> f32 {
  return s.asphere[j / 4u][j % 4u];
}
// Bernstein XODD b0=0, b1..bN are packed. The penultimate de Casteljau
// control points give the analytic derivative, including all integer powers.
fn opticalBernstein(s: OpticalSurface, u: f32) -> vec2f {
  let degree=min(s.media.z,28u);if(degree==0u){return vec2f(0.0);}
  var control:array<f32,29>;control[0]=0.0;
  for(var j=0u;j<degree;j++){control[j+1u]=opticalCoefficient(s,j);}
  for(var level=degree;level>1u;level--){
    for(var j=0u;j<level;j++){control[j]=mix(control[j],control[j+1u],u);}
  }
  return vec2f(mix(control[0],control[1],u),f32(degree)*(control[1]-control[0]));
}
// .x sag; .y 1 if in the primary conic domain, else 0.
fn opticalSag(s: OpticalSurface, xy: vec2f) -> vec2f {
  workCounters[WORK_SAG]++;
  let r2 = dot(xy, xy);
  var c = 0.0;
  if (s.geometry.y != 0.0) { c = 1.0 / s.geometry.y; }
  let q = 1.0 - (1.0 + s.geometry.z) * c*c*r2;
  if (q < 0.0) { return vec2f(0.0); }
  var z = c*r2 / (1.0 + sqrt(q));
  let u2=r2/(s.bounds.y*s.bounds.y);
  let degree=min(s.media.z,28u);
  if(s.bounds.z==3.0){z+=opticalBernstein(s,sqrt(u2)).x;workCounters[WORK_POLY_FLOPS]+=3u*degree*degree/2u;}
  else{
    workCounters[WORK_POLY_FLOPS]+=2u*degree+3u;
    let xodd=s.bounds.z==1.0;let u=select(u2,sqrt(u2),xodd);var polynomial=0.0;
    for(var j=min(s.media.z,28u);j>0u;j--){polynomial=polynomial*u+opticalCoefficient(s,j-1u);}
    z+=polynomial*select(u2*u2,u,xodd);
  }
  if (!(abs(z) < 1e30)) { return vec2f(0.0); }
  return vec2f(z,1.0);
}
fn opticalNormal(s: OpticalSurface, xy: vec2f) -> vec4f {
  workCounters[WORK_NORMAL]++;
  workCounters[WORK_POLY_FLOPS]+=select(3u*min(s.media.z,28u)+3u,3u*min(s.media.z,28u)*min(s.media.z,28u)/2u,s.bounds.z==3.0);
  let r2 = dot(xy,xy);
  var c = 0.0;
  if (s.geometry.y != 0.0) { c = 1.0/s.geometry.y; }
  let q = 1.0 - (1.0+s.geometry.z)*c*c*r2;
  if (q <= 0.0) { return vec4f(0.0); }
  var derivative = c/sqrt(q);
  let scale2=s.bounds.y*s.bounds.y;
  let u2=r2/scale2;
  var polynomial=0.0;
  if(s.bounds.z==3.0){
    let u=sqrt(u2);let degree=min(s.media.z,28u);
    if(r2==0.0){
      if(degree>0u&&opticalCoefficient(s,0u)!=0.0){return vec4f(0.0);}
      if(degree>1u){derivative+=f32(degree*(degree-1u))*opticalCoefficient(s,1u)/scale2;}
    }else{derivative+=opticalBernstein(s,u).y/(u*scale2);}
  }else if(s.bounds.z==1.0){
    let u=sqrt(u2);
    if(r2==0.0){
      if(s.media.z>0u && opticalCoefficient(s,0u)!=0.0){return vec4f(0.0);}
      if(s.media.z>1u){derivative+=2.0*opticalCoefficient(s,1u)/scale2;}
    }else{
      for(var j=min(s.media.z,28u);j>0u;j--){polynomial=polynomial*u+f32(j)*opticalCoefficient(s,j-1u);}
      derivative+=polynomial/(u*scale2);
    }
  }else{
    for(var j=min(s.media.z,28u);j>0u;j--){
      let index=j-1u;
      polynomial=polynomial*u2+f32(4u+2u*index)*opticalCoefficient(s,index);
    }
    derivative+=polynomial*u2/scale2;
  }
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
// Sag interval over a radial annulus: Horner monomials or Bernstein derivative
// bounds. Padding covers
// f32 arithmetic and normalized coefficient roundoff, including cancellation.
fn opticalSagInterval(s: OpticalSurface, rLo: f32, rHi: f32) -> vec3f {
  var base=s;base.media.z=0u;
  let a=opticalSag(base,vec2f(rLo,0.0));let b=opticalSag(base,vec2f(rHi,0.0));
  if(a.y==0.0||b.y==0.0){return vec3f(0.0);}
  // Conic roundoff grows as q approaches zero. A fixed relative sag guard
  // overstates error for well-conditioned parabolas (q=1) and can prevent a
  // finite-cap miss proof forever, regardless of interval subdivision depth.
  var curvature=0.0;if(s.geometry.y!=0.0){curvature=1.0/s.geometry.y;}
  let factor=(1.0+s.geometry.z)*curvature*curvature;
  let qMin=min(1.0-factor*rLo*rLo,1.0-factor*rHi*rHi);
  let conicPadding=2e-6*(abs(a.x)+abs(b.x))*(1.0+inverseSqrt(max(qMin,1e-10)));
  if(s.bounds.z==3.0){
    let degree=min(s.media.z,28u);let uLo=rLo/s.bounds.y;let uHi=rHi/s.bounds.y;
    var previous=0.0;var maxDifference=0.0;var maxCoefficient=0.0;
    for(var j=0u;j<degree;j++){
      let value=opticalCoefficient(s,j);maxDifference=max(maxDifference,abs(value-previous));
      maxCoefficient=max(maxCoefficient,abs(value));previous=value;
    }
    // The derivative is another Bernstein polynomial. Its absolute basis sum
    // outside [0,1] is (|u|+|1-u|)^(N-1): no false convex-hull extrapolation.
    let growth=pow(max(1.0,2.0*uHi-1.0),f32(max(degree,1u)-1u));
    let halfWidth=(uHi-uLo)*0.5;
    let center=opticalBernstein(s,(uLo+uHi)*0.5).x;
    let variation=f32(degree)*maxDifference*growth*halfWidth;
    let padding=2e-5+1e-5*f32(degree)*maxCoefficient*growth+conicPadding;
    let lower=min(a.x,b.x)+center-variation-padding;
    let upper=max(a.x,b.x)+center+variation+padding;
    if(!(abs(lower)<1e30)||!(abs(upper)<1e30)){return vec3f(0.0);}
    return vec3f(lower,upper,1.0);
  }
  let xodd=s.bounds.z==1.0;
  let uLo=rLo/s.bounds.y;let uHi=rHi/s.bounds.y;
  let stepLo=select(uLo*uLo,uLo,xodd);let stepHi=select(uHi*uHi,uHi,xodd);
  var lo=0.0;var hi=0.0;var absolute=0.0;
  for(var j=min(s.media.z,28u);j>0u;j--){
    let oldLo=lo;let oldHi=hi;let coefficient=opticalCoefficient(s,j-1u);
    lo=min(oldLo*stepLo,oldLo*stepHi)+coefficient;
    hi=max(oldHi*stepLo,oldHi*stepHi)+coefficient;
    absolute=absolute*stepHi+abs(coefficient);
  }
  let powerLo=select(stepLo*stepLo,uLo,xodd);let powerHi=select(stepHi*stepHi,uHi,xodd);
  let padding=1e-5+4e-6*absolute*powerHi+conicPadding;
  let lower=min(a.x,b.x)+min(lo*powerLo,lo*powerHi)-padding;
  let upper=max(a.x,b.x)+max(hi*powerLo,hi*powerHi)+padding;
  if(!(abs(lower)<1e30)||!(abs(upper)<1e30)){return vec3f(0.0);}
  return vec3f(lower,upper,1.0);
}
// Returns (t, outcome): 1 hit, -1 proven physical miss, 0 unresolved.
// This bounded same-ray fallback never rejects/resamples a pupil point.
// It resolves a bracket on the primary sag sheet.
fn opticalBracketAsphere(s: OpticalSurface, p: vec3f, v: vec3f, tolerance: f32) -> vec2f {
  if (abs(v.z)<1e-8) { return vec2f(0.0); }
  var radius=max(s.bounds.x,1.0);
  if (s.geometry.w>0.0) { radius=min(radius,s.geometry.w*(1.0+8e-6)+tolerance); }
  if (s.geometry.y!=0.0 && s.geometry.z > -1.0) {
    radius=min(radius,abs(s.geometry.y)/sqrt(1.0+s.geometry.z)*(1.0-2e-6));
  }
  // Only a bound enclosing the full known aperture can prove physical blockage.
  // A truncated conic/numerical domain must remain an unresolved failure.
  let miss=select(0.0,-1.0,s.geometry.w>0.0 && radius>s.geometry.w);
  var base=s;
  base.media.z=0u;
  let edge=opticalSag(base,vec2f(radius,0.0));
  if (edge.y==0.0) { return vec2f(0.0); }
  var sagLo=min(edge.x,0.0);
  var sagHi=max(edge.x,0.0);
  if(s.bounds.z==3.0){
    let interval=opticalSagInterval(s,0.0,radius);
    if(interval.z==0.0){return vec2f(0.0);}
    sagLo=interval.x;sagHi=interval.y;
  }else{
    let u2=radius*radius/(s.bounds.y*s.bounds.y);let xodd=s.bounds.z==1.0;
    let radialStep=select(u2,sqrt(u2),xodd);var power=select(u2*u2,radialStep,xodd);
    for(var j=0u;j<min(s.media.z,28u);j++){
      let term=opticalCoefficient(s,j)*power;sagLo+=min(term,0.0);sagHi+=max(term,0.0);power*=radialStep;
    }
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
    if (disc<0.0) {
      let margin=1e-5*max(b*b+abs(4.0*a*cc),1.0);
      return vec2f(0.0,select(0.0,miss,disc < -margin));
    }
    lo=max(lo,(-b-sqrt(disc))/(2.0*a));
    hi=min(hi,(-b+sqrt(disc))/(2.0*a));
  } else if (cc>0.0) { return vec2f(0.0,miss); }
  if (!(abs(lo)<1e25) || !(abs(hi)<1e25)) { return vec2f(0.0); }
  if (hi<lo-tolerance) { return vec2f(0.0,miss); }
  if (hi<lo) { return vec2f(0.0); }
  var pending: array<vec3f,16>;
  pending[0]=vec3f(lo,hi,0.0);var count=1u;
  for(var work=0u;work<2048u;work++){
    if(count==0u){return vec2f(0.0,miss);}
    count--;let segment=pending[count];
    var lower=segment.x;var upper=segment.y;
    let pa=p+lower*v;let pb=p+upper*v;
    let closest=select(lower,clamp(-b/(2.0*max(a,1e-30)),lower,upper),a>1e-12);
    let pc=p+closest*v;
    let rLo=length(pc.xy);let rHi=max(length(pa.xy),length(pb.xy));
    let interval=opticalSagInterval(s,rLo,rHi);
    if(interval.z==0.0){return vec2f(0.0);}
    let fLo=min(pa.z,pb.z)-s.geometry.x-interval.y;
    let fHi=max(pa.z,pb.z)-s.geometry.x-interval.x;
    if(fLo>tolerance||fHi < -tolerance){continue;}
    var fa=opticalResidual(s,pa);let fb=opticalResidual(s,pb);
    if(fa.y>0.0&&abs(fa.x)<=tolerance){return vec2f(lower,1.0);}
    if(fb.y>0.0&&abs(fb.x)<=tolerance){return vec2f(upper,1.0);}
    if(fa.y>0.0&&fb.y>0.0&&fa.x*fb.x<0.0){
      for(var iteration=0u;iteration<32u;iteration++){
        let mid=(lower+upper)*0.5;let fm=opticalResidual(s,p+mid*v);
        if(fm.y==0.0){return vec2f(0.0);}
        if(abs(fm.x)<=tolerance){return vec2f(mid,1.0);}
        if(fm.x*fa.x>0.0){lower=mid;fa=fm;}else{upper=mid;}
      }
      return vec2f((lower+upper)*0.5,1.0);
    }
    if(segment.z>=14.0||count+2u>16u){return vec2f(0.0);}
    let mid=(lower+upper)*0.5;
    pending[count]=vec3f(mid,upper,segment.z+1.0);
    pending[count+1u]=vec3f(lower,mid,segment.z+1.0);count+=2u;
  }
  return vec2f(0.0);
}
fn opticalIntersect(s: OpticalSurface, p: vec3f, v: vec3f) -> OpticalHit {
  workCounters[WORK_LENS_SURFACE]++;
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
  for (var j=0u;j<min(s.media.z,28u);j++) { hasAsphere = hasAsphere || opticalCoefficient(s,j)!=0.0; }
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
      if (bracket.y<0.0) { return OpticalHit(p,v,1u); }
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
fn opticalIndexAt(record: u32, index: u32, fraction: f32) -> f32 {
  let offset=record*optics.counts.y+index;
  return mix(glassLut[offset],glassLut[offset+1u],fraction);
}
fn opticalPhaseGradient(s: OpticalSurface, xy: vec2f) -> vec3f {
  let scale2=s.diffraction.y*s.diffraction.y;
  let u2=dot(xy,xy)/scale2;
  var polynomial=0.0;
  for(var j=min(u32(s.diffraction.x),12u);j>0u;j--) {
    let index=j-1u;
    polynomial=polynomial*u2+f32(2u*j)*s.phase[index/4u][index%4u];
  }
  return vec3f(xy*(polynomial/scale2),0.0);
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
  // The wavelength does not change at a surface. Keep the LUT coordinate out
  // of the intersection/refraction dependency chain for every medium lookup.
  let lutU=(wavelength-optics.wavelength.x)/optics.wavelength.z;
  let lutIndex=min(u32(max(floor(lutU),0.0)),optics.counts.y-2u);
  let lutFraction=lutU-f32(lutIndex);
  var previousRecord=0xffffffffu;var previousIndex=0.0;
  for (var j=0u;j<optics.counts.x;j++) {
    let index=select(j,optics.counts.x-1u-j,reverse);
    let hit=opticalIntersect(opticalSurfaces[index],p,v);
    if (hit.status!=0u) { return RayResult(hit.p,v,hit.status); }
    // Load post-intersection fields here, rather than retaining the full
    // surface (including asphere/phase coefficients) across the root solver.
    let media=opticalSurfaces[index].media;
    let before=select(media.x,media.y,reverse);
    let after=select(media.y,media.x,reverse);
    var ni=previousIndex;
    if(before!=previousRecord){ni=opticalIndexAt(before,lutIndex,lutFraction);}
    let nt=opticalIndexAt(after,lutIndex,lutFraction);
    previousRecord=after;previousIndex=nt;
    let eta=ni/nt;
    if(opticalSurfaces[index].diffraction.x>0.0) {
      let s=opticalSurfaces[index];
      // Reciprocal phase delay: SAME kick in reverse; exchanged media and
      // reversed incident momentum then recover the reversed original path.
      let kick=wavelength*1e-6/(2.0*3.141592653589793);
      let momentum=ni*v+kick*opticalPhaseGradient(s,hit.p.xy);
      let tangent=momentum-dot(momentum,hit.n)*hit.n;
      let remainder=nt*nt-dot(tangent,tangent);
      if(remainder<0.0) { return RayResult(hit.p,v,2u); }
      let sign=select(-1.0,1.0,dot(v,hit.n)>=0.0);
      v=normalize((tangent+sign*sqrt(remainder)*hit.n)/nt);
      p=hit.p;
      if(!opticalFinite(v)) { return RayResult(p,v,3u); }
      continue;
    }
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
