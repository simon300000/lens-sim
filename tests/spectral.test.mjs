import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cieXYZ, spectralReconstruction, spectralRadiance, rgbToXYZ, xyzToRGB,
  CIE_Y_INTEGRAL, XYZ_NORMALIZATION, createSpectralReconstruction,
  sampleWavelength, spectralXYZContribution, SPECTRAL_WGSL,
} from '../src/spectral/reconstruction.js';
import { SAMPLE_DIMENSIONS, sampleDimension, concentricDisk, SAMPLING_WGSL } from '../src/spectral/sampler.js';

const near = (actual, expected, tolerance = 1e-6) => assert.ok(
  Math.abs(actual - expected) <= tolerance,
  `actual ${actual}, expected ${expected}, error ${Math.abs(actual - expected)}, tolerance ${tolerance}`,
);
const vectorNear = (a, b, tolerance) => a.forEach((x, i) => near(x, b[i], tolerance));

test('CMFs use nm and approximate the CIE 1931 2 degree observer, not RGB rainbow channels', () => {
  vectorNear(cieXYZ(555), [0.5169453266, 0.9979280263, 0.0056048484], 2e-10);
  const blue = cieXYZ(450), green = cieXYZ(540), red = cieXYZ(620);
  assert.ok(blue[2] > blue[0] && blue[0] > 0 && blue[1] > 0);
  assert.ok(green[1] > green[0] && green[2] > 0);
  assert.ok(red[0] > red[1] && red[1] > 0);
  vectorNear(cieXYZ(0.555), [0, 0, 0], 0);
  vectorNear(cieXYZ(800), [0, 0, 0], 0);
  near(CIE_Y_INTEGRAL, 106.94378939400583, 1e-10);
  near(CIE_Y_INTEGRAL * XYZ_NORMALIZATION, 1, 1e-14);
  for (let w = 380; w <= 780; w++) assert.ok(cieXYZ(w).every(x => Number.isFinite(x) && x >= 0));
  assert.throws(() => cieXYZ(NaN), /finite/);
});

test('authored primary spectra and all nonnegative RGB mixtures stay nonnegative', () => {
  for (const lobes of spectralReconstruction.primaries) assert.ok(lobes.every(l => l.weight >= 0 && l.sigma > 0));
  for (const rgb of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1], [80, 3, 400]]) {
    for (let w = 380; w <= 780; w++) assert.ok(spectralRadiance(rgb, w) >= 0);
  }
  assert.throws(() => spectralRadiance([-0.1, 1, 1], 555), /nonnegative/);
  assert.throws(() => spectralRadiance([Infinity, 1, 1], 555), /finite/);
});

test('spectral integration roundtrips white, saturated, mixed and HDR scene-linear colors', () => {
  for (const rgb of [[0, 0, 0], [1, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1],
    [0, 1, 1], [1, 0, 1], [1, 1, 0], [0.18, 0.18, 0.18], [10, 2, 0.5], [200, 20, 2]]) {
    const xyz = spectralReconstruction.integrateXYZ(rgb);
    vectorNear(xyz, rgbToXYZ(rgb), 3e-6);
    vectorNear(xyzToRGB(xyz), rgb, 4e-6);
  }
  // D65 chromaticity, NOT a claim that the reconstructed SPD is actual D65.
  const white = spectralReconstruction.integrateXYZ([1, 1, 1]);
  const sum = white.reduce((a, b) => a + b, 0);
  near(white[0] / sum, 0.3127266, 1e-6);
  near(white[1] / sum, 0.3290231, 1e-6);
});

test('HDR amplitude is linear, never clipped to [0,1] or auto-normalized per color', () => {
  for (let w = 380; w <= 780; w += 5) {
    near(spectralRadiance([100, 20, 2], w), 100 * spectralRadiance([1, 0.2, 0.02], w), 1e-12);
    near(spectralRadiance([1, 2, 3], w),
      spectralRadiance([1, 0, 0], w) + spectralRadiance([0, 2, 0], w) + spectralRadiance([0, 0, 3], w), 2e-15);
  }
});

test('explicit shorter glass support can be refitted and cannot silently extend beyond visible range', () => {
  const restricted = createSpectralReconstruction({ minNm: 400, maxNm: 700 });
  vectorNear(xyzToRGB(restricted.integrateXYZ([10, 3, 2])), [10, 3, 2], 3e-6);
  near(restricted.radiance([1, 1, 1], 390), 0, 0);
  assert.throws(() => createSpectralReconstruction({ minNm: 200, maxNm: 900 }), /visible interval/);
  assert.throws(() => createSpectralReconstruction({ minNm: 500, maxNm: 600 }), /visible interval/);
});

test('one continuous wavelength per attempt carries CIE XYZ/PDF contribution', () => {
  const rgb = [4, 2, 0.5];
  const samples = 16384;
  const sum = [0, 0, 0];
  for (let i = 0; i < samples; i++) {
    const u = sampleDimension(23, i, SAMPLE_DIMENSIONS.wavelength, 17);
    const { wavelengthNm, pdfPerNm } = sampleWavelength(u);
    assert.ok(wavelengthNm >= 380 && wavelengthNm < 780);
    near(pdfPerNm, 1 / 400, 0);
    const contribution = spectralXYZContribution(rgb, wavelengthNm, pdfPerNm, 0.25);
    contribution.forEach((x, c) => { sum[c] += x / samples; });
  }
  vectorNear(sum, rgbToXYZ(rgb).map(x => x * 0.25), 1e-4);
  assert.throws(() => sampleWavelength(1), /Invalid/);
  assert.throws(() => spectralXYZContribution(rgb, 555, 0), /PDF/);
});

test('five fixed Sobol dimensions have stratified dyadic prefixes with pixel digital shifts', () => {
  assert.deepEqual(SAMPLE_DIMENSIONS, { pixelX: 0, pixelY: 1, pupilX: 2, pupilY: 3, wavelength: 4 });
  for (const n of [16, 64, 256, 1024]) {
    for (let d = 0; d < 5; d++) {
      const values = Array.from({ length: n }, (_, i) => sampleDimension(19, i, d, 42));
      assert.equal(new Set(values.map(x => Math.floor(n * x))).size, n);
      assert.ok(values.every(x => x > 0 && x < 1 && Math.fround(x) === x));
      near(values.reduce((a, b) => a + b, 0) / n, 0.5, 1 / n);
    }
  }
  const bins = Array(256).fill(0);
  for (let i = 0; i < 256; i++) {
    bins[Math.floor(16 * sampleDimension(19, i, 0, 42))
      + 16 * Math.floor(16 * sampleDimension(19, i, 1, 42))]++;
  }
  assert.ok(bins.every(x => x === 1));
  assert.notEqual(sampleDimension(19, 1, 4, 42), sampleDimension(20, 1, 4, 42));
  assert.notEqual(sampleDimension(19, 1, 4, 42), sampleDimension(19, 1, 4, 43));
});

test('sample prefixes and f32 accumulated contributions do not depend on dispatch batching', () => {
  const accumulate = batch => {
    let attempted = 0;
    const sum = [0, 0, 0];
    const sampleLog = [];
    while (attempted < 511) {
      for (let local = 0; local < batch && attempted < 511; local++, attempted++) {
        const u = sampleDimension(101, attempted, 4, 55);
        sampleLog.push(u);
        const { wavelengthNm, pdfPerNm } = sampleWavelength(u);
        // Failed paths are zero but consume the identical fixed attempt index.
        if (sampleDimension(101, attempted, 2, 55) < 0.5) continue;
        const contribution = spectralXYZContribution([4, 2, 0.5], wavelengthNm, pdfPerNm);
        contribution.forEach((x, c) => { sum[c] = Math.fround(sum[c] + Math.fround(x)); });
      }
    }
    return { attempted, sum, sampleLog };
  };
  const reference = accumulate(1);
  for (const batch of [2, 3, 7, 32]) assert.deepEqual(accumulate(batch), reference);
  assert.equal(reference.attempted, 511);
  assert.throws(() => sampleDimension(0, 0, 5), /dimension/);
  assert.throws(() => sampleDimension(0, -1, 0), /u32/);
});

test('disc mapping has bounded area samples with no rejection and correct second moment', () => {
  vectorNear(concentricDisk(0.5, 0.5), [0, 0], 0);
  let radiusSquared = 0;
  for (let i = 0; i < 4096; i++) {
    const [x, y] = concentricDisk(sampleDimension(9, i, 2), sampleDimension(9, i, 3));
    assert.ok(x * x + y * y <= 1 + 1e-15);
    radiusSquared += (x * x + y * y) / 4096;
  }
  near(radiusSquared, 0.5, 0.002);
});

test('shader modules contain no GPU bindings, successful-sample normalization, RGB-channel wavelength bins or retry loops', () => {
  assert.ok(SPECTRAL_WGSL.includes('fn spectralXYZContribution'));
  assert.ok(SAMPLING_WGSL.includes('fn sampleDimension'));
  assert.doesNotMatch(SPECTRAL_WGSL + SAMPLING_WGSL, /@binding|@group|textureSample|sumThroughput/);
});
