/** NVIDIA has measured gains; Apple retains the original optical lookup.
 * Unknown vendors keep the original path until an independent A/B exists. */
export function preferredOpticalLutReuse(info) {
  const vendor=String(info?.vendor??'').trim();
  return vendor?/^(?:nvidia(?:\s|[-_]|$)|(?:0x)?10de$)/i.test(vendor):/\bnvidia\b/i.test(String(info?.description??''));
}
