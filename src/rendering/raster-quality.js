/** Raster-preview quality settings for slower devices.
 *
 * These affect only the raster navigation view (mode A): lens tracing keeps
 * its own resolution, and still reads complete shadow maps, PMREM and the
 * water reflection (lighting-resources refreshes them regardless). Settings
 * persist per browser in localStorage. */
export const PIXEL_RATIO_OPTIONS = Object.freeze(['auto', '1', '0.75']);
export const MSAA_OPTIONS = Object.freeze([0, 4]);
export const RASTER_QUALITY_DEFAULTS = Object.freeze({ pixelRatio: 'auto', msaa: 4, ambientOcclusion: true, reflection: true, adaptiveResolution: true });
export const RASTER_QUALITY_STORAGE_KEY = 'lens-sim:raster-quality';

/** Merge a (possibly untrusted) patch into current settings; unknown keys and invalid values throw. */
export function normalizeRasterQuality(patch, current = RASTER_QUALITY_DEFAULTS) {
  if (!patch || typeof patch !== 'object') throw new Error('无效的光栅画质设置');
  const next = { ...RASTER_QUALITY_DEFAULTS, ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'pixelRatio') {
      const option = String(value);
      if (!PIXEL_RATIO_OPTIONS.includes(option)) throw new Error('无效的渲染分辨率');
      next.pixelRatio = option;
    } else if (key === 'msaa') {
      if (!MSAA_OPTIONS.some(option => String(option) === String(value))) throw new Error('无效的 MSAA 设置');
      next[key] = Number(value);
    } else if (key in RASTER_QUALITY_DEFAULTS) next[key] = Boolean(value);
    else throw new Error(`未知的光栅画质设置：${key}`);
  }
  return next;
}

/** Effective device pixel ratio for a setting; 'auto' follows the screen up to the project's 1.5 cap. */
export function rasterPixelRatio(setting, devicePixelRatio) {
  return setting === 'auto' ? Math.min(devicePixelRatio, 1.5) : Number(setting);
}

/** Saved settings, or the defaults when storage is unavailable or holds garbage. */
export function loadRasterQuality(storage) {
  try {
    const saved = storage?.getItem(RASTER_QUALITY_STORAGE_KEY);
    return saved ? normalizeRasterQuality(JSON.parse(saved)) : { ...RASTER_QUALITY_DEFAULTS };
  } catch { return { ...RASTER_QUALITY_DEFAULTS }; }
}
export function saveRasterQuality(storage, settings) {
  try { storage?.setItem(RASTER_QUALITY_STORAGE_KEY, JSON.stringify(normalizeRasterQuality(settings))); return true; }
  catch { return false; }
}
