/** Independent adapter for lens-bench data records (GPL-3.0 source conventions).
 * Coordinates: millimetres, first vertex z=0, positive z object → sensor.
 * The material on a tx row is the medium AFTER that interface.
 */
import { AIR, resolveGlass, refractiveIndex } from './glass.js';
import { buildFocusMotion } from './focus-motion.js';

const numeric = token => /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(token);
const positiveRadius = value => Number.isFinite(value) && value > 0 ? value : null;
function number(token, label) {
  if (!numeric(String(token))) throw new Error(`${label}: invalid number ${token}`);
  return Number(token);
}
function radius(token) {
  if (/^(?:inf|infinity|∞|plano|flat|-)$/i.test(token)) return 0;
  return number(token, 'Radius');
}

export function parsePrescriptionText(text) {
  const surfaces = [];
  for (const [lineIndex, raw] of String(text).split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const tokens = line.split(/[\s,;]+/);
    if (tokens.length < 2) throw new Error(`Prescription line ${lineIndex + 1}: requires R T`);
    const radiusMm = radius(tokens[0]), thicknessMm = number(tokens[1], `Thickness line ${lineIndex + 1}`);
    let cursor = 2, material = 'air';
    // A missing material leaves aperture at column 3, matching upstream tx grammar.
    if (tokens[cursor] && !numeric(tokens[cursor])) material = tokens[cursor++];
    let apertureRadiusMm = null, conic = 0;
    if (tokens[cursor] !== undefined) {
      const token = tokens[cursor++];
      if (token !== '-') {
        const aperture = number(token, `Aperture line ${lineIndex + 1}`);
        if (aperture < 0) throw new Error(`Negative physical aperture at line ${lineIndex + 1}`);
        apertureRadiusMm = positiveRadius(aperture);
      }
    }
    if (tokens[cursor] !== undefined) conic = number(tokens[cursor++], `Conic line ${lineIndex + 1}`);
    const unsupported = tokens.slice(cursor).find(x => /^(?:DOE|ODD|XODD)$/i.test(x));
    if (unsupported) throw new Error(`Unsupported surface ${unsupported.toUpperCase()} at line ${lineIndex + 1}; no spherical substitution`);
    const aspheric = tokens.slice(cursor).map(x => number(x, `Aspheric coefficient line ${lineIndex + 1}`));
    while (aspheric.length && aspheric.at(-1) === 0) aspheric.pop();
    if (aspheric.length > 12) throw new Error(`Even asphere above A26 is unsupported at line ${lineIndex + 1}`);
    surfaces.push({ index: surfaces.length, radiusMm, thicknessMm, material, apertureRadiusMm, conic, aspheric });
  }
  if (!surfaces.length) throw new Error('Empty lens prescription');
  return surfaces;
}

function applyOverrides(surfaces, values, field) {
  for (const [indexText, value] of Object.entries(values ?? {})) {
    const index = Number(indexText);
    if (!Number.isInteger(index) || index < 0 || index >= surfaces.length) throw new Error(`Configuration ${field} index ${indexText} outside prescription`);
    if (!Number.isFinite(value)) throw new Error(`Configuration ${field}[${index}] is not finite`);
    surfaces[index][field] = value;
  }
}

/** Produces a self-contained LensPrescription without importing any upstream JS. */
export function adaptLensRecord(record, catalog, { configurationIndex = 0 } = {}) {
  const configurations = record.cfgs?.length ? record.cfgs : [null];
  if (!Number.isInteger(configurationIndex) || configurationIndex < 0 || configurationIndex >= configurations.length) throw new Error(`Invalid configuration ${configurationIndex} for ${record.id}`);
  const configuration = configurations[configurationIndex];
  const surfaces = parsePrescriptionText(record.tx);
  const focusMotion = buildFocusMotion(record, surfaces, configurationIndex);
  applyOverrides(surfaces, configuration?.thi, 'thicknessMm');
  applyOverrides(surfaces, configuration?.rdy, 'radiusMm');
  const stopIndex = record.stop - 1;
  if (!Number.isInteger(stopIndex) || stopIndex < 0 || stopIndex >= surfaces.length) throw new Error(`Invalid 1-based stop ${record.stop} for ${record.id}`);
  const apertureMode = record.apmode ?? 'fno';
  if (!['fno', 'fnoinf', 'epd', 'stop'].includes(apertureMode)) throw new Error(`Unsupported aperture mode ${apertureMode}`);
  const apertureValue = configuration?.fno ?? record.fno;
  if (!(Number.isFinite(apertureValue) && apertureValue > 0)) throw new Error(`Invalid aperture value for ${record.id}`);
  const glasses = { air: AIR }, warnings = [...(record.warn ?? [])];
  let zMm = 0, before = AIR;
  for (const surface of surfaces) {
    const after = resolveGlass(surface.material, catalog);
    for (let nm = 380; nm <= 780; nm += 5) refractiveIndex(after, nm);
    glasses[after.id] = after;
    surface.zMm = zMm;
    surface.mediumBefore = before.id;
    surface.mediumAfter = after.id;
    const txAperture = surface.apertureRadiusMm;
    surface.apertureRadiusMm ??= positiveRadius(record.sdAp?.[surface.index]);
    surface.apertureSource = surface.apertureRadiusMm ? (txAperture ? 'tx-explicit' : 'sdAp-explicit') : 'unknown';
    surface.drawRadiusMm = positiveRadius(record.sdDraw?.[surface.index]);
    surface.type = surface.aspheric.length ? 'even-asphere' : surface.conic !== 0 ? 'conic' : surface.radiusMm === 0 ? 'plane' : 'sphere';
    if (surface.thicknessMm < 0) throw new Error(`Negative axial thickness at surface ${surface.index + 1}; folded/reflected or overlapping layout unsupported`);
    zMm += surface.thicknessMm;
    before = after;
  }
  if (surfaces.at(-1).mediumAfter !== 'air') throw new Error('Final interface must exit to air before the sensor');
  const missing = surfaces.filter(s => s.apertureRadiusMm === null).map(s => s.index + 1);
  if (missing.length) warnings.push(`通光数据不完整：S${missing.join(', S')} 无已知物理半口径；sdDraw 仅用于保守求交边界，不作为挡光。`);
  if (Object.values(glasses).some(g => g.model)) warnings.push('含 nd/vd 模型玻璃；色散为上游 Conrady 近似。');
  warnings.push('380–780 nm 为本实现工作区间；上游目录表未提供各牌号有效波段，未据此声称厂商认证范围。');
  const last = surfaces.at(-1);
  const objectDistanceMm = configuration && Object.hasOwn(configuration, 'obj') ? configuration.obj : record.objd ?? null;
  if (objectDistanceMm !== null && !(Number.isFinite(objectDistanceMm) && objectDistanceMm > 0)) throw new Error(`Invalid object distance for ${record.id}`);
  return {
    schemaVersion: 1, id: record.id, name: record.name, configurationIndex,
    configurationTitle: configuration?.title ?? 'Default',
    configurations: configurations.map((c, index) => ({ index, title: c?.title ?? 'Default' })),
    surfaces, glasses, stopIndex, apertureMode, apertureValue, focusMotion,
    sensorZMm: zMm, imageDistanceMm: last.thicknessMm, lastVertexZMm: last.zMm,
    objectDistanceMm,
    sensorMm: [36, 24], wavelengthRangeNm: [380, 780],
    apertureDataComplete: missing.length === 0, missingApertureSurfaces: missing, warnings,
    metadata: { src: record.src, kind: record.kind, note: record.note ?? '', fieldMode: record.fmode, fieldExtent: record.fov, empiricalVignetting: configuration?.vig ?? null, vigCoord: record.vigCoord ?? null, vigH: record.vigH ?? null, empiricalVignettingApplied: false },
  };
}

/** List unsupported records instead of presenting parse success as optical support. */
export function inspectLensRecord(record, catalog) {
  const configurations = record.cfgs?.length ? record.cfgs : [null];
  const entries = configurations.map((cfg, configurationIndex) => {
    try {
      const lens = adaptLensRecord(record, catalog, { configurationIndex });
      return { index: configurationIndex, title: cfg?.title ?? 'Default', supported: true, warnings: lens.warnings, apertureDataComplete: lens.apertureDataComplete };
    } catch (error) { return { index: configurationIndex, title: cfg?.title ?? 'Default', supported: false, reason: error.message }; }
  });
  return { id: record.id, name: record.name, supported: entries.some(c => c.supported), configurations: entries, reason: entries.every(c => !c.supported) ? entries[0].reason : null };
}
