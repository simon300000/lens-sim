/**
 * Dispersion formula conventions and Conrady model adapted from lens-bench
 * js/optics.js, https://github.com/anvcor/lens-bench (GPL-3.0).
 * No upstream program is loaded or evaluated by the runtime.
 */
export const FRAUNHOFER_NM = Object.freeze({ d: 587.5618, F: 486.1327, C: 656.2725, g: 435.8343 });
export const AIR = Object.freeze({ id: 'air', name: 'Air', formula: 'air', coefficients: [], rangeNm: [380, 780] });
const key = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
const EXPONENTS = [0, 2, -2, -4, -6, -8, 4, -10, -12];

/** The public boundary is always nm; only this function converts to µm. */
export function refractiveIndex(glass, wavelengthNm) {
  if (!glass) throw new Error('Missing glass record');
  const [lo, hi] = glass.rangeNm ?? [380, 780];
  if (!Number.isFinite(wavelengthNm) || wavelengthNm < lo || wavelengthNm > hi) {
    throw new RangeError(`${glass.name ?? glass.id}: wavelength ${wavelengthNm} nm outside ${lo}–${hi} nm`);
  }
  if (glass.formula === 'air') return 1;
  const l = wavelengthNm / 1000;
  const l2 = l * l;
  const c = glass.coefficients;
  let n;
  if (glass.formula === 'L') {
    let n2 = 0;
    for (let i = 0; i < c.length; i++) n2 += c[i] * l ** (EXPONENTS[i] ?? -14);
    n = Math.sqrt(n2);
  } else if (glass.formula === 'M' || glass.formula === 'S') {
    let n2 = 1;
    for (let i = 0; i + 1 < c.length; i += 2) {
      const pole = glass.formula === 'S' ? c[i + 1] ** 2 : c[i + 1];
      n2 += c[i] * l2 / (l2 - pole);
    }
    n = Math.sqrt(n2);
  } else if (glass.formula === 'H') {
    const h = 1 / (l2 - 0.028);
    n = c[0] + c[1] * h + c[2] * h * h + c[3] * l2 + c[4] * l2 ** 2 + c[5] * l2 ** 3;
  } else if (glass.formula === 'conrady') {
    n = c[0] + c[1] / l + c[2] / l ** 3.5;
  } else if (glass.formula === 'offset') {
    // [new nd, scale, base nd], with the original curve retained explicitly.
    n = c[0] + c[1] * (refractiveIndex(glass.base, wavelengthNm) - c[2]);
  } else throw new Error(`Unsupported glass formula ${glass.formula}`);
  if (!Number.isFinite(n) || n < 1 || n > 5) throw new Error(`Invalid refractive index for ${glass.name ?? glass.id} at ${wavelengthNm} nm`);
  return n;
}

export function modelGlass(nd, vd, deltaPgF = 0, name = `${nd}/${vd}`) {
  if (!(nd > 1 && nd < 5) || !(vd > 0) || !Number.isFinite(deltaPgF)) throw new Error(`Invalid model glass ${name}`);
  const p = nm => 1000 / nm;
  const q = nm => (1000 / nm) ** 3.5;
  const { d, F, C, g } = FRAUNHOFER_NM;
  const b1 = (nd - 1) / vd;
  const b2 = (0.6438 - 0.001682 * vd + deltaPgF) * b1;
  const a11 = p(F) - p(C), a12 = q(F) - q(C), a21 = p(g) - p(F), a22 = q(g) - q(F);
  const det = a11 * a22 - a12 * a21;
  const a = (b1 * a22 - a12 * b2) / det, b = (a11 * b2 - b1 * a21) / det;
  return { id: `model:${name}`, name, formula: 'conrady', coefficients: [nd - a * p(d) - b * q(d), a, b], rangeNm: [380, 780], model: true, nd, vd, deltaPgF };
}

/** Parse only the raw static glass table extracted at build time. */
export function parseGlassCatalog(raw, { aliases = {}, models = {}, formulas = {} } = {}) {
  const records = {}, names = {}, catalogs = new Set();
  let catalog = '';
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('@')) { catalog = line.slice(1); catalogs.add(catalog); continue; }
    const [name, formula, coefficientText] = line.split('|');
    if (!name || !'LMSH'.includes(formula) || !coefficientText || !catalog) throw new Error(`Invalid catalog line: ${line.slice(0, 100)}`);
    const coefficients = coefficientText.split(',').map(Number);
    if (!coefficients.every(Number.isFinite)) throw new Error(`Non-numeric coefficients for ${name}`);
    const id = `${key(name)}_${key(catalog)}`;
    const record = { id, name, catalog, formula, coefficients, rangeNm: [380, 780], rangeSource: 'lens-sim visible working interval; upstream table supplies no validity bounds' };
    records[id] = record;
    names[key(name)] ??= id; // Retain upstream first-catalog priority.
  }
  return { schemaVersion: 1, records, names, aliases, models, formulas, catalogs: [...catalogs] };
}

/** Exact identities and declared aliases only. Unknown names never become air. */
export function resolveGlass(token, catalog) {
  const name = String(token).trim();
  if (!name || name === '-' || /^air$/i.test(name)) return AIR;
  if (name.includes('~')) {
    const parts = name.split('~');
    if (parts.length !== 3 || !parts.slice(1).every(x => x.trim() && Number.isFinite(Number(x)))) throw new Error(`Invalid glass offset ${name}`);
    const base = resolveGlass(parts[0], catalog), dn = Number(parts[1]), dv = Number(parts[2]);
    if (base.formula === 'air') throw new Error(`Air cannot have glass offset: ${name}`);
    const nd = refractiveIndex(base, FRAUNHOFER_NM.d);
    const vd = (nd - 1) / (refractiveIndex(base, FRAUNHOFER_NM.F) - refractiveIndex(base, FRAUNHOFER_NM.C));
    const newNd = nd + dn, newVd = vd + dv;
    if (!(newNd > 1 && newVd > 0)) throw new Error(`Invalid glass offset ${name}`);
    return { id: `offset:${name}`, name, formula: 'offset', coefficients: [newNd, ((newNd - 1) / newVd) / ((nd - 1) / vd), nd], base, rangeNm: [...base.rangeNm] };
  }
  if (name.includes('/')) {
    const parts = name.split('/');
    if (parts.length < 2 || parts.length > 3 || !parts.every(x => x.trim() && Number.isFinite(Number(x)))) throw new Error(`Invalid model glass ${name}`);
    return modelGlass(Number(parts[0]), Number(parts[1]), Number(parts[2] ?? 0), name);
  }
  const mil = name.replace(/[.\s]/g, '');
  if (/^\d{6}$/.test(mil)) return modelGlass(1 + Number(mil.slice(0, 3)) / 1000, Number(mil.slice(3)) / 10, 0, `MIL ${mil}`);
  const suffixMatch = /^(.*)_([^_]+)$/.exec(name);
  let id;
  const explicitCatalog = suffixMatch && catalog.catalogs.find(c => key(c) === key(suffixMatch[2]));
  if (explicitCatalog) {
    const cat = explicitCatalog;
    id = `${key(suffixMatch[1])}_${key(cat)}`;
    if (!catalog.records[id]) throw new Error(`Glass ${suffixMatch[1]} absent from explicit catalog ${cat}`);
  } else {
    const normalized = key(name);
    id = catalog.names[normalized] ?? catalog.names[catalog.aliases[normalized]];
    // Upstream supports concatenated NAMECATALOG as well as NAME_CATALOG.
    if (!id) for (const cat of catalog.catalogs) {
      const suffix = key(cat);
      if (normalized.endsWith(suffix)) {
        const candidate = `${normalized.slice(0, -suffix.length)}_${suffix}`;
        if (catalog.records[candidate]) { id = candidate; break; }
      }
    }
    if (!id && catalog.formulas[normalized]) return { ...catalog.formulas[normalized], id: `formula:${normalized}`, rangeNm: [380, 780] };
    if (!id && catalog.models[normalized]) {
      const [nd, vd, maker] = catalog.models[normalized];
      return { ...modelGlass(nd, vd, 0, name), catalog: maker ?? null, approximation: 'upstream explicitly supplied nd/vd model; not a catalog dispersion curve' };
    }
  }
  if (!id) throw new Error(`Unknown glass ${name}; no substitution is permitted`);
  return catalog.records[id];
}

/** Upload only current prescription media. 0.25 nm default reduces blue-end dispersion error. */
export function createGlassLUT(glasses, { minNm = 380, maxNm = 780, stepNm = .25 } = {}) {
  if (!(minNm < maxNm && stepNm > 0)) throw new Error('Invalid glass LUT range');
  const records = Array.isArray(glasses) ? glasses : Object.values(glasses);
  const count = Math.ceil((maxNm - minNm) / stepNm) + 1;
  const values = new Float32Array(records.length * count);
  for (let j = 0; j < records.length; j++) for (let i = 0; i < count; i++) values[j * count + i] = refractiveIndex(records[j], Math.min(maxNm, minNm + i * stepNm));
  return { values, ids: records.map(g => g.id), minNm, maxNm, stepNm, count };
}

export function lookupGlassLUT(lut, glassIndex, wavelengthNm) {
  if (wavelengthNm < lut.minNm || wavelengthNm > lut.maxNm) throw new RangeError('Wavelength outside glass LUT');
  const u = (wavelengthNm - lut.minNm) / lut.stepNm, i = Math.min(lut.count - 2, Math.floor(u)), f = u - i;
  const offset = glassIndex * lut.count + i;
  return lut.values[offset] * (1 - f) + lut.values[offset + 1] * f;
}
