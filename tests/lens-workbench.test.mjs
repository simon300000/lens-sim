import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  importLensFile, inspectRecord, recordToDraft, draftToRecord, insertSurface, deleteSurface, validateCell, rowType, textToRows,
  customLensId, isCustomLensId,
} from '../src/optics/lens-workbench.js';
import { computeLensLayout, traceMeridional } from '../src/ui/lens-layout.js';
import { apertureLimits } from '../src/optics/lens-state.js';
import { acesFilmic, encodeSRGB, mapRows } from '../src/rendering/image-export.js';

const catalog = JSON.parse(await readFile(new URL('../public/lenses/glass-catalog.json', import.meta.url), 'utf8'));
const canon = JSON.parse(await readFile(new URL('../public/lenses/canon-fl-50mm-f1-8.json', import.meta.url), 'utf8'));
const fixture = (name) => readFile(new URL(`./fixtures/import/${name}`, import.meta.url));

test('bundled assets keep the upstream record, and the browser preflight reproduces the build', () => {
  assert.ok(canon.record?.tx, 'record retained for editing');
  const asset = inspectRecord(canon.record, catalog);
  assert.deepEqual(asset.configurationStatus.map((c) => c.supported), canon.configurationStatus.map((c) => c.supported));
  const a = asset.configurations[0], b = canon.configurations[0];
  assert.deepEqual(a.surfaces.map((s) => [s.radiusMm, s.thicknessMm, s.mediumAfter]), b.surfaces.map((s) => [s.radiusMm, s.thicknessMm, s.mediumAfter]));
});

test('imports CODE V .seq: surfaces, glass, clear apertures, stop and aperture mode', async () => {
  const record = importLensFile(await fixture('cooke-triplet.seq'), 'cooke-triplet.seq', catalog);
  const rows = textToRows(record.tx);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((r) => r.mat), ['N-SK16', '', 'N-SF2', '', 'N-SK16', '']);
  assert.deepEqual(rows.map((r) => Number(r.sd)), [7, 7, 5, 5, 6, 6]);
  assert.equal(record.stop, 3);
  assert.equal(record.apmode, 'fno');
  const asset = inspectRecord(record, catalog);
  assert.ok(asset.configurationStatus[0].supported, asset.configurationStatus[0].reason);
  assert.ok(Math.abs(asset.configurations[0].capability.initial.focalLengthMm - 53.55) < 0.05);
});

test('imports Zemax .zmx: even asphere, conic, entrance-pupil aperture', async () => {
  const record = importLensFile(await fixture('singlet-asphere.zmx'), 'singlet-asphere.zmx', catalog);
  const rows = textToRows(record.tx);
  assert.equal(rows[1].mat, 'N-BK7');
  assert.equal(Number(rows[1].k), -0.6);
  assert.equal(Number(rows[1].asph), -1e-5);
  assert.equal(rowType(rows[1]), '非球面');
  assert.equal(record.apmode, 'epd');
  assert.equal(record.stop, 1);
  assert.ok(inspectRecord(record, catalog).configurationStatus[0].supported);
});

test('draft round-trips; configuration-specific cells write back to that configuration', () => {
  const record = canon.record;
  assert.equal(draftToRecord(record, recordToDraft(record, 0)).tx, record.tx);
  const index = record.cfgs.findIndex((c) => c?.thi && Object.keys(c.thi).length);
  assert.ok(index >= 0, 'Canon FL has focus configurations');
  const draft = recordToDraft(record, index);
  const surface = draft.overridden.T[0];
  draft.rows[surface].T = '9.876';
  const edited = draftToRecord(record, draft);
  assert.equal(edited.cfgs[index].thi[surface], 9.876, 'override edited');
  assert.equal(textToRows(edited.tx)[surface].T, textToRows(record.tx)[surface].T, 'base prescription untouched');
});

test('insert/delete keep stop, per-surface arrays and configuration keys aligned', () => {
  const record = canon.record, draft = recordToDraft(record, 0);
  const stop = draft.stopIndex;
  const inserted = insertSurface(record, draft, 0);
  assert.equal(inserted.draft.rows.length, draft.rows.length + 1);
  assert.equal(inserted.draft.stopIndex, stop + 1);
  assert.equal(inserted.record.stop, record.stop + 1);
  const key = Object.keys(record.cfgs.find((c) => c?.thi && Object.keys(c.thi).length).thi)[0];
  assert.ok(Object.hasOwn(inserted.record.cfgs.find((c) => c?.thi && Object.keys(c.thi).length).thi, String(Number(key) + 1)));
  const removed = deleteSurface(inserted.record, inserted.draft, 0);
  assert.equal(draftToRecord(removed.record, removed.draft).tx, record.tx);
  assert.throws(() => deleteSurface(record, draft, stop), /光阑/);
});

test('cell validation and custom ids', () => {
  assert.equal(validateCell('R', 'inf'), '');
  assert.ok(validateCell('R', 'abc'));
  assert.ok(validateCell('T', '-1'));
  assert.equal(validateCell('sd', ''), '');
  assert.equal(validateCell('asph', 'XODD 10 0 1e-3'), '');
  assert.ok(validateCell('asph', 'foo'));
  assert.equal(customLensId({ id: 'My Lens 50' }), 'custom:my-lens-50');
  assert.ok(isCustomLensId('custom:x') && !isCustomLensId('canon-fl-50mm-f1-8'));
});

test('layout: elements, stop-limited bundles and a chief ray through the stop centre', () => {
  const lens = canon.configurations[0], limits = apertureLimits(lens);
  const stopRadiusMm = Math.abs(limits.focalLengthMm * limits.pupilMagnification) / (2 * limits.minFNumber);
  const p = { ...lens, stopRadiusMm };
  const layout = computeLensLayout(p, { focalLengthMm: limits.focalLengthMm });
  assert.equal(layout.elements.length, lens.surfaces.filter((s) => s.mediumAfter !== 'air').length);
  assert.equal(layout.bundles.length, 3);
  const axial = layout.bundles[0];
  assert.equal(axial.rays.length, 3);
  assert.ok(Math.abs(axial.pupil[0] + 1) < 1e-3 && Math.abs(axial.pupil[1] - 1) < 1e-3, 'axial bundle fills the stop');
  for (const b of layout.bundles) for (const path of b.rays) assert.equal(path.at(-1)[0], lens.sensorZMm, 'rays end on the sensor');
  const edge = layout.bundles[2];
  assert.ok(Math.abs(edge.imageHeightMm) > 18 && Math.abs(edge.imageHeightMm) < 24, 'edge field reaches the frame corner');
  // A ray clipped by a smaller stop is rejected.
  const small = traceMeridional({ ...p }, [0, stopRadiusMm * 3, -10], [0, 0, 1], { stopRadiusMm: 0.5 });
  assert.equal(small, null);
});

test('export mapping matches the SDR display transform', () => {
  assert.deepEqual(acesFilmic(0, 0, 0).map((v) => Number(v.toFixed(4))), [0, 0, 0]);
  const mid = acesFilmic(0.18, 0.18, 0.18);
  assert.ok(mid.every((v) => v > 0.1 && v < 0.3) && Math.abs(mid[0] - mid[1]) < 1e-3, 'neutral stays neutral');
  assert.ok(acesFilmic(100, 100, 100).every((v) => v <= 1 && v > 0.95), 'highlights roll off to white');
  assert.equal(encodeSRGB(0), 0);
  assert.equal(encodeSRGB(1), 255);
  assert.equal(encodeSRGB(0.5), 188);
  // One half-float pixel: 1.0 (0x3C00) red, NaN green -> 0, raw mode clamps without tone mapping.
  const out = new Uint8ClampedArray(4);
  mapRows(new Uint16Array([0x3c00, 0x7e00, 0x0000, 0x3c00]), 4, 1, 1, out, 0, { raw: true });
  assert.deepEqual([...out], [255, 0, 0, 255]);
});
