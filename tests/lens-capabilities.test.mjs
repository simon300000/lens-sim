import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { loadUpstreamCatalog } from '../scripts/build-lens-data.mjs';
import { adaptLensRecord, inspectLensRecord } from '../src/optics/prescription.js';
import { preflightLens } from '../src/optics/capabilities.js';
import { packLens } from '../src/optics/lens-state.js';

const catalog = await loadUpstreamCatalog();
const read = async id => JSON.parse(await fs.readFile(new URL(`../vendor/lens-bench/data/lenses/${id}.json`, import.meta.url), 'utf8'));
const canonical = () => adaptLensRecord({ id: 'test', name: 'Test', tx: '50 3 N-BK7 10\n-50 40 - 10', stop: 1, fno: 4, apmode: 'fno', warn: [] }, catalog);

test('preflight uses the real packLens scalar setup, without claiming GPU validation', async () => {
  const lens = adaptLensRecord(await read('canon-fl-50mm-f1-8'), catalog);
  const result = preflightLens(lens);
  assert.equal(result.supported, true, result.reason);
  assert.equal(result.parserSupported, true);
  assert.equal(result.gpuValidated, false);
  assert.equal(result.validation, 'static-preflight-only');
  const packed = packLens(lens, { fNumber: result.initial.fNumber, sensorZMm: result.initial.sensorZMm });
  assert.equal(result.initial.samplingRadiusMm, packed.region.radiusMm);
  assert.equal(result.initial.samplingAreaPdf, packed.region.areaPdf);
  assert.equal(result.initial.stopRadiusMm, packed.stopRadiusMm);
  assert.equal(result.initial.imageDistanceMm, packed.sensorZMm - lens.lastVertexZMm);
  assert.equal(result.initialFocusDistanceM, null);
  assert.equal(result.initialSensorZMm, lens.sensorZMm);
  assert.equal(result.initialization, 'native-prescribed-image-plane');
  assert.ok(result.warnings.some(w => w.includes('尚不代表逐镜头 GPU')));
});

test('high-order coefficients are normalized before f32 range checks; no silent term dropping', () => {
  const lens = canonical(), surface = lens.surfaces[0];
  surface.type = 'even-asphere';
  surface.aspheric = Array(11).fill(0).concat(1e-45); // A26: raw f32 underflow, normalized B26 representable.
  assert.equal(preflightLens(lens).supported, true);
  surface.aspheric[11] = 1e-100;
  const rejected = preflightLens(lens);
  assert.equal(rejected.supported, false);
  assert.match(rejected.reason, /A26.*f32/);
  surface.aspheric = Array(13).fill(0);
  assert.match(preflightLens(lens).reason, /A4 至 A26/);
});

test('static packing rejects f32 overflow, subnormal geometry and lost axial gaps', () => {
  const huge = canonical(); huge.surfaces[0].radiusMm = 1e40;
  assert.match(preflightLens(huge).reason, /f32/);
  const tiny = canonical(); tiny.surfaces[0].radiusMm = 1e-45;
  assert.match(preflightLens(tiny).reason, /f32/);
  const collapsed = canonical(); collapsed.surfaces[0].zMm = 1e8; collapsed.surfaces[1].zMm = 1e8 + 1;
  assert.match(preflightLens(collapsed).reason, /间距.*消失/);
});

test('native finite configurations retain prescribed image plane; explicit unavailable 20 m overrides reject', async () => {
  const overlap = canonical();
  // A very large rear sag intersects the positive but nearby paraxial sensor.
  overlap.surfaces[1].radiusMm = 12;
  overlap.surfaces[1].conic = -1;
  overlap.surfaces[1].apertureRadiusMm = 200;
  const invalid = preflightLens(overlap);
  assert.equal(invalid.supported, false);
  assert.ok(invalid.reason);
  const record = await read('7artisans-af-135mm-f1-8-max');
  assert.equal(inspectLensRecord(record, catalog).configurations[1].supported, true);
  const finiteLens = adaptLensRecord(record, catalog, { configurationIndex: 1 });
  const native = preflightLens(finiteLens);
  assert.equal(native.supported, true, native.reason);
  assert.equal(native.initialFocusDistanceM, finiteLens.objectDistanceMm / 1000);
  assert.equal(native.initialSensorZMm, finiteLens.sensorZMm);
  assert.ok(Math.abs(native.initial.imageDistanceMm - 1) < 1e-10);
  const capability = preflightLens(finiteLens, { focusDistanceM: 20 });
  assert.equal(capability.supported, false);
  assert.match(capability.reason, /像方焦点/);
});

test('missing physical aperture remains a warning, not fictitious clipping or universal rejection', () => {
  const lens = canonical();
  lens.surfaces[0].apertureRadiusMm = null;
  lens.surfaces[0].drawRadiusMm = 30;
  lens.apertureDataComplete = false;
  const result = preflightLens(lens);
  assert.equal(result.supported, true, result.reason);
  assert.equal(lens.surfaces[0].apertureRadiusMm, null);
  assert.ok(result.warnings.some(w => w.includes('不是已知物理通光范围')));
});

test('capture guard-band limits are warnings and never optical blockage', () => {
  const result = preflightLens(canonical(), { captureMaxHorizontalFovDeg: 30 });
  assert.equal(result.supported, true);
  assert.equal(result.capture.limited, true);
  assert.ok(result.warnings.some(w => w.includes('SCENE_CACHE_MISS') && w.includes('不能解释为镜头黑角')));
});

test('declared image height and untouched upstream warning/vignette metadata are distinct', () => {
  const lens = canonical();
  lens.metadata = { fieldMode: 'height', fieldExtent: 10, empiricalVignetting: { vuy: [.1] }, empiricalVignettingApplied: false };
  lens.warnings = ['原始上游警告'];
  const before = JSON.stringify(lens);
  const result = preflightLens(lens);
  assert.ok(result.warnings.some(w => w.includes('最大像高 10 mm')));
  assert.equal(JSON.stringify(lens), before);
  lens.metadata.fieldMode = 'angle';
  assert.equal(preflightLens(lens).warnings.some(w => w.includes('最大像高')), false);
});

test('unsupported types and invalid media cannot pass capability check even if a caller bypasses parser', () => {
  const lens = canonical();
  lens.surfaces[0].type = 'DOE';
  assert.match(preflightLens(lens).reason, /未支持的面型 DOE/);
  lens.surfaces[0].type = 'sphere';
  lens.surfaces[0].mediumBefore = 'unknown';
  assert.match(preflightLens(lens).reason, /介质引用无效/);
});

test('library capability count distinguishes parser acceptance from supported initial GPU setup', async () => {
  const directory = new URL('../vendor/lens-bench/data/lenses/', import.meta.url);
  let parserAccepted = 0, preflightAccepted = 0, rejected = 0, limited = 0;
  for (const file of (await fs.readdir(directory)).filter(f => f.endsWith('.json'))) {
    const record = JSON.parse(await fs.readFile(new URL(file, directory), 'utf8'));
    for (const status of inspectLensRecord(record, catalog).configurations) {
      if (!status.supported) continue;
      parserAccepted++;
      const result = preflightLens(adaptLensRecord(record, catalog, { configurationIndex: status.index }));
      assert.equal(result.gpuValidated, false);
      if (result.supported) { preflightAccepted++; if (result.capture.limited) limited++; }
      else { rejected++; assert.ok(result.reason); }
    }
  }
  assert.equal(parserAccepted, 1845);
  assert.equal(preflightAccepted, 1820);
  assert.equal(rejected, 25);
  assert.equal(limited, 229);
  console.log(`Pinned library: ${parserAccepted} parsed, ${preflightAccepted} static-preflight accepted, ${rejected} initial-setup unavailable, ${limited} capture-limited warnings; not GPU image validation.`);
});
