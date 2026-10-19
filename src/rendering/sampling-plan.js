/** Bytes per PixelAccum record (optical-integrator.wgsl): xyz+attempts, failures, queries, extra. */
export const PIXEL_BYTES = 64;
export const CAMERA_WIDTHS = [6000, 6720, 7362, 7953, 8256, 8688, 9504];
export const MAX_IMAGE_WIDTH = 9504;
export function imagePlan(width, limits, { paired = false } = {}) {
  const w = Math.max(48, Math.round(width / 3) * 3), h = w * 2 / 3;
  if (!Number.isFinite(w) || w > MAX_IMAGE_WIDTH || w > limits.maxTextureDimension2D || h > limits.maxTextureDimension2D)
    throw new Error(`此 GPU 不支持 ${w}×${h} 的图像尺寸`);
  const bindingBytes = Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize);
  const rows = Math.floor(bindingBytes / (w * PIXEL_BYTES) / (paired ? 16 : 8)) * (paired ? 16 : 8);
  if (rows < (paired ? 16 : 8)) throw new Error('GPU 存储限制不足以容纳一个采样分块');
  const tiles = [];
  if(paired){
    // Each buffer owns a top band AND its reflected bottom band. Both x
    // quadrants are already in each full-width row. No cross-buffer scatter.
    for(let y=0;y<h/2;y+=rows/2){
      const halfHeight=Math.min(rows/2,h/2-y);
      tiles.push({y,halfHeight,height:halfHeight*2,bytes:w*halfHeight*2*PIXEL_BYTES});
    }
  }else for (let y = 0; y < h; y += rows) tiles.push({ y, height: Math.min(rows, h - y), bytes: w * Math.min(rows, h - y) * PIXEL_BYTES });
  return { width: w, height: h, tiles, memoryBytes: w * h * (PIXEL_BYTES + 8) };
}
/** Samples per pixel one accumulation round may add: the staged packet slot holds this
 * many optical samples per canonical pixel, and the fused kernels loop over as many. */
export const ROUND_SPP_LIMIT = 4;
export const roundSppWGSL = (limit = ROUND_SPP_LIMIT) => `const ROUND_SPP_LIMIT: u32 = ${limit}u;\n`;
export const sampleBudget = (spp, target, batch, limit = ROUND_SPP_LIMIT) => Math.min(limit, Math.max(1, batch), target === 0 ? limit : Math.max(0, target - spp));
export const hasSamplesRemaining = (spp, target) => target === 0 || spp < target;
