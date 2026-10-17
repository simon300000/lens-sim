/**
 * Nonnegative additive-primary emission reconstruction. No material/illuminant
 * spectrum can be recovered uniquely from RGB; this chooses one smooth metamer.
 * CMFs: independent implementation of Wyman, Sloan & Shirley 2013, equation 4.
 * https://jcgt.org/published/0002/02/01/ . No supplemental code/table copied.
 * See docs/spectral.md for normalization, approximation, sources and tests.
 */
const LINEAR_SRGB_TO_XYZ = Object.freeze([
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.0721750],
  [0.0193339, 0.1191920, 0.9503041],
]);
// Inverse of the matrix above (D65, Ywhite = 1).
const XYZ_TO_LINEAR_SRGB = Object.freeze([
  [3.2404548360214087, -1.5371388501025751, -0.4985315468684809],
  [-0.9692663898756537, 1.876010928842491, 0.04155608234667355],
  [0.05564341960421367, -0.20402585426769815, 1.057225162457929],
]);

const matVec = (m, v) => m.map(row => row.reduce((sum, c, i) => sum + c * v[i], 0));
export const rgbToXYZ = rgb => matVec(LINEAR_SRGB_TO_XYZ, rgb);
export const xyzToRGB = xyz => matVec(XYZ_TO_LINEAR_SRGB, xyz);

function lobe(wavelength, center, left, right) {
  const q = (wavelength - center) * (wavelength < center ? left : right);
  return Math.exp(-0.5 * q * q);
}

/** CIE 1931 2 degree XYZ analytic approximation, wavelength explicitly in nm. */
export function cieXYZ(wavelengthNm) {
  if (!Number.isFinite(wavelengthNm)) throw new TypeError('Wavelength must be finite nm.');
  if (wavelengthNm < 380 || wavelengthNm > 780) return [0, 0, 0];
  return [
    0.362 * lobe(wavelengthNm, 442, 0.0624, 0.0374)
      + 1.056 * lobe(wavelengthNm, 599.8, 0.0264, 0.0323)
      - 0.065 * lobe(wavelengthNm, 501.1, 0.0490, 0.0382),
    0.821 * lobe(wavelengthNm, 568.8, 0.0213, 0.0247)
      + 0.286 * lobe(wavelengthNm, 530.9, 0.0613, 0.0322),
    1.217 * lobe(wavelengthNm, 437, 0.0845, 0.0278)
      + 0.681 * lobe(wavelengthNm, 459, 0.0385, 0.0725),
  ];
}

function integrate(fn, minNm, maxNm, step = 0.5) {
  const count = Math.ceil((maxNm - minNm) / step);
  const h = (maxNm - minNm) / count;
  let result = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const wavelengthNm = minNm + (i + 0.5) * h;
    const v = fn(wavelengthNm);
    result = result.map((sum, channel) => sum + v[channel] * h);
  }
  return result;
}

// A single fixed normalization, shared by all lenses, pixels and frames. This
// is NOT a per-image exposure, throughput normalization, or a D65 SPD lookup.
export const CIE_Y_INTEGRAL = integrate(cieXYZ, 380, 780, 0.1)[1];
export const XYZ_NORMALIZATION = 1 / CIE_Y_INTEGRAL;

function determinant(a, b, c) {
  return a[0] * (b[1] * c[2] - b[2] * c[1])
    - b[0] * (a[1] * c[2] - a[2] * c[1])
    + c[0] * (a[1] * b[2] - a[2] * b[1]);
}

function solve3(columns, target) {
  const [a, b, c] = columns;
  const d = determinant(a, b, c);
  if (Math.abs(d) < 1e-12) return null;
  return [determinant(target, b, c) / d,
    determinant(a, target, c) / d, determinant(a, b, target) / d];
}

const gaussian = (w, center, sigma) => Math.exp(-0.5 * ((w - center) / sigma) ** 2);

/**
 * Select three positive smooth lobes for each RGB primary. All triples in the
 * finite candidate bank are checked. Each feasible triple exactly reproduces
 * the primary's XYZ, within quadrature error. The least squared spectral energy
 * avoids selecting arbitrarily large cancelling coefficients (no cancellation
 * is possible anyway). The bank itself is authored here, not a copied RGB LUT.
 */
export function createSpectralReconstruction({ minNm = 380, maxNm = 780 } = {}) {
  if (!(Number.isFinite(minNm) && Number.isFinite(maxNm) && minNm >= 380 && maxNm <= 780 && maxNm - minNm >= 200)) {
    throw new RangeError('Spectral reconstruction requires a visible interval of at least 200 nm within 380–780 nm.');
  }
  const candidates = [];
  for (const sigma of [12, 20, 28]) {
    for (let center = 400; center <= 720; center += 20) {
      const xyz = integrate(w => cieXYZ(w).map(x => x * gaussian(w, center, sigma) * XYZ_NORMALIZATION), minNm, maxNm);
      candidates.push({ center, sigma, xyz });
    }
  }
  const primaries = [0, 1, 2].map(channel => {
    const target = LINEAR_SRGB_TO_XYZ.map(row => row[channel]);
    let best = null;
    for (let i = 0; i < candidates.length - 2; i++) {
      for (let j = i + 1; j < candidates.length - 1; j++) {
        for (let k = j + 1; k < candidates.length; k++) {
          const lobes = [candidates[i], candidates[j], candidates[k]];
          const weights = solve3(lobes.map(x => x.xyz), target);
          if (!weights || weights.some(x => x < -1e-10 || !Number.isFinite(x))) continue;
          const positive = weights.map(x => Math.max(0, x));
          // Analytic Gaussian product integral over the real line. It is only
          // a deterministic smoothness preference; color fitting above uses
          // precisely the requested wavelength support.
          let energy = 0;
          for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
            const x = lobes[a], y = lobes[b];
            const variance = x.sigma ** 2 + y.sigma ** 2;
            const overlap = Math.sqrt(2 * Math.PI) * x.sigma * y.sigma / Math.sqrt(variance)
              * Math.exp(-0.5 * (x.center - y.center) ** 2 / variance);
            energy += positive[a] * positive[b] * overlap;
          }
          if (!best || energy < best.energy) best = { lobes, weights: positive, energy };
        }
      }
    }
    if (!best) throw new Error(`Visible range ${minNm}–${maxNm} nm cannot represent sRGB primary ${channel} with nonnegative smooth spectra.`);
    return best.lobes.map((l, i) => Object.freeze({ center: l.center, sigma: l.sigma, weight: best.weights[i] }));
  });

  const radiance = (rgb, wavelengthNm) => {
    if (!rgb || rgb.length !== 3 || rgb.some(x => !Number.isFinite(x) || x < 0)) {
      throw new RangeError('Spectrum input must be finite, nonnegative scene-linear RGB (HDR values are allowed).');
    }
    if (!Number.isFinite(wavelengthNm)) throw new TypeError('Wavelength must be finite nm.');
    if (wavelengthNm < minNm || wavelengthNm > maxNm) return 0;
    // Preserve HDR amplitude separately; no clamp to unit RGB and no exposure.
    const amplitude = Math.max(...rgb);
    if (amplitude === 0) return 0;
    let value = 0;
    for (let c = 0; c < 3; c++) {
      const shape = rgb[c] / amplitude;
      for (const l of primaries[c]) value += shape * l.weight * gaussian(wavelengthNm, l.center, l.sigma);
    }
    return amplitude * value;
  };
  const integrateXYZ = (rgb, step = 0.1) => integrate(
    w => cieXYZ(w).map(x => x * radiance(rgb, w) * XYZ_NORMALIZATION), minNm, maxNm, step,
  );
  return Object.freeze({ minNm, maxNm, primaries: Object.freeze(primaries.map(Object.freeze)), radiance, integrateXYZ });
}

export const spectralReconstruction = createSpectralReconstruction();
export const spectralRadiance = spectralReconstruction.radiance;

export function sampleWavelength(u, minNm = 380, maxNm = 780) {
  if (!(Number.isFinite(u) && Number.isFinite(minNm) && Number.isFinite(maxNm) && u >= 0 && u < 1 && minNm >= 380 && maxNm <= 780 && maxNm > minNm)) throw new RangeError('Invalid wavelength sample or support.');
  return { wavelengthNm: minNm + u * (maxNm - minNm), pdfPerNm: 1 / (maxNm - minNm) };
}

export function spectralXYZContribution(rgb, wavelengthNm, pdfPerNm, cameraWeight = 1, reconstruction = spectralReconstruction) {
  if (!(pdfPerNm > 0 && Number.isFinite(pdfPerNm) && cameraWeight >= 0 && Number.isFinite(cameraWeight))) throw new RangeError('Invalid spectral PDF or camera weight.');
  const scale = reconstruction.radiance(rgb, wavelengthNm) * cameraWeight * XYZ_NORMALIZATION / pdfPerNm;
  return cieXYZ(wavelengthNm).map(x => x * scale);
}

const wgslNumber = x => Number(x).toExponential(10);
function spectralWGSL(reconstruction = spectralReconstruction) {
  const spectra = reconstruction.primaries.map(lobes => lobes.map(l =>
    `${wgslNumber(l.weight)} * spectralGaussian(lambdaNm, ${wgslNumber(l.center)}, ${wgslNumber(l.sigma)})`).join(' + '));
  return /* wgsl */`
// Authored nonnegative primary spectra; Wyman et al. 2013 equation 4 CMFs.
// Lambda in nm. XYZ Ywhite=1, D65 sRGB primaries. No exposure or encoding.
const SPECTRAL_XYZ_NORMALIZATION: f32 = ${wgslNumber(XYZ_NORMALIZATION)};
fn spectralLobe(w: f32, center: f32, left: f32, right: f32) -> f32 {
  let q = (w-center)*select(right,left,w<center);
  return exp(-0.5*q*q);
}
fn cieXYZ(lambdaNm: f32) -> vec3f {
  if (lambdaNm < 380.0 || lambdaNm > 780.0) { return vec3f(0.0); }
  return vec3f(
    0.362*spectralLobe(lambdaNm,442.0,0.0624,0.0374)+1.056*spectralLobe(lambdaNm,599.8,0.0264,0.0323)-0.065*spectralLobe(lambdaNm,501.1,0.0490,0.0382),
    0.821*spectralLobe(lambdaNm,568.8,0.0213,0.0247)+0.286*spectralLobe(lambdaNm,530.9,0.0613,0.0322),
    1.217*spectralLobe(lambdaNm,437.0,0.0845,0.0278)+0.681*spectralLobe(lambdaNm,459.0,0.0385,0.0725));
}
fn spectralGaussian(w: f32, center: f32, sigma: f32) -> f32 {
  let d=(w-center)/sigma; return exp(-0.5*d*d);
}
fn spectralRadiance(rgb: vec3f, lambdaNm: f32) -> f32 {
  if (lambdaNm < ${wgslNumber(reconstruction.minNm)} || lambdaNm > ${wgslNumber(reconstruction.maxNm)}) { return 0.0; }
  // Scene capture is an emission RGB basis, not reflectance. Negative channels
  // have no nonnegative-spectrum representation and must be diagnosed upstream.
  let safeRGB=max(rgb,vec3f(0.0));
  let amplitude=max(max(safeRGB.r,safeRGB.g),safeRGB.b);
  if(amplitude==0.0){return 0.0;}
  let shape=safeRGB/amplitude;
  let primary=vec3f(${spectra.join(',\n    ')});
  return amplitude*dot(shape,primary);
}
fn spectralXYZContribution(rgb: vec3f, lambdaNm: f32, pdfPerNm: f32, cameraWeight: f32) -> vec3f {
  return cieXYZ(lambdaNm)*(spectralRadiance(rgb,lambdaNm)*cameraWeight*SPECTRAL_XYZ_NORMALIZATION/pdfPerNm);
}
fn xyzToLinearSRGB(xyz: vec3f) -> vec3f {
  return vec3f(
    dot(vec3f(3.240454836,-1.537138850,-0.498531547),xyz),
    dot(vec3f(-0.969266390,1.876010929,0.041556082),xyz),
    dot(vec3f(0.055643420,-0.204025854,1.057225162),xyz));
}
`;
}
export const SPECTRAL_WGSL = spectralWGSL();
