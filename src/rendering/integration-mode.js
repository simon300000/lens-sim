/** Preserve the measured fused path on NVIDIA and unknown GPUs. */
export function preferredIntegrationMode(info){
  const apple=value=>/^apple(?:\s|[-_]|$)/i.test(String(value??'').trim());
  const vendor=String(info?.vendor??'').trim();
  if(vendor)return apple(vendor)?'split':'fused';
  return [info?.architecture,info?.description].some(apple)?'split':'fused';
}
