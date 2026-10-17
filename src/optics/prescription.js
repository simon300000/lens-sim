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
    const doeIndex=tokens.findIndex((token,index)=>index>=cursor&&/^DOE$/i.test(token));
    let doe=null;
    if(doeIndex>=0){
      const tail=tokens.splice(doeIndex);
      if(tail.length<4)throw new Error(`DOE requires order, positive normalization radius and phase coefficients at line ${lineIndex+1}`);
      const order=number(tail[1], 'DOE order'), normalizationRadiusMm=number(tail[2], 'DOE radius');
      if(!Number.isInteger(order)||!(normalizationRadiusMm>0))throw new Error(`Invalid DOE order/radius at line ${lineIndex+1}`);
      const coefficients=tail.slice(3).map(x=>number(x,`DOE phase coefficient line ${lineIndex+1}`));
      while(coefficients.length&&coefficients.at(-1)===0)coefficients.pop();
      if(coefficients.length>12)throw new Error(`DOE above 12 phase terms is unsupported at line ${lineIndex+1}`);
      doe={order,normalizationRadiusMm,coefficients};
    }
    const unsupported = tokens.slice(cursor).find(x => /^ODD$/i.test(x));
    if (unsupported) throw new Error(`Unsupported surface ${unsupported.toUpperCase()} at line ${lineIndex + 1}; no spherical substitution`);
    let aspheric=[],xodd=null;
    if (/^XODD$/i.test(tokens[cursor]??'')) {
      const normalizationRadiusMm=number(tokens[++cursor], `XODD normalization radius line ${lineIndex+1}`);
      if (!(normalizationRadiusMm>0 && Number.isFinite(normalizationRadiusMm))) throw new Error(`XODD requires positive finite normalization radius at line ${lineIndex+1}`);
      const coefficients=tokens.slice(++cursor).map(x=>number(x, `XODD coefficient line ${lineIndex+1}`));
      if (!coefficients.length || coefficients.length>28) throw new Error(`XODD requires A1 through at most A28 at line ${lineIndex+1}`);
      // Keep all source coefficients, including zero tails: no lost terms.
      xodd={normalizationRadiusMm,coefficients};
    } else {
      aspheric=tokens.slice(cursor).map(x=>number(x, `Aspheric coefficient line ${lineIndex+1}`));
      while(aspheric.length && aspheric.at(-1)===0)aspheric.pop();
      if(aspheric.length>12)throw new Error(`Even asphere above A26 is unsupported at line ${lineIndex+1}`);
    }
    surfaces.push({index:surfaces.length,radiusMm,thicknessMm,material,apertureRadiusMm,conic,aspheric,doe,...(xodd?{xodd}:{})});
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
    // Missing physical aperture: use the drawing radius as a geometric
    // approximation, retaining its provenance for UI/data warnings.
    if (surface.apertureRadiusMm === null && surface.drawRadiusMm !== null) {
      surface.apertureRadiusMm = surface.drawRadiusMm;
      surface.apertureSource = 'sdDraw-approximation';
    }
    surface.type = surface.doe ? 'diffractive' : surface.xodd ? 'extended-odd-asphere' : surface.aspheric.length ? 'even-asphere' : surface.conic !== 0 ? 'conic' : surface.radiusMm === 0 ? 'plane' : 'sphere';
    if (surface.thicknessMm < 0) throw new Error(`Negative axial thickness at surface ${surface.index + 1}; folded/reflected or overlapping layout unsupported`);
    zMm += surface.thicknessMm;
    before = after;
  }
  if (surfaces.at(-1).mediumAfter !== 'air') throw new Error('Final interface must exit to air before the sensor');
  const approximated = surfaces.filter(s => s.apertureSource === 'sdDraw-approximation').map(s => s.index + 1);
  const unknown = surfaces.filter(s => s.apertureRadiusMm === null).map(s => s.index + 1);
  const missing = surfaces.filter(s => s.apertureSource === 'unknown' || s.apertureSource === 'sdDraw-approximation').map(s => s.index + 1);
  if (approximated.length) warnings.push(`通光半径近似：S${approximated.join(', S')} 缺少真实通光半径，已使用绘图半径 sdDraw 作为挡光边界；该值不是已知物理通光数据。`);
  if (unknown.length) warnings.push(`通光数据不完整：S${unknown.join(', S')} 无真实通光半径及有效绘图半径，仍采用数值求交域。`);
  if (Object.values(glasses).some(g => g.model)) warnings.push('含 nd/vd 模型玻璃；色散为上游 Conrady 近似。');
  if(surfaces.some(s=>s.xodd))warnings.push('含 XODD 扩展奇次非球面：按原始 Rn 与 A1…AN 计算全部整数次幂；A1 非零的轴心无唯一法线。');
  warnings.push('380–780 nm 为本实现工作区间；上游目录表未提供各牌号有效波段，未据此声称厂商认证范围。');
  if(surfaces.some(s=>s.doe))warnings.push('DOE 按指定级次的相位梯度进行几何追迹；源数据未提供衍射效率、其他级次能量或相干干涉模型。');
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
    focusWavelengths:(record.wl??[]).map(w=>({nm:Number(w[0]),weight:Number(w[1])})),focusPrimaryIndex:record.pri??0,
    sensorMm: [36, 24], wavelengthRangeNm: [380, 780],
    apertureDataComplete: missing.length === 0, missingApertureSurfaces: missing, approximatedApertureSurfaces: approximated, warnings,
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
