/**
 * Save the rendered picture as PNG.
 *  - Lens mode: the accumulated sensor image itself (full capture resolution, no
 *    letterbox), read back from the linear rgba16float output in row chunks and
 *    mapped exactly like the SDR display: exposure → three r183 ACES filmic → sRGB.
 *    Bloom is a display-only glare pass and is not baked in.
 *  - Diagnostic views are written clamped and unexposed, as displayed.
 *  - Raster mode: the canvas as displayed (navigation preview, not a lens image).
 */
const MAX_CHUNK_BYTES = 32 * 1024 * 1024;

/** three's ACESFilmicToneMapping (r183 TSL), scalar JS port; input already multiplied by exposure. */
export function acesFilmic(r, g, b) {
  r /= 0.6; g /= 0.6; b /= 0.6;
  const x = 0.59719 * r + 0.35458 * g + 0.04823 * b;
  const y = 0.07600 * r + 0.90834 * g + 0.01566 * b;
  const z = 0.02840 * r + 0.13383 * g + 0.83777 * b;
  const fit = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
  const fx = fit(x), fy = fit(y), fz = fit(z);
  const clamp = (v) => Math.min(1, Math.max(0, v));
  return [
    clamp(1.60475 * fx - 0.53108 * fy - 0.07367 * fz),
    clamp(-0.10208 * fx + 1.10813 * fy - 0.00605 * fz),
    clamp(-0.00327 * fx - 0.07276 * fy + 1.07602 * fz),
  ];
}
export function encodeSRGB(v) {
  const c = Math.min(1, Math.max(0, v));
  return Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
}
/** IEEE half → number (lookup built once). */
const HALF = (() => {
  const table = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    table[h] = e === 0 ? s * 2 ** -14 * (m / 1024) : e === 31 ? (m ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + m / 1024);
  }
  return table;
})();

/** Linear half-float RGBA rows → 8-bit sRGB RGBA, in place into `out` (Uint8ClampedArray). */
export function mapRows(halfRows, rowStrideHalves, width, rows, out, outOffset, { exposure = 1, raw = false } = {}) {
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * rowStrideHalves + x * 4, o = outOffset + (y * width + x) * 4;
      let r = HALF[halfRows[i]], g = HALF[halfRows[i + 1]], b = HALF[halfRows[i + 2]];
      if (!Number.isFinite(r)) r = 0; if (!Number.isFinite(g)) g = 0; if (!Number.isFinite(b)) b = 0;
      if (!raw) [r, g, b] = acesFilmic(Math.max(0, r * exposure), Math.max(0, g * exposure), Math.max(0, b * exposure));
      out[o] = encodeSRGB(r); out[o + 1] = encodeSRGB(g); out[o + 2] = encodeSRGB(b); out[o + 3] = 255;
    }
  }
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  return canvas;
}
const toPNG = (canvas) => (canvas.convertToBlob ? canvas.convertToBlob({ type: 'image/png' })
  : new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png')));

export async function exportLensTexture({ device, texture, width = texture.width, height = texture.height, exposure, raw }) {
  if (texture.format !== 'rgba16float') throw new Error(`未预期的镜头图像格式 ${texture.format}`);
  const canvas = makeCanvas(width, height), context = canvas.getContext('2d');
  if (!context) throw new Error(`无法创建 ${width}×${height} 的导出画布（超出浏览器上限）`);
  const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
  const rowsPerChunk = Math.max(1, Math.min(height, Math.floor(MAX_CHUNK_BYTES / bytesPerRow)));
  const buffer = device.createBuffer({ size: bytesPerRow * rowsPerChunk, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    for (let y0 = 0; y0 < height; y0 += rowsPerChunk) {
      const rows = Math.min(rowsPerChunk, height - y0);
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture, origin: { x: 0, y: y0 } }, { buffer, bytesPerRow }, { width, height: rows });
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const halves = new Uint16Array(buffer.getMappedRange(0, bytesPerRow * rows));
      const image = context.createImageData(width, rows);
      mapRows(halves, bytesPerRow / 2, width, rows, image.data, 0, { exposure, raw });
      buffer.unmap();
      context.putImageData(image, 0, y0);
    }
  } finally { if (buffer.mapState === 'mapped') buffer.unmap(); buffer.destroy(); }
  return toPNG(canvas);
}

/** Must run in the same task as the render call: the WebGPU canvas texture is only valid until presentation. */
export function captureCanvas(source) {
  const canvas = makeCanvas(source.width, source.height);
  canvas.getContext('2d').drawImage(source, 0, 0);
  return toPNG(canvas);
}

export function downloadBlob(blob, fileName, doc = document) {
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url; a.download = fileName; a.rel = 'noopener';
  doc.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
