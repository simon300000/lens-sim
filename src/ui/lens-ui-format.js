import { CAMERA_WIDTHS } from '../rendering/sampling-plan.js';

/** Pure formatting, stepping and gating rules for the lens panel (no DOM). */

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** Nominal third-stop f-numbers; exact limits are always added at the ends. */
const NOMINAL_F = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.5, 2.8, 3.2, 3.5, 4, 4.5, 5, 5.6,
  6.3, 7.1, 8, 9, 10, 11, 13, 14, 16, 18, 20, 22, 25, 29, 32, 36, 40, 45, 51, 57, 64];

/** Allowed while status === 'error' so a person can get back to a working view; the backend may still reject. */
export const RECOVERY_COMMANDS = new Set(['setMode', 'selectLens', 'selectConfiguration', 'loadCustomLens']);

export const OPTICS_COMMANDS = new Set(['selectLens', 'selectConfiguration', 'loadCustomLens', 'setFNumber', 'setFocusDistance',
  'setImageDistance', 'autofocus', 'setDispersion']);

export const DIAGNOSTIC_LABELS = { beauty: '成像', 'scene-error': '场景错误分布', status: '路径状态',
  'geometry-depth': '几何深度', 'geometry-normal': '世界法线', 'geometry-material': '材质 ID' };
/** These accumulate per-path debug values, so switching to/from them restarts accumulation (backend rule). */
export const GEOMETRY_DIAGNOSTICS = ['geometry-depth', 'geometry-normal', 'geometry-material'];
/** One-line colour keys, matching the backend's resolve/accumulate encodings (src/rendering/resolve.wgsl). */
export const DIAGNOSTIC_LEGENDS = {
  'scene-error': 'R=BVH错误/透明层超限 · G=未支持材质 · B=水面反射出参考视野 · 黑=无',
  status: 'R=数值失败 · G=镜头遮挡/全反射 · B=场景命中',
  'geometry-depth': '亮=近 exp(-t/15 m)', 'geometry-normal': '世界法线×0.5+0.5', 'geometry-material': '材质 ID 哈希色',
};
export const OUTPUT_LABELS = { auto: '自动', sdr: 'SDR' };
export const ACTUAL_OUTPUT_LABELS = { hdr: 'HDR', 'sdr-tone-mapped': 'SDR 色调映射', pending: '待定' };
export const STATUS_LABELS = { loading: '加载中', ready: '就绪', error: '错误' };
export const AF_LABELS = { idle: '待命', busy: '对焦中…', success: '已合焦', error: '对焦失败' };
/** Multiples of 3 only: the engine snaps width to 3n so the 3:2 height stays an integer. */
export const RESOLUTION_PRESETS = [240, 360, 480, 600, 720, 960, 1200, 1800, 2400, 3000, 4500, ...CAMERA_WIDTHS];
export const SPP_PRESETS = [0, 1, 4, 16, 64, 256, 1024, 4096];
/** Fraction of paths that passed the lens; above this the transparency-layer cap is reported. */
export const TRANSPARENCY_LIMIT_WARN = 0.001;

export function stepsForFNumber([min, max] = [1.8, 22]) {
  if (!(finite(min) && finite(max) && min > 0 && max >= min)) return [];
  const values = NOMINAL_F.filter((n) => n > min * 1.02 && n < max / 1.02);
  return [min, ...values, ...(max > min ? [max] : [])];
}

/** 0.1 m – 1 km in roughly even log steps of round numbers, followed by infinity (null). */
const FOCUS_MANTISSAS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8.5];
export function stepsForFocus() {
  const values = [];
  for (let decade = -1; decade <= 2; decade++) {
    for (const m of FOCUS_MANTISSAS) values.push(Number((m * 10 ** decade).toPrecision(3)));
  }
  return [...values, 1000, null];
}

/** Nearest list index on a log scale; null (infinity) only matches null. */
export function nearestStep(steps, value) {
  if (value === null || value === undefined) {
    const inf = steps.indexOf(null);
    return inf >= 0 ? inf : steps.length - 1;
  }
  if (!finite(value) || value <= 0) return 0;
  let best = 0, bestDistance = Infinity;
  steps.forEach((step, index) => {
    if (step === null) return;
    const distance = Math.abs(Math.log(step / value));
    if (distance < bestDistance) { best = index; bestDistance = distance; }
  });
  return best;
}

export function formatFNumber(n) {
  if (!finite(n)) return 'f/—';
  return `f/${n < 1 ? Number(n.toFixed(2)) : Number(n.toFixed(1))}`;
}

/** Distance text that never claims calibration the backend has not confirmed. */
export function describeFocus(optics = {}) {
  const m = optics.focusDistanceM === undefined ? null : optics.focusDistanceM;
  if (optics.focusDistanceKnown === false) {
    const last = m === null ? '∞' : formatFocus(m);
    return { known: false, value: m, text: `未标定（上次设定 ${last}）`, short: '未标定' };
  }
  return { known: true, value: m, text: formatFocus(m), short: formatFocus(m) };
}

export function formatFocus(m) {
  if (m === null) return '∞';
  if (!finite(m)) return '—';
  if (m < 1) return `${(m * 100).toFixed(m < .2 ? 1 : 0)} cm`;
  if (m < 10) return `${m.toFixed(2)} m`;
  if (m < 100) return `${m.toFixed(1)} m`;
  return `${Math.round(m)} m`;
}

export const formatMm = (mm, digits = 3) => (finite(mm) ? `${mm.toFixed(digits)} mm` : '— mm');

export function formatEV(ev) {
  if (!finite(ev)) return '— EV';
  const rounded = Math.round(ev * 10) / 10;
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : '±'}${Math.abs(rounded).toFixed(1)} EV`;
}

export function formatRate(rate) {
  if (!finite(rate)) return '—';
  const percent = rate * 100;
  if (percent > 0 && percent < .01) return '<0.01%';
  return `${percent.toFixed(percent < 10 ? 2 : 1)}%`;
}

export const formatMs = (ms) => (finite(ms) ? `${ms < 10 ? ms.toFixed(2) : ms.toFixed(1)} ms` : '—');

export function formatBytes(bytes) {
  if (!finite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export const formatCount = (n) => (finite(n) ? Math.round(n).toLocaleString('en-US') : '—');

/** Mirrors the engine: width rounds to a multiple of 3 (minimum 48), height is exactly 2/3 of it. */
export const snapResolution = (width) => Math.max(48, Math.round(width / 3) * 3);
export const resolutionLabel = (width) => { const w = snapResolution(width); const pixels=w*w*2/3;return `${w}×${w * 2 / 3}${pixels>=1e6?` · ${(pixels/1e6).toFixed(1)} MP${w===9504?'（6100万级）':''}`:''}`; };

/** Clamp nothing: return a message when the value is outside what the store declares valid. */
export function validateFNumber(value, [min, max] = []) {
  if (!finite(value) || value <= 0) return '请输入有效的 f 值';
  if (finite(min) && value < min - 1e-9) return `最小 ${formatFNumber(min)}`;
  if (finite(max) && value > max + 1e-9) return `最大 ${formatFNumber(max)}`;
  return '';
}

export function validateImageDistance(value, [min, max] = []) {
  if (!finite(value)) return '请输入以 mm 为单位的数值';
  if (finite(min) && value < min - 1e-9) return `最小 ${formatMm(min)}`;
  if (finite(max) && value > max + 1e-9) return `最大 ${formatMm(max)}`;
  return '';
}

export function validateFocus(value) {
  if (!finite(value) || value <= 0) return '请输入大于 0 的距离（m）';
  return '';
}

export function validateSpp(value) {
  if (!Number.isInteger(value) || value < 0 || value > 4096) return '须为 1–4096 的整数，或选择持续采样';
  return '';
}

/**
 * Which controls may dispatch now. Every command needs `ready`; optics commands
 * are additionally locked while AF runs or a lens/configuration is loading.
 */
export function computeGates(state, pending = new Set()) {
  const ready = state?.status === 'ready';
  const lensLoading = pending.has('selectLens') || pending.has('selectConfiguration');
  const afBusy = state?.af?.status === 'busy' || pending.has('autofocus');
  return { ready, lensLoading, afBusy, opticsLocked: !ready || lensLoading || afBusy };
}

export function isCommandEnabled(type, state, pending = new Set()) {
  const gates = computeGates(state, pending);
  if (!gates.ready) {
    if (state?.status !== 'error' || !RECOVERY_COMMANDS.has(type)) return false;
    if (type === 'setMode') return true;
    // Lens recovery needs a catalogue; a stale AF flag must not block it, an in-flight lens load does.
    return Array.isArray(state.lenses) && state.lenses.length > 0 && !gates.lensLoading;
  }
  if (OPTICS_COMMANDS.has(type)) return !gates.opticsLocked;
  return true;
}

/** One honest line saying what is on screen; lens mode is never reported as an image before samples exist. */
export function describeView(state) {
  if (!state || state.status === 'loading') return { tone: 'busy', text: '镜头后端加载中' };
  if (state.status === 'error') return { tone: 'error', text: state.mode === 'lens' ? '镜头后端错误 · 非镜头成像' : '镜头后端错误 · 光栅近似' };
  if (state.mode !== 'lens') return { tone: 'raster', text: '光栅近似预览（非镜头成像）' };
  const { spp = 0, targetSpp = 0, paused = false } = state.sampling || {};
  if (!(spp > 0)) {
    // The backend cannot sample before the BVH is ready: say why instead of "waiting".
    const scene = state.scene?.status;
    if (scene === 'error') return { tone: 'error', text: '镜头追迹 · 场景准备失败，无样本' };
    if (scene === 'pending' || scene === 'building') return { tone: 'busy', text: '镜头追迹 · 场景准备中，尚无样本' };
    return { tone: 'busy', text: paused ? '镜头追迹 · 已暂停，尚无样本' : '镜头追迹 · 等待首批样本' };
  }
  const progress = targetSpp===0?`${formatCount(spp)} spp · 持续采样`:`${formatCount(spp)}/${formatCount(targetSpp)} spp`;
  if (paused) return { tone: 'lens', text: `镜头追迹 · ${progress} · 已暂停` };
  return { tone: 'lens', text: `镜头追迹 · ${progress}${targetSpp>0&&spp >= targetSpp ? ' · 完成' : ''}` };
}

/** Real scene/BVH preparation state; there is no percentage, so none is shown. */
export function describeScene(scene) {
  const status = scene?.status || 'pending';
  const message = scene?.message || '';
  if (status === 'ready') {
    const instances = scene?.summary?.instances;
    return { status, text: finite(instances) ? `BVH 就绪 ${formatCount(instances)} 实例` : message || 'BVH 就绪' };
  }
  if (status === 'error') return { status, text: `场景准备失败：${message || '原因未提供'}` };
  if (status === 'building') return { status, text: `场景准备：${message || '构建 BVH…'}` };
  return { status, text: '场景准备：等待开始' };
}

/**
 * Lens-image blockers and quality warnings from real backend values only.
 * 'error' items stop the lens image (lighting, BVH); 'warn' items are counted zero contributions.
 */
export function sceneWarnings(state = {}) {
  const items = [];
  for (const text of state.scene?.lighting?.errors || []) items.push({ level: 'error', text: `光照资源错误：${text}` });
  const unsupported = state.scene?.summary?.unsupported || [];
  if (unsupported.length) items.push({ level: 'warn', text: `未支持材质（贡献为零）：${unsupported.join('、')}` });
  const d = state.diagnostics || {};
  if (d.attemptedSamples > 0 && finite(d.bvhErrorRate) && d.bvhErrorRate > 0) {
    items.push({ level: 'error', text: `BVH 遍历错误 ${formatRate(d.bvhErrorRate)}（占通过镜头的光线，实现错误）` });
  }
  if (d.attemptedSamples > 0 && finite(d.transparencyLimitRate) && d.transparencyLimitRate > TRANSPARENCY_LIMIT_WARN) {
    items.push({ level: 'warn', text: `透明层超过上限 ${formatRate(d.transparencyLimitRate)}（占通过镜头的光线，贡献为零）` });
  }
  return items;
}

export function samplingText(sampling = {}) {
  const { spp = 0, targetSpp = 0, paused } = sampling;
  if (targetSpp===0) return `${paused?'已暂停':'持续采样'} · ${formatCount(spp)} spp`;
  if (paused) return `已暂停 · ${formatCount(spp)} / ${formatCount(targetSpp)} spp`;
  if (spp >= targetSpp && targetSpp > 0) return `已完成 · ${formatCount(spp)} / ${formatCount(targetSpp)} spp`;
  return `${formatCount(spp)} / ${formatCount(targetSpp)} spp`;
}

export function lensOptionLabel(lens) {
  if (lens.available === false) return `${lens.name}（不可用${lens.reason ? `：${lens.reason}` : ''}）`;
  return lens.name;
}

export const ALL_BRANDS = '*';
export const OTHER_BRAND = '其他 / 未分类';
/**
 * Fallback when the store does not carry the catalogue's `brand`: earliest maker keyword in the name.
 * tests/ui-lens.test.mjs checks this reproduces public/lenses/manifest.json brands for every lens.
 */
const BRAND_RULES = [
  [/canon/i, '佳能 Canon'], [/nikon/i, '尼康 Nikon'], [/pentax|takumar|\bsmc\b/i, '宾得 Pentax'], [/sigma/i, '适马 SIGMA'],
  [/sony/i, '索尼 Sony'], [/fuji/i, '富士 Fujifilm'], [/leica/i, '徕卡 Leica'], [/voigtl/i, '福伦达 Voigtländer'],
  [/viltrox/i, '唯卓仕 Viltrox'], [/hasselblad/i, '哈苏 Hasselblad'], [/olympus|^om[\s_-]/i, '奥林巴斯 Olympus'],
  [/zeiss|loxia/i, '蔡司 ZEISS'], [/7artisans/i, '七工匠 7Artisans'], [/songraw/i, 'SONGRAW'], [/panasonic|lumix/i, '松下 Panasonic'],
  [/meike/i, '美科 MEIKE'], [/zhongyi/i, '中一光学 Zhongyi'],
];
export function brandOf(lens = {}) {
  if (typeof lens.brand === 'string' && lens.brand.trim()) return lens.brand.trim();
  const name = String(lens.name || lens.id || '');
  let brand = OTHER_BRAND, at = Infinity;
  for (const [pattern, label] of BRAND_RULES) {
    const match = pattern.exec(name);
    if (match && match.index < at) { at = match.index; brand = label; }
  }
  return brand;
}

/** Brands with counts, largest first; the uncategorised group always last. */
export function brandGroups(lenses = [], availableOnly = false) {
  const groups = new Map();
  for (const lens of lenses) {
    const brand = brandOf(lens);
    const group = groups.get(brand) || { brand, total: 0, available: 0 };
    group.total++;
    if (lens.available !== false) group.available++;
    groups.set(brand, group);
  }
  const count = (g) => (availableOnly ? g.available : g.total);
  return [...groups.values()].sort((a, b) => (a.brand === OTHER_BRAND) - (b.brand === OTHER_BRAND)
    || count(b) - count(a) || a.brand.localeCompare(b.brand));
}

export function filterLenses(lenses = [], { query = '', availableOnly = false, brand = ALL_BRANDS } = {}) {
  const needle = query.trim().toLowerCase();
  return lenses.filter((lens) => (!availableOnly || lens.available !== false)
    && (brand === ALL_BRANDS || brandOf(lens) === brand)
    && (!needle || `${lens.name} ${lens.id}`.toLowerCase().includes(needle)))
    .sort((a,b)=>{
      const focal=l=>finite(l.focalLengthMm)&&l.focalLengthMm>0?l.focalLengthMm:Infinity;
      return focal(a)-focal(b);
    });
}

/** Keyboard F → AF-S, but never while typing, with modifiers, or on auto-repeat. */
export function isAutofocusShortcut(event) { return isKeyShortcut(event, 'f'); }
/** Single-letter shortcut, ignored while typing, with modifiers or on auto-repeat. */
export function isKeyShortcut(event, letter) {
  if (!event || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (String(event.key).toLowerCase() !== letter) return false;
  const target = event.target;
  const tag = target?.tagName?.toUpperCase?.();
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return false;
  if (target?.isContentEditable) return false;
  return true;
}

export function errorMessage(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  return error.message || String(error);
}
