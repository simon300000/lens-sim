/** Radial sag polynomial. XODD coefficients are mm at normalized r/Rn;
 * retaining them avoids destroying tiny high-order raw-mm coefficients. */
export function radialPolynomial(surface) {
  return surface.xodd
    ? {coefficients:surface.xodd.coefficients, radiusMm:surface.xodd.normalizationRadiusMm,startPower:1,step:1}
    : {coefficients:surface.aspheric??[],radiusMm:1,startPower:4,step:2};
}
export const conicOnly = surface => ({...surface,aspheric:[],xodd:null});
export function axialCurvature(surface) {
  const base=surface.radiusMm?1/surface.radiusMm:0;
  if(!surface.xodd)return base;
  if(surface.xodd.coefficients[0])throw new Error(`S${surface.index+1}: XODD A1 非零，轴心无唯一法线，无法定义近轴光学`);
  return base+2*(surface.xodd.coefficients[1]??0)/surface.xodd.normalizationRadiusMm**2;
}
