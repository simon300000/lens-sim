/** Bytes per PixelAccum record (optical-integrator.wgsl): xyz+attempts, failures, queries, extra. */
export const PIXEL_BYTES = 64;
export const CAMERA_WIDTHS = [6000, 6720, 7362, 7953, 8256, 8688, 9504];
export const MAX_IMAGE_WIDTH = 9504;
export function imagePlan(width, limits) {
  const w = Math.max(48, Math.round(width / 3) * 3), h = w * 2 / 3;
  if (!Number.isFinite(w) || w > MAX_IMAGE_WIDTH || w > limits.maxTextureDimension2D || h > limits.maxTextureDimension2D)
    throw new Error(`此 GPU 不支持 ${w}×${h} 的图像尺寸`);
  const bindingBytes = Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize);
  const rows = Math.floor(bindingBytes / (w * PIXEL_BYTES) / 8) * 8;
  if (rows < 8) throw new Error('GPU 存储限制不足以容纳一个采样分块');
  const tiles = [];
  for (let y = 0; y < h; y += rows) tiles.push({ y, height: Math.min(rows, h - y), bytes: w * Math.min(rows, h - y) * PIXEL_BYTES });
  return { width: w, height: h, tiles, memoryBytes: w * h * (PIXEL_BYTES + 8) };
}
export const sampleBudget = (spp, target, batch) => Math.min(4, Math.max(1, batch), target === 0 ? 4 : Math.max(0, target - spp));
export const hasSamplesRemaining = (spp, target) => target === 0 || spp < target;
