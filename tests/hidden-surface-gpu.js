import * as THREE from 'three/webgpu';
import { createLensRig, stripedPanel, emissivePanel, emitter, absorber } from './gpu-fixtures.js';
import { apertureLimits } from '../src/optics/lens-state.js';
/** Test B: first hit + hidden background. Emissive/absorbing geometry only
 * (no lights), so every value comes from geometry visibility through the
 * real lens. Proves:
 *  1. off-centre aperture positions see a surface that is HIDDEN from the
 *     centre viewpoint (magenta stripe directly behind a thin rod);
 *  2. the image does not depend on any raster image resolution (refresh
 *     target 16x11 vs 512x341 give bitwise-identical accumulation);
 *  3. focus sweeps make the near rod or the far stripes sharp in turn;
 *  4. a finite emitter's bokeh disc scales with the aperture.
 * No screen-space hole filling, neighbourhood colour spreading or vignette
 * painting exists in the code path. */
const out = document.querySelector('#result'), check = (c, m) => { if (!c) throw new Error(m); };
const W = 240, H = 160, SPP = 64;
try {
  const adapter = await navigator.gpu.requestAdapter();
  const renderer = new THREE.WebGPURenderer({ antialias: false }); await renderer.init(); renderer.setSize(W, H);
  const errors = [];
  const scene = new THREE.Scene();
  stripedPanel(scene, { z: -6, w: 3, h: 2, color: [1, 1, 1], stripes: 40, dim: .1 });
  emissivePanel(scene, { z: -5.99, w: .01, h: 2, color: [3, 0, 3] });          // hidden behind the rod from the centre
  const rod = new THREE.Mesh(new THREE.BoxGeometry(.015, 1.2, .015), absorber()); rod.position.set(0, 0, -1.2); scene.add(rod);
  for (const [x, y, z, r] of [[.5, 2.6, -12, .03], [1, -.6, -3, .006]]) { const s = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 8), emitter([400, 300, 200])); s.position.set(x, y, z); scene.add(s); }
  const lensAsset = await (await fetch('/lenses/canon-fl-50mm-f1-8.json')).json(), lens = lensAsset.configurations[0];
  const f = 49.06; // paraxial focal length (mm) of this prescription, for the pinhole reference FOV only
  const camera = new THREE.PerspectiveCamera(2 * Math.atan(12 / f) * 180 / Math.PI, 1.5, .05, 100); camera.updateMatrixWorld();
  async function rig(refreshSize) { const r = await createLensRig({ renderer, scene, camera, width: W, refreshSize }); r.interop.device.addEventListener('uncapturederror', e => errors.push(e.error.message)); r.engine.setLens(lens, { fNumber: 2.8, sensorZMm: lens.sensorZMm, dispersion: false }); return r; }
  const A = await rig([16, 11]);
  const render = async (r, { fNumber, focusM, pinhole = false, spp = SPP }) => {
    const e = r.engine;
    if (!pinhole) { e.updateOptics({ fNumber, sensorZMm: lens.sensorZMm, dispersion: false }); const focus = await e.focusPoint([0, 0, -focusM * 1000]); e.updateOptics({ fNumber, sensorZMm: focus.sensorZMm, dispersion: false }); }
    e.reset();
    const pin = pinhole ? { cameraToWorld: camera.matrixWorld.elements, clipToCamera: camera.projectionMatrixInverse.elements } : null;
    for (let i = 0; i < spp / 4; i++) { e.sample({ batchSpp: 4, targetSpp: spp, seed: 5, pinhole: pin }); await r.interop.device.queue.onSubmittedWorkDone(); }
    return { pixels: await r.interop.readTexture(e.outputGPU), stats: await e.statistics(), raw: new Uint32Array(await e.readAccumulation()) };
  };
  const L = (p, x, y) => { const i = (y * W + x) * 4; return .2126 * p[i] + .7152 * p[i + 1] + .0722 * p[i + 2]; };
  // Magenta excess (R+B)/2 - G near the image centre column, rows around the middle.
  const magenta = p => { let s = 0, n = 0; for (let y = 60; y < 100; y++) { let best = 0; for (let x = 112; x < 128; x++) { const i = (y * W + x) * 4; best = Math.max(best, (p[i] + p[i + 2]) / 2 - p[i + 1]); } s += best; n++; } return s / n; };
  const contrast = p => { const col = []; for (let x = 20; x < 90; x++) { let v = 0; for (let y = 60; y < 100; y++) v += L(p, x, y); col.push(v / 40); } const m = col.reduce((a, b) => a + b) / col.length; return Math.sqrt(col.reduce((s, v) => s + (v - m) ** 2, 0) / col.length) / m; };
  // Rod core darkness: darkest column mean near the centre / mean of flanking columns.
  // A sharp 4.3 px rod is nearly black; a defocused one lets background through.
  const colMean = (p, x) => { let v = 0; for (let y = 60; y < 100; y++) v += L(p, x, y); return v / 40; };
  const rodCore = p => { let core = Infinity; for (let x = 112; x < 129; x++) core = Math.min(core, colMean(p, x)); let n = 0, side = 0; for (const x of [98, 99, 100, 101, 139, 140, 141, 142]) { side += colMean(p, x); n++; } return core / (side / n); };
  const limits = apertureLimits(lens), wide = limits.minFNumber;
  const pin = await render(A, { pinhole: true });
  const open6 = await render(A, { fNumber: wide, focusM: 6 });
  const stoppedDown = apertureLimits(lens).maxFNumber; // data-constrained smallest stop of this lens
  const closed6 = await render(A, { fNumber: stoppedDown, focusM: 6 });
  const open12 = await render(A, { fNumber: wide, focusM: 1.2, spp: 256 });
  const f4near = await render(A, { fNumber: 4, focusM: 1.2, spp: 256 });
  // 1. Hidden surface through the aperture.
  const hidden = { pinhole: magenta(pin.pixels), f18Focus6: magenta(open6.pixels), stoppedDownFocus6: magenta(closed6.pixels), stoppedDownFNumber: stoppedDown };
  check(hidden.pinhole < 1e-3, 'stripe should be hidden from the centre viewpoint: ' + JSON.stringify(hidden));
  check(hidden.f18Focus6 > 5 * Math.max(hidden.stoppedDownFocus6, 1e-3) && hidden.f18Focus6 > .05, 'open aperture did not reveal the hidden background: ' + JSON.stringify(hidden));
  // 2. Independence from any raster image resolution.
  const B = await rig([512, 341]);
  const openB = await render(B, { fNumber: wide, focusM: 6 });
  check(openB.raw.length === open6.raw.length && openB.raw.every((v, i) => v === open6.raw[i]), 'lens accumulation depends on the raster refresh resolution');
  // 3. Focus sweep.
  const sweep = { stripeContrastFocus6: contrast(open6.pixels), stripeContrastFocus1p2: contrast(open12.pixels), rodCoreFocus1p2: rodCore(open12.pixels), rodCoreFocus6: rodCore(open6.pixels) };
  check(sweep.stripeContrastFocus6 > 1.3 * sweep.stripeContrastFocus1p2, 'background stripes not sharper when focused at 6 m: ' + JSON.stringify(sweep));
  check(sweep.rodCoreFocus1p2 < .5 * sweep.rodCoreFocus6, 'rod not sharper when focused at 1.2 m: ' + JSON.stringify(sweep));
  // 4. Bokeh of the far point emitter (focused at 1.2 m): disc area vs aperture.
  // Flux-weighted RMS radius of the far emitter's image (black surroundings):
  // a defocus disc's radius scales ~1/N; an RMS measure is robust to sampling noise.
  const X0 = 124, X1 = 150, Y0 = 0, Y1 = 19; // empty region around the far emitter's image (~10.8 mm image height)
  const disc = p => { let s = 0, cx = 0, cy = 0; for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) { const v = L(p, x, y); s += v; cx += v * x; cy += v * y; }
    cx /= s; cy /= s; let m = 0; for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) m += L(p, x, y) * ((x - cx) ** 2 + (y - cy) ** 2);
    return { flux: s, centre: [cx, cy], rmsRadiusPx: Math.sqrt(m / s) }; };
  const bokeh = { wide: disc(open12.pixels), f4: disc(f4near.pixels), wideFNumber: wide };
  bokeh.radiusRatio = bokeh.wide.rmsRadiusPx / bokeh.f4.rmsRadiusPx; bokeh.geometricExpectation = 4 / wide; bokeh.fluxRatio = bokeh.wide.flux / bokeh.f4.flux; bokeh.fluxExpectation = (4 / wide) ** 2;
  // Paraxial expectations ignore pixel/emitter size and off-axis mechanical
  // vignetting (which clips the wide-open disc); require clear, bounded scaling.
  check(bokeh.f4.rmsRadiusPx > .5 && bokeh.radiusRatio > .6 * bokeh.geometricExpectation && bokeh.radiusRatio < 1.25 * bokeh.geometricExpectation, 'bokeh disc did not scale with aperture: ' + JSON.stringify(bokeh));
  check(bokeh.fluxRatio > .5 * bokeh.fluxExpectation && bokeh.fluxRatio < 1.1 * bokeh.fluxExpectation, 'wider aperture did not collect correspondingly more flux: ' + JSON.stringify(bokeh));
  for (const r of [pin, open6, closed6, open12, f4near]) check(r.stats.bvhErrorRate === 0 && r.stats.numericalErrorRate === 0, 'errors in hidden-surface renders');
  check(errors.length === 0, errors.join('\n'));
  const result = { passed: true, environment: { userAgent: navigator.userAgent, adapter: adapter.info }, size: [W, H], spp: SPP, hidden, refreshResolutionIndependent: true, sweep, bokeh,
    stats: { open6: open6.stats, closed6: closed6.stats }, errors };
  out.textContent = JSON.stringify(result, null, 2); document.body.dataset.passed = 'true'; window.__hiddenTest = { result, open6, open12 };
} catch (error) { out.textContent = error.stack || String(error); document.body.dataset.passed = 'false'; console.error(error); }
