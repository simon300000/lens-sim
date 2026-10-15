/** lens-bench/Zemax Binary 2 phase: Φ = order Σ ai (r/R)^(2i), radians.
 * Wavelengths at this API are nm; all geometry and phase gradients are mm.
 * This is geometric tracing of the prescribed order, not diffraction efficiency,
 * order splitting or coherent interference (the source does not provide these).
 */
export function phaseGradient(surface,x,y) {
  if(!surface.doe)return [0,0,0];
  const {order,normalizationRadiusMm:R,coefficients}=surface.doe;
  const rho2=(x*x+y*y)/(R*R);
  let polynomial=0;
  for(let j=coefficients.length;j>0;j--)polynomial=polynomial*rho2+2*j*coefficients[j-1];
  const factor=order*polynomial/(R*R);
  return [x*factor,y*factor,0];
}
export function diffractivePower(surface,wavelengthNm) {
  const d=surface.doe;
  return d?-(wavelengthNm*1e-6/Math.PI)*d.order*(d.coefficients[0]??0)/d.normalizationRadiusMm**2:0;
}
/** Normalize phase for f32 without ever casting raw high-order mm coefficients. */
export function normalizeDiffraction(surface,scaleMm) {
  const d=surface.doe;
  if(!d)return [];
  if(!Number.isInteger(d.order)||!Number.isFinite(Math.fround(d.order))||!Number.isFinite(Math.fround(d.normalizationRadiusMm))||Math.fround(d.normalizationRadiusMm)<1.1754943508222875e-38||!Number.isFinite(d.normalizationRadiusMm)||d.normalizationRadiusMm<=0||!Array.isArray(d.coefficients)||d.coefficients.length>12)throw new Error(`S${surface.index+1}: invalid DOE order/radius or more than 12 phase terms`);
  return d.coefficients.map((a,j)=>{
    const value=d.order*a*(scaleMm/d.normalizationRadiusMm)**(2+2*j),f=Math.fround(value);
    if(!Number.isFinite(a)||!Number.isFinite(f)||Math.abs(f)>1e25||(d.order!==0&&a!==0&&Math.abs(f)<1.1754943508222875e-38))throw new Error(`S${surface.index+1}: DOE phase term ${j+1} cannot be represented as normalized f32`);
    return f;
  });
}
