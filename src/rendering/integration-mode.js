/** staged (lens batch, lean traversal kernel, shading) measured 18% faster than
 * fused on NVIDIA with identical output; Apple keeps its measured split path. */
export function preferredIntegrationMode(info){
  const apple=value=>/^apple(?:\s|[-_]|$)/i.test(String(value??'').trim());
  const vendor=String(info?.vendor??'').trim();
  if(vendor)return apple(vendor)?'split':'staged';
  return [info?.architecture,info?.description].some(apple)?'split':'staged';
}

/** NVIDIA has measured gains; Apple fused regressed and split was neutral.
 * Unknown vendors keep the original path until an independent A/B exists. */
export function preferredOpticalLutReuse(info) {
  const vendor=String(info?.vendor??'').trim();
  return vendor?/^(?:nvidia(?:\s|[-_]|$)|(?:0x)?10de$)/i.test(vendor):/\bnvidia\b/i.test(String(info?.description??''));
}
