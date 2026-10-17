import * as THREE from 'three/webgpu';
import { buildSanteiScene } from '../src/scene/santei-scene.js';
import { createDaylight } from '../src/lighting.js';
import { createLensRig,focusTestLens } from './gpu-fixtures.js';
/** Performance record of the V2 lens path on the full villa scene. GPU times
 * are timestamp-query durations of one compute pass (one tile batch); CPU
 * times are labelled as such. Results describe THIS adapter only. */
const out = document.querySelector('#result'), q = new URLSearchParams(location.search);
const W = Number(q.get('width') ?? 240), BATCHES = Number(q.get('batches') ?? 8);
const step = l => console.log('[step] ' + l + ' ' + performance.now().toFixed(0));
const stats = a => { const s = [...a].sort((x, y) => x - y); return { n: s.length, min: s[0], median: s[Math.floor(s.length / 2)], max: s.at(-1), mean: s.reduce((x, y) => x + y, 0) / s.length }; };
try {
  const adapter = await navigator.gpu.requestAdapter();
  const renderer = new THREE.WebGPURenderer({ antialias: false, requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize } });
  await renderer.init(); renderer.setSize(W, W / 1.5); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.toneMapping = THREE.NoToneMapping;
  const errors = []; renderer.backend.device.addEventListener('uncapturederror', e => { errors.push(e.error.message); step('GPU ERROR ' + e.error.message.split('\n')[0]); });
  let t = performance.now();
  const built = buildSanteiScene(), { scene, details } = built; const sceneBuildMs = performance.now() - t; step('scene built');
  for (const lamp of details.lamps.slice(0, 2)) { lamp.light.castShadow = true; lamp.light.shadow.mapSize.set(512, 512); lamp.light.shadow.camera.near = .08; lamp.light.shadow.camera.far = 11; lamp.light.shadow.camera.layers.set(1); }
  const daylight = createDaylight(scene, renderer, { details });
  const camera = new THREE.PerspectiveCamera(40, 1.5, .15, 450); camera.position.set(21, 13, 27); camera.lookAt(0, 2.7, 2); camera.updateMatrixWorld();
  daylight.update({ hour: 16.5, date: '2026-09-26' }, true);
  // First raster frame (compiles every scene material) is NOT part of the lens cost.
  t = performance.now(); const firstTarget = new THREE.RenderTarget(W, W / 1.5, { type: THREE.HalfFloatType });
  renderer.setRenderTarget(firstTarget); renderer.render(scene, camera); renderer.setRenderTarget(null); await renderer.backend.device.queue.onSubmittedWorkDone();
  const firstRasterWallMs = performance.now() - t; step('first raster');
  t = performance.now();
  const rig = await createLensRig({ renderer, scene, camera, width: W, environment: daylight });
  const rigWallMs = performance.now() - t; step('rig');
  const { interop, engine, lighting, sceneResources } = rig;
  const lens = (await (await fetch('/lenses/canon-fl-50mm-f1-8.json')).json()).configurations[0];
  engine.setLens(lens, { fNumber: 2.8, sensorZMm: lens.sensorZMm, dispersion: false });
  const focus = focusTestLens(engine,lens,30); engine.setLens(focus.lens,{ sensorZMm:focus.lens.sensorZMm, fNumber: 2.8, dispersion: false });
  async function refreshTimed() {
    const a = performance.now(); lighting.refresh(); const submit = performance.now() - a;
    await interop.device.queue.onSubmittedWorkDone(); return { cpuSubmitMs: submit, submitToDoneWallMs: performance.now() - a };
  }
  async function batches(options) {
    engine.reset(); const gpu = [], wall = [];
    for (let i = 0; i < BATCHES; i++) {
      const a = performance.now(); engine.sample({ batchSpp: 4, targetSpp: 0, ...options }); await interop.device.queue.onSubmittedWorkDone(); wall.push(performance.now() - a);
      await new Promise(r => setTimeout(r, 20)); if (engine.lastTiming) gpu.push(engine.lastTiming.ms);
    }
    const s = await engine.statistics();
    return { gpuTimestampMsPerBatch: gpu.length ? stats(gpu) : null, submitToDoneWallMsPerBatch: stats(wall), pathsPerBatch: W * W / 1.5 * 4,
      attemptedPerSecondFromGPU: gpu.length ? W * W / 1.5 * 4 / (stats(gpu).median / 1000) : null, rates: { pass: s.opticalPassRate, hit: s.sceneHitOfPassed, background: s.backgroundOfPassed, bvhError: s.bvhErrorRate, unsupported: s.unsupportedRate, transparencyLimit: s.transparencyLimitRate, reflectionOutside: s.reflectionOutsideRate } };
  }
  const refresh = { day: await refreshTimed(), dayRepeat: await refreshTimed() };
  step('refresh');
  const day = await batches({}); step('day batches');
  const opticsOnly = await batches({ constantEnvironment: [1, 1, 1] }); step('optics-only batches');
  daylight.update({ hour: 0, date: '2026-09-26' }, true); step('night update'); sceneResources.writeTables(); refresh.night = await refreshTimed(); step('night refreshed');
  const night = await batches({}); step('night batches');
  // Known, pre-existing Three r183 shadow/reflector issue (reproduced on V1);
  // reported separately, every other GPU error fails.
  const known = errors.filter(e => /Destroyed texture \[Texture "(Point)?ShadowDepthTexture"\] used in a submit/.test(e)), other = errors.filter(e => !known.includes(e));
  const result = { passed: other.length === 0 && day.rates.bvhError === 0 && night.rates.bvhError === 0, knownThreeShadowErrors: known.length, environment: { userAgent: navigator.userAgent, adapter: adapter.info, timestampQuery: interop.device.features.has('timestamp-query') },
    image: [W, W / 1.5], batchSpp: 4, sceneBuildMs, firstRasterWallMs, rigWallMs, bvh: sceneResources.stats, refresh, day, night, opticsOnly,
    memory: { bvhAndTablesBytes: sceneResources.stats.gpuBytes, engineBytes: engine.memoryBytes }, lighting: lighting.status, errors };
  out.textContent = JSON.stringify(result, null, 2); document.body.dataset.passed = String(result.passed);
} catch (error) { out.textContent = error.message+'\n'+(error.stack||String(error)); document.body.dataset.passed = 'false'; console.error(error); }
