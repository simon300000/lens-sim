import {normalizeShaderEOL} from './shader-source.js';

/** Keep the pre-reuse source on unmeasured or regressing devices. Only the LUT
 * blocks change; intersection, Snell, phase and failure handling remain shared. */
export function opticalSourceForLutPolicy(source,reuse){
  if(reuse)return source;
  source=normalizeShaderEOL(source);
  const replacements=[
  [
    "fn opticalIndexAt(record: u32, index: u32, fraction: f32) -> f32 {\n  let offset=record*optics.counts.y+index;\n  return mix(glassLut[offset],glassLut[offset+1u],fraction);\n}\n",
    "fn opticalIndex(record: u32, lambdaNm: f32) -> f32 {\n  let u=(lambdaNm-optics.wavelength.x)/optics.wavelength.z;\n  let index=min(u32(max(floor(u),0.0)),optics.counts.y-2u);\n  let fraction=u-f32(index);\n  let offset=record*optics.counts.y+index;\n  return mix(glassLut[offset],glassLut[offset+1u],fraction);\n}\n"
  ],
  [
    "  // The wavelength does not change at a surface. Keep the LUT coordinate out\n  // of the intersection/refraction dependency chain for every medium lookup.\n  let lutU=(wavelength-optics.wavelength.x)/optics.wavelength.z;\n  let lutIndex=min(u32(max(floor(lutU),0.0)),optics.counts.y-2u);\n  let lutFraction=lutU-f32(lutIndex);\n  var previousRecord=0xffffffffu;var previousIndex=0.0;\n",
    ""
  ],
  [
    "    let hit=opticalIntersect(opticalSurfaces[index],p,v);\n    if (hit.status!=0u) { return RayResult(hit.p,v,hit.status); }\n    // Load post-intersection fields here, rather than retaining the full\n    // surface (including asphere/phase coefficients) across the root solver.\n    let media=opticalSurfaces[index].media;\n    let before=select(media.x,media.y,reverse);\n    let after=select(media.y,media.x,reverse);\n    var ni=previousIndex;\n    if(before!=previousRecord){ni=opticalIndexAt(before,lutIndex,lutFraction);}\n    let nt=opticalIndexAt(after,lutIndex,lutFraction);\n    previousRecord=after;previousIndex=nt;\n",
    "    let s=opticalSurfaces[index];\n    let hit=opticalIntersect(s,p,v);\n    if (hit.status!=0u) { return RayResult(hit.p,v,hit.status); }\n    let before=select(s.media.x,s.media.y,reverse);\n    let after=select(s.media.y,s.media.x,reverse);\n    let ni=opticalIndex(before,wavelength);\n    let nt=opticalIndex(after,wavelength);\n"
  ],
  [
    "    if(opticalSurfaces[index].diffraction.x>0.0) {\n      let s=opticalSurfaces[index];",
    "    if(s.diffraction.x>0.0) {"
  ]
];
  for(const [from,to]of replacements){
    if(source.split(from).length!==2)throw new Error('Optical LUT source specialization changed');
    source=source.replace(from,to);
  }
  return source;
}
