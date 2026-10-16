/**
 * Prescription workbench helpers: load the static glass catalog, import
 * .seq/.zmx files, edit lens-bench records as table rows and re-run the same
 * adapter + static preflight that scripts/build-lens-data.mjs applies.
 *
 * Row editing follows lens-bench js/app.js conventions (GPL-3.0): a cell whose
 * surface is overridden by the active configuration (cfg.thi / cfg.rdy) is
 * written back to that configuration, every other edit goes to the base `tx`.
 */
import { refractiveIndex, resolveGlass, FRAUNHOFER_NM } from './glass.js';
import { adaptLensRecord } from './prescription.js';
import { preflightLens } from './capabilities.js';
import { fileToLens, setGlassCheck, rowsToText, slug } from './lens-import.js';

export const CUSTOM_PREFIX = 'custom:';
export const CUSTOM_BRAND = '导入与编辑';

let catalogPromise = null;
/** Fetched once, on first use (≈1 MB, compresses well); never needed for bundled lenses. */
export function loadGlassCatalog(fetchImpl = globalThis.fetch) {
  catalogPromise ??= Promise.resolve().then(() => fetchImpl('/lenses/glass-catalog.json')).then((response) => {
    if (!response.ok) throw new Error('玻璃目录缺失：运行 npm run build:lenses');
    return response.json();
  }).catch((error) => { catalogPromise = null; throw error; });
  return catalogPromise;
}

/** lens-bench's glass check contract: false (unknown) or {nd, vd, cat, sub}. */
export function glassChecker(catalog) {
  return (name) => {
    try {
      const glass = resolveGlass(name, catalog);
      if (glass.formula === 'air') return false;
      const { d, F, C } = FRAUNHOFER_NM;
      const nd = refractiveIndex(glass, d);
      const vd = (nd - 1) / (refractiveIndex(glass, F) - refractiveIndex(glass, C));
      return { nd, vd, cat: glass.catalog ?? '', sub: Boolean(glass.model || glass.approximation) };
    } catch { return false; }
  };
}

/** File bytes (or text) → lens-bench record, exactly as lens-bench's own drag-and-drop import. */
export function importLensFile(input, fileName, catalog) {
  setGlassCheck(glassChecker(catalog));
  try {
    const record = fileToLens(input, fileName);
    if (!record.tx?.trim()) throw new Error('文件中没有可读取的序列面');
    return record;
  } finally { setGlassCheck(null); }
}

/** Same adapter + preflight as the build; returns an asset shaped like public/lenses/<id>.json. */
export function inspectRecord(record, catalog) {
  const cfgs = record.cfgs?.length ? record.cfgs : [null];
  const configurations = [], configurationStatus = [];
  cfgs.forEach((cfg, index) => {
    const title = cfg?.title ?? 'Default';
    try {
      const lens = adaptLensRecord(record, catalog, { configurationIndex: index });
      const capability = preflightLens(lens);
      lens.capabilityWarnings = capability.warnings;
      lens.capability = capability;
      configurations.push(capability.supported ? lens : null);
      configurationStatus.push({ index, title, ...capability, parserSupported: true, warnings: [...lens.warnings, ...capability.warnings] });
    } catch (error) {
      configurations.push(null);
      configurationStatus.push({ index, title, supported: false, parserSupported: false, reason: error.message, warnings: [] });
    }
  });
  return { schemaVersion: 1, id: record.id, configurations, configurationStatus, record, upstreamWarnings: [...(record.warn ?? [])] };
}

export const customLensId = (record) => `${CUSTOM_PREFIX}${slug(record.id || record.name || 'lens')}`;
export const isCustomLensId = (id) => typeof id === 'string' && id.startsWith(CUSTOM_PREFIX);

// ---------------------------------------------------------------- rows
const NUMERIC = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
export const blankRow = () => ({ R: 'inf', T: '0', mat: '', sd: '', k: '', asph: '' });

/** tx text → editable rows (R, T, mat, sd, k, asph), tolerant of a missing material column. */
export function textToRows(text) {
  return String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && !line.startsWith('//')).map((line) => {
    const t = line.split(/[\s,;]+/);
    let i = 2;
    const row = { R: t[0] ?? 'inf', T: t[1] ?? '0', mat: '', sd: '', k: '', asph: '' };
    if (t[i] !== undefined && !NUMERIC.test(t[i])) { const m = t[i++]; row.mat = m === '-' ? '' : m; }
    if (t[i] !== undefined) { const sd = t[i++]; row.sd = sd === '-' ? '' : sd; }
    if (t[i] !== undefined && NUMERIC.test(t[i])) row.k = t[i++];
    row.asph = t.slice(i).join(' ');
    return row;
  });
}

const fmt = (v) => String(Number(Number(v).toPrecision(12)));

/** Editable view of one configuration: base rows with that configuration's overrides applied. */
export function recordToDraft(record, configurationIndex = 0) {
  const rows = textToRows(record.tx);
  const cfg = record.cfgs?.[configurationIndex] ?? null;
  const overridden = { T: new Set(), R: new Set() };
  for (const [k, v] of Object.entries(cfg?.thi ?? {})) if (rows[k]) { rows[k].T = fmt(v); overridden.T.add(Number(k)); }
  for (const [k, v] of Object.entries(cfg?.rdy ?? {})) if (rows[k]) { rows[k].R = v === 0 ? 'inf' : fmt(v); overridden.R.add(Number(k)); }
  const hints = rows.map((_, i) => record.sdAp?.[i] ?? record.sdDraw?.[i] ?? null);
  return {
    name: record.name ?? record.id ?? '未命名镜头', rows, stopIndex: Math.max(0, Math.min(rows.length - 1, (record.stop ?? 1) - 1)),
    configurationIndex, overridden: { T: [...overridden.T], R: [...overridden.R] }, apertureHints: hints,
    fno: cfg?.fno ?? record.fno ?? null, apmode: record.apmode ?? 'fno',
    objectDistanceMm: cfg && Object.hasOwn(cfg, 'obj') ? cfg.obj : record.objd ?? null,
  };
}

/** Draft → record; overridden cells write back to the active configuration (lens-bench cfgWriteBack). */
export function draftToRecord(record, draft) {
  const next = structuredClone(record);
  const cfg = next.cfgs?.[draft.configurationIndex] ?? null;
  const base = textToRows(record.tx);
  const rows = draft.rows.map((row, i) => {
    const out = { ...row };
    const value = (field) => (field === 'R' ? (/^(?:inf|infinity|∞)$/i.test(row.R.trim()) ? 0 : Number(row.R)) : Number(row.T));
    for (const [field, key] of [['T', 'thi'], ['R', 'rdy']]) {
      if (cfg && draft.overridden[field].includes(i)) {
        cfg[key] ??= {};
        cfg[key][i] = value(field);
        out[field] = base[i]?.[field] ?? row[field];
      }
    }
    return out;
  });
  next.tx = rowsToText(rows);
  next.stop = draft.stopIndex + 1;
  next.name = draft.name;
  if (Number.isFinite(draft.fno) && draft.fno > 0) { if (cfg && cfg.fno != null) cfg.fno = draft.fno; else next.fno = draft.fno; }
  if (draft.apmode) next.apmode = draft.apmode;
  return next;
}

/** Insert a blank surface before `index`; configuration keys and per-surface arrays stay aligned. */
export function insertSurface(record, draft, index) {
  const rec = shiftSurfaces(record, index, +1), d = structuredClone(draft);
  d.rows.splice(index, 0, blankRow());
  d.apertureHints.splice(index, 0, null);
  for (const field of ['T', 'R']) d.overridden[field] = d.overridden[field].map((k) => (k >= index ? k + 1 : k));
  if (d.stopIndex >= index) d.stopIndex++;
  return { record: rec, draft: d };
}
export function deleteSurface(record, draft, index) {
  if (draft.rows.length <= 1) throw new Error('至少保留一个面');
  if (index === draft.stopIndex) throw new Error('不能删除光阑面；先把光阑设到其它面');
  const rec = shiftSurfaces(record, index, -1), d = structuredClone(draft);
  d.rows.splice(index, 1);
  d.apertureHints.splice(index, 1);
  for (const field of ['T', 'R']) d.overridden[field] = d.overridden[field].filter((k) => k !== index).map((k) => (k > index ? k - 1 : k));
  if (d.stopIndex > index) d.stopIndex--;
  return { record: rec, draft: d };
}
function shiftSurfaces(record, index, delta) {
  const next = structuredClone(record);
  const rows = textToRows(next.tx);
  if (delta > 0) rows.splice(index, 0, blankRow()); else rows.splice(index, 1);
  next.tx = rowsToText(rows);
  for (const key of ['sdAp', 'sdDraw']) if (Array.isArray(next[key])) { if (delta > 0) next[key].splice(index, 0, null); else next[key].splice(index, 1); }
  for (const cfg of next.cfgs ?? []) for (const key of ['thi', 'rdy']) {
    if (!cfg?.[key]) continue;
    const moved = {};
    for (const [k, v] of Object.entries(cfg[key])) {
      const n = Number(k);
      if (delta < 0 && n === index) continue;
      moved[n >= index ? n + delta : n] = v;
    }
    cfg[key] = moved;
  }
  const stop = (next.stop ?? 1) - 1;
  if (delta > 0 && stop >= index) next.stop = stop + 2;
  if (delta < 0 && stop > index) next.stop = stop;
  // Focus/zoom cam tables are keyed by surface; a structural edit invalidates them.
  if (next.zoomcam) { delete next.zoomcam; (next.warn ??= []).push('结构已编辑：移除了随面号索引的变焦/对焦凸轮表。'); }
  return next;
}

/** Validate one editable cell; returns '' or a short message. */
export function validateCell(field, value) {
  const v = String(value ?? '').trim();
  if (field === 'R') return !v || /^(?:inf|infinity|∞|plano|flat)$/i.test(v) || NUMERIC.test(v) ? '' : '半径需为数值或 inf';
  if (field === 'T') return NUMERIC.test(v) ? (Number(v) < 0 ? '厚度不能为负' : '') : '厚度需为数值';
  if (field === 'sd') return !v || (NUMERIC.test(v) && Number(v) > 0) ? '' : '半孔径需为正数或留空';
  if (field === 'k') return !v || NUMERIC.test(v) ? '' : '圆锥系数需为数值';
  if (field === 'asph') {
    if (!v) return '';
    const t = v.split(/\s+/);
    const words = t.filter((x) => !NUMERIC.test(x));
    return words.every((w) => /^(?:XODD|DOE)$/i.test(w)) ? '' : '非球面系数需为数值（可含 XODD / DOE 段）';
  }
  return '';
}

/** Surface type label for the table. */
export function rowType(row) {
  const asph = String(row.asph ?? '').trim();
  if (/\bDOE\b/i.test(asph)) return '衍射';
  if (/^XODD\b/i.test(asph)) return '奇次非球面';
  if (asph && asph.split(/\s+/).some((x) => NUMERIC.test(x) && Number(x) !== 0)) return '非球面';
  if (row.k && Number(row.k) !== 0) return '二次曲面';
  return /^(?:inf|infinity|∞|plano|flat)$/i.test(String(row.R).trim()) || Number(row.R) === 0 ? '平面' : '球面';
}
