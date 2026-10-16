/** Analytic target reflectance, shared verbatim by Three's fragment shaders and
 * the physical lens compute shader. No texture, image or resolution-dependent LUT.
 * ISO 12233 uses tessellated Cornell SVG geometry instead (iso-chart.js). */
export const CHART_KIND=Object.freeze({SIEMENS:0,ISO12233:1,RULER:2,FOCUS:3});
// The entry function must come first for Three's wgslFn parser.
export const TEST_CHART_WGSL=`fn chartReflectance(coord: vec2f, chartKind: u32) -> f32 {
  let p=coord*2.0-1.0;
  if(chartKind==0u){
    let r=length(p);
    if(max(abs(p.x),abs(p.y))>0.975){return 0.90;}
    if(r>0.92){return 0.025;}
    if(r<0.000001){return 0.4625;}
    return mix(0.025,0.90,step(0.0,sin(atan2(p.y,p.x)*72.0)));
  }
  if(chartKind==1u){return 0.90;} // Reserved legacy material ID; ISO now uses vector geometry.
  if(chartKind==2u){return chartRuler(p*vec2f(0.325,1.5));}
  // Upright focus reference: its centre is at the inclined ruler's zero depth.
  var ink=0.0;
  if(max(abs(p.x),abs(p.y))>0.93){ink=1.0;}
  if(abs(p.x)<0.045||abs(p.y)<0.045){ink=1.0;}
  if(max(abs(p.x),abs(p.y))<0.52&&min(abs(p.x),abs(p.y))>0.12){ink=f32((u32(floor((p.x+1.0)*12.0))+u32(floor((p.y+1.0)*12.0)))&1u);}
  return mix(0.90,0.025,ink);
}
fn chartRect(p:vec2f,halfSize:vec2f)->f32{return select(0.0,1.0,all(abs(p)<=halfSize));}
fn chartDigit(p:vec2f,digit:u32)->f32{
  if(any(p<vec2f(0.0))||any(p>vec2f(1.0))){return 0.0;}
  let masks=array<u32,10>(63u,6u,91u,79u,102u,109u,125u,7u,127u,111u);
  let centres=array<vec2f,7>(vec2f(0.5,0.94),vec2f(0.88,0.73),vec2f(0.88,0.27),vec2f(0.5,0.06),vec2f(0.12,0.27),vec2f(0.12,0.73),vec2f(0.5,0.5));
  var ink=0.0;
  for(var i=0u;i<7u;i++){
    if((masks[min(digit,9u)]&(1u<<i))!=0u){let horizontal=i==0u||i==3u||i==6u;ink=max(ink,chartRect(p-centres[i],select(vec2f(0.055,0.18),vec2f(0.32,0.055),horizontal)));}
  }
  return ink;
}
fn chartNumber(p:vec2f,value:u32)->f32{
  var digits=1u;if(value>=10u){digits=2u;}if(value>=100u){digits=3u;}if(value>=1000u){digits=4u;}if(value>=10000u){digits=5u;}
  if(p.x<0.0||p.x>=f32(digits)*0.75||p.y<0.0||p.y>1.0){return 0.0;}
  let index=u32(floor(p.x/0.75));var divisor=1u;
  for(var i=0u;i<digits-index-1u;i++){divisor*=10u;}
  return chartDigit(vec2f((p.x-f32(index)*0.75)/0.6,p.y),(value/divisor)%10u);
}
fn chartRuler(p:vec2f)->f32{
  if(abs(p.x)>0.315||abs(p.y)>1.47){return 0.025;}
  let tick=round(p.y/0.01);let major=abs(tick-round(tick/10.0)*10.0)<0.1;let middle=abs(tick-round(tick/5.0)*5.0)<0.1;
  let halfWidth=select(select(0.065,0.10,middle),0.145,major);
  var ink=chartRect(vec2f(p.x+0.095,p.y-tick*0.01),vec2f(halfWidth,0.0006));
  // Bold zero line is coplanar in depth with the upright focus reference.
  ink=max(ink,chartRect(p,vec2f(0.30,0.0018)));
  let row=round(p.y/0.10);let number=u32(abs(row)*100.0);
  ink=max(ink,chartNumber((p-vec2f(0.055,row*0.10+0.012))/0.028,number));
  if(abs(row)>0.1){let s=p-vec2f(0.026,row*0.10+0.027);ink=max(ink,chartRect(s,vec2f(0.009,0.0012)));if(row>0.0){ink=max(ink,chartRect(s,vec2f(0.0012,0.009)));}}
  return mix(0.90,0.025,ink);
}
`;
