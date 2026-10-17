import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadUpstreamCatalog, extractStaticObject } from '../scripts/build-lens-data.mjs';
import { AIR, FRAUNHOFER_NM, refractiveIndex, resolveGlass, modelGlass, createGlassLUT, lookupGlassLUT } from '../src/optics/glass.js';
import { parsePrescriptionText, adaptLensRecord, inspectLensRecord } from '../src/optics/prescription.js';
import { intersectSurface } from '../src/optics/optical-reference.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'vendor/lens-bench');
const catalog = await loadUpstreamCatalog(vendor);
const readRecord = async id => JSON.parse(await fs.readFile(path.join(vendor, `data/lenses/${id}.json`), 'utf8'));
const fixture = overrides => ({ id: 'test', name: 'Test', tx: '50 3 N-BK7 10\n-50 40 - 10', stop: 1, fno: 4, apmode: 'fno', warn: [], ...overrides });
const close = (a, b, tolerance, message = '') => assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b} (tol ${tolerance})`);

test('missing submodule produces an actionable error', async () => {
  await assert.rejects(loadUpstreamCatalog(path.join(root, 'vendor/not-initialized')), /git submodule update --init --recursive/);
});

test('static extractor rejects executable expressions without eval', () => {
  assert.deepEqual(extractStaticObject("var DATA = { a: ['x', 2], b: -1e-3 };", 'DATA'), { a: ['x', 2], b: -0.001 });
  assert.throws(() => extractStaticObject('var DATA = {a: process.exit()};', 'DATA'));
});

test('glass catalog priority, explicit suffixes, real underscores, aliases and strict unknowns', () => {
  assert.equal(resolveGlass('-', catalog), AIR);
  assert.equal(resolveGlass('air', catalog), AIR);
  assert.equal(refractiveIndex(AIR, 532), 1);
  assert.equal(resolveGlass('N-BK7_SCHOTT', catalog).catalog, 'SCHOTT');
  assert.equal(resolveGlass('LAF2_HOYA', catalog).catalog, 'HOYA');
  assert.notEqual(resolveGlass('LAF2_HOYA', catalog).id, resolveGlass('LAF2_SCHOTT', catalog).id);
  assert.equal(resolveGlass('fusedsilica', catalog).id, resolveGlass('silica', catalog).id);
  assert.equal(resolveGlass('ZEONEX_E48R_2017', catalog).name, 'ZEONEX_E48R_2017');
  assert.throws(() => resolveGlass('N-BK7_BOGUS', catalog), /Unknown glass/);
  assert.throws(() => resolveGlass('this-glass-does-not-exist', catalog), /Unknown glass/);
  assert.throws(() => resolveGlass('N-BK7_HOYA', catalog), /absent from explicit catalog/);
});

test('M and S Sellmeier poles are different, Laurent and Herzberger retain conventions', () => {
  const c = [1, 0.1];
  const m = { name: 'M', formula: 'M', coefficients: c, rangeNm: [380, 780] };
  const s = { name: 'S', formula: 'S', coefficients: c, rangeNm: [380, 780] };
  close(refractiveIndex(m, 500), Math.sqrt(1 + 0.25 / 0.15), 1e-14);
  close(refractiveIndex(s, 500), Math.sqrt(1 + 0.25 / 0.24), 1e-14);
  const l = { formula: 'L', coefficients: [2, 0.01, 0.02, 0, 0, 0, 0.003], rangeNm: [380, 780] };
  close(refractiveIndex(l, 500), Math.sqrt(2 + 0.01 * .25 + .02 / .25 + .003 * .25 ** 2), 1e-14);
  const h = { formula: 'H', coefficients: [1.5, .001, .0001, .002, .003, .004], rangeNm: [380, 780] };
  const L = 1 / (.25 - .028);
  close(refractiveIndex(h, 500), 1.5 + .001 * L + .0001 * L * L + .002 * .25 + .003 * .25 ** 2 + .004 * .25 ** 3, 1e-14);
  assert.throws(() => refractiveIndex(m, 379), /outside/);
});

test('Conrady model/MIL and offset solutions preserve nd, vd and nm boundary', () => {
  const g = modelGlass(1.5168, 64.17, .003);
  const { d, F, C, g: gLine } = FRAUNHOFER_NM;
  close(refractiveIndex(g, d), 1.5168, 1e-14);
  close((refractiveIndex(g, d) - 1) / (refractiveIndex(g, F) - refractiveIndex(g, C)), 64.17, 2e-10);
  close((refractiveIndex(g, gLine) - refractiveIndex(g, F)) / (refractiveIndex(g, F) - refractiveIndex(g, C)), .6438 - .001682 * 64.17 + .003, 1e-12);
  close(refractiveIndex(resolveGlass('517640', catalog), d), 1.517, 1e-14);
  const base = resolveGlass('N-BK7', catalog), shifted = resolveGlass('N-BK7~0.001~-1', catalog);
  close(refractiveIndex(shifted, d), refractiveIndex(base, d) + .001, 1e-14);
  const vd = (refractiveIndex(base, d) - 1) / (refractiveIndex(base, F) - refractiveIndex(base, C));
  close((refractiveIndex(shifted, d) - 1) / (refractiveIndex(shifted, F) - refractiveIndex(shifted, C)), vd - 1, 2e-10);
  assert.throws(() => resolveGlass('1.5/0', catalog), /Invalid model/);
});

test('dispersion agrees with pinned upstream formulas, only in the CPU test reference', async () => {
  // This execution is isolated to tests; production reads only static converted data.
  const context = vm.createContext({});
  const raw = await fs.readFile(path.join(vendor, 'js/glassdb.js'), 'utf8');
  const source = await fs.readFile(path.join(vendor, 'js/optics.js'), 'utf8');
  vm.runInContext(raw + '\n' + source, context, { timeout: 5000 });
  const selected = ['N-BK7', 'LAF2_HOYA', 'F2_SCHOTT', 'S-LAH79', '1.7292/54.7', 'N-BK7~.001~-1', 'ZEONEX_E48R_2017'];
  for (const name of selected) {
    const own = resolveGlass(name, catalog), reference = context.OPT.parseMaterial(name);
    assert.ok(reference.fn && !reference.err, name);
    for (let nm = 380; nm <= 780; nm += 17) close(refractiveIndex(own, nm), reference.fn(nm / 1000), 2e-13, `${name}@${nm}`);
  }
});

test('tx units, radius signs, conics and A4/A6 order; physical aperture differs from drawing', () => {
  const p = parsePrescriptionText('# header\n50 3 N-BK7 10 -1 1e-6 -2e-9\ninf 40 - -');
  assert.deepEqual(p[0].aspheric, [1e-6, -2e-9]);
  assert.equal(p[0].conic, -1);
  assert.equal(p[1].radiusMm, 0);
  const lens = adaptLensRecord(fixture({ sdDraw: [100, 200], sdAp: [8, 9] }), catalog);
  assert.equal(lens.surfaces[0].apertureRadiusMm, 10);
  assert.equal(lens.surfaces[0].drawRadiusMm, 100);
  assert.equal(lens.surfaces[0].apertureSource, 'tx-explicit');
  assert.equal(lens.surfaces[1].radiusMm, -50);
  assert.equal(lens.surfaces[0].zMm, 0);
  assert.equal(lens.surfaces[1].zMm, 3);
  assert.equal(lens.sensorZMm, 43);
  assert.equal(lens.imageDistanceMm, 40); // final T is image distance, no extra interface
  assert.equal(lens.surfaces.length, 2);
  assert.equal(lens.surfaces[0].mediumBefore, 'air');
  assert.equal(lens.surfaces[1].mediumBefore, lens.surfaces[0].mediumAfter);
  assert.equal(lens.surfaces[1].mediumAfter, 'air');
});

test('one-based stop and zero-based cfg thickness/radius overrides apply before z positions', () => {
  const lens = adaptLensRecord(fixture({ stop: 2, cfgs: [{ title: 'near', thi: { 0: 5, 1: 41 }, rdy: { 0: 60 }, fno: 5.6, obj: 1500, vig: { vuy: [.1] } }] }), catalog);
  assert.equal(lens.stopIndex, 1);
  assert.equal(lens.apertureValue, 5.6);
  assert.equal(lens.surfaces[0].radiusMm, 60);
  assert.equal(lens.surfaces[1].zMm, 5);
  assert.equal(lens.sensorZMm, 46);
  assert.equal(lens.objectDistanceMm, 1500);
  assert.equal(lens.metadata.empiricalVignettingApplied, false);
  assert.deepEqual(lens.metadata.empiricalVignetting, { vuy: [.1] });
  assert.throws(() => adaptLensRecord(fixture({ stop: 0 }), catalog), /1-based stop/);
  assert.throws(() => adaptLensRecord(fixture({ cfgs: [{ thi: { 99: 5 } }] }), catalog), /outside prescription/);
  const infinityConfig = adaptLensRecord(fixture({ objd: 2000, cfgs: [{ obj: null }] }), catalog);
  assert.equal(infinityConfig.objectDistanceMm, null);
});

test('missing clear aperture falls back to drawing radius with approximation provenance', () => {
  const lens = adaptLensRecord(fixture({ tx: '50 3 N-BK7 -\n-50 40 - -', sdDraw: [10, 10], sdAp: [null, 9] }), catalog);
  assert.equal(lens.surfaces[0].apertureRadiusMm, 10);
  assert.equal(lens.surfaces[0].apertureSource, 'sdDraw-approximation');
  assert.equal(lens.surfaces[1].apertureRadiusMm, 9);
  assert.equal(lens.surfaces[1].apertureSource, 'sdAp-explicit');
  assert.equal(lens.apertureDataComplete, false);
  assert.deepEqual(lens.approximatedApertureSurfaces, [1]);
  assert.deepEqual(lens.missingApertureSurfaces, [1]);
  assert.ok(lens.warnings.some(w => w.includes('已使用绘图半径')));
  assert.equal(intersectSurface(lens.surfaces[0], [9.5, 0, -5], [0, 0, 1]).status, 0);
  assert.equal(intersectSurface(lens.surfaces[0], [10.5, 0, -5], [0, 0, 1]).status, 1);
  // The second surface keeps its explicit 9 mm aperture despite sdDraw=10.
  assert.equal(intersectSurface(lens.surfaces[1], [9.5, 0, -5], [0, 0, 1]).status, 1);
});

test('missing or invalid drawing radii remain unknown without inventing an aperture', () => {
  for (const sdDraw of [undefined, [0, -1], [null, null]]) {
    const lens = adaptLensRecord(fixture({ tx: '50 3 N-BK7 -\n-50 40 - -', sdDraw }), catalog);
    assert.ok(lens.surfaces.every(s => s.apertureRadiusMm === null && s.apertureSource === 'unknown'));
    assert.deepEqual(lens.approximatedApertureSurfaces, []);
    assert.ok(lens.warnings.some(w => w.includes('无真实通光半径及有效绘图半径')));
  }
});

test('Legacy ODD, unknown glasses and invalid configurations remain unavailable', () => {
  for (const token of ['ODD .01']) {
    const row = fixture({ tx: `50 3 N-BK7 10 0 ${token}\n-50 40 - 10` });
    const entry = inspectLensRecord(row, catalog);
    assert.equal(entry.supported, false);
    assert.match(entry.reason, /Unsupported surface/);
  }
  assert.equal(inspectLensRecord(fixture({ tx: '50 3 FAKE 10\n-50 40 - 10' }), catalog).supported, false);
  assert.equal(inspectLensRecord(fixture({ tx: '50 -3 N-BK7 10\n-50 40 - 10' }), catalog).supported, false);
  assert.throws(() => adaptLensRecord(fixture(), catalog, { configurationIndex: 1 }), /Invalid configuration/);
});

test('23-interface upstream reference has complete aperture data and its current-media LUT is accurate', async () => {
  const lens = adaptLensRecord(await readRecord('zemax-55'), catalog);
  assert.equal(lens.apertureDataComplete, true);
  assert.equal(lens.surfaces.length, 23);
  assert.equal(lens.stopIndex, 9);
  assert.equal(lens.sensorZMm, 69);
  const lut = createGlassLUT(lens.glasses);
  assert.equal(lut.ids.length, Object.keys(lens.glasses).length);
  let maxError = 0;
  for (const [j, glass] of Object.values(lens.glasses).entries()) for (let nm = 380.125; nm < 780; nm += .5) maxError = Math.max(maxError, Math.abs(lookupGlassLUT(lut, j, nm) - refractiveIndex(glass, nm)));
  assert.ok(maxError < 3e-7, `0.25 nm f32 LUT error ${maxError}`);
  console.log(`default-lens glass LUT maximum |Δn| = ${maxError}`);
});

test('every supported library configuration has explicit finite geometry and valid glass formula', async () => {
  const files = (await fs.readdir(path.join(vendor, 'data/lenses'))).filter(f => f.endsWith('.json'));
  let supported = 0, unsupported = 0;
  for (const file of files) {
    const record = JSON.parse(await fs.readFile(path.join(vendor, 'data/lenses', file), 'utf8'));
    for (const status of inspectLensRecord(record, catalog).configurations) {
      if (!status.supported) { unsupported++; assert.ok(status.reason); continue; }
      supported++;
      const lens = adaptLensRecord(record, catalog, { configurationIndex: status.index });
      assert.ok(lens.surfaces.every(s => Number.isFinite(s.zMm + s.radiusMm + s.conic + s.thicknessMm)));
      for (const g of Object.values(lens.glasses)) assert.ok(refractiveIndex(g, 550) >= 1);
    }
  }
  assert.ok(supported > 1000);
  assert.ok(unsupported > 0);
  console.log(`lens-bench configuration parser coverage: ${supported} supported, ${unsupported} explicitly unavailable`);
});
