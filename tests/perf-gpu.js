import * as THREE from 'three/webgpu';
import {requiredGPULimits} from '../src/rendering/gpu-policy.js';
import { buildSanteiScene } from '../src/scene/santei-scene.js';
import { createDaylight } from '../src/lighting.js';
import { createLensRig,focusTestLens } from './gpu-fixtures.js';
import { WORK_COUNTERS } from '../src/rendering/work-model.js';
/** Performance record of the V2 lens path on the full villa scene. GPU times
 * are timestamp-query durations of one compute pass (one tile batch); CPU
 * times are labelled as such. Results describe THIS adapter only. */
const out = document.querySelector('#result'), q = new URLSearchParams(location.search);
const W = Number(q.get('width') ?? 240), BATCHES = Number(q.get('batches') ?? 8);
// ?roundSpp=: samples per pixel per accumulation round (engine limit and batch size alike).
const SPP = Number(q.get('roundSpp') ?? 4);
const step = l => console.log('[step] ' + l + ' ' + performance.now().toFixed(0));
const stats = a => { const s = [...a].sort((x, y) => x - y); return { n: s.length, min: s[0], median: s[Math.floor(s.length / 2)], max: s.at(-1), mean: s.reduce((x, y) => x + y, 0) / s.length }; };
try {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice({requiredFeatures:[...adapter.features],requiredLimits:requiredGPULimits(adapter.limits)});
  const renderer = new THREE.WebGPURenderer({antialias:false,device});
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
  // The staged integrator is the sole production path.
  // ?scratch=<MiB>: staged lens-sample scratch (rounds larger than it are split into chunks).
  const rig = await createLensRig({ renderer, scene, camera, width: W, environment: daylight, engineOptions: { stageTiming: q.get('stages') === '1', roundSppLimit: SPP, ...(q.has('scratch') ? { stagedRayBufferBytes: Number(q.get('scratch')) * 1024 ** 2 } : {}) } });
  const rigWallMs = performance.now() - t; step('rig');
  const { interop, engine, lighting, sceneResources } = rig;
  const lens = (await (await fetch('/lenses/canon-fl-50mm-f1-8.json')).json()).configurations[0];
  engine.setLens(lens, { fNumber: 2.8, sensorZMm: lens.sensorZMm, dispersion: false });
  const focus = focusTestLens(engine,lens,30); engine.setLens(focus.lens,{ sensorZMm:focus.lens.sensorZMm, fNumber: 2.8, dispersion: false });
  async function refreshTimed() {
    const a = performance.now(); lighting.refresh(); const submit = performance.now() - a;
    await interop.device.queue.onSubmittedWorkDone(); return { cpuSubmitMs: submit, submitToDoneWallMs: performance.now() - a };
  }
  // `until`: no inter-batch pause, run until the promise settles (app-like continuous sampling).
  async function batches(options, { until = null, sleepMs = 20 } = {}) {
    // Warm-up: after a few seconds of idle (a pipeline compile, a wait) this GPU sits in a low
    // power state (P3: 5001 MHz memory, ~600 MHz core) that takes a sustained load to leave;
    // measured right then, batches read 2-4x slower. Sample continuously first.
    if (!until) { engine.reset(); const w = performance.now(); while (performance.now() - w < 400) { engine.sample({ batchSpp: SPP, targetSpp: 0, ...options }); await interop.device.queue.onSubmittedWorkDone(); } }
    engine.reset(); const gpu = [], wall = [], stages = [], t = [];
    let settled = !until; until?.finally(() => { settled = true; });
    for (let i = 0; (until ? !settled && i < 2000 : i < BATCHES); i++) {
      const a = performance.now(); t.push(Date.now()); engine.sample({ batchSpp: SPP, targetSpp: 0, ...options }); await interop.device.queue.onSubmittedWorkDone(); wall.push(performance.now() - a);
      if (!until) await new Promise(r => setTimeout(r, sleepMs)); if (engine.lastTiming) { gpu.push(engine.lastTiming.ms); stages.push(engine.lastTiming); }
    }
    // ?stages=1 with the staged integrator: per-kernel GPU medians (lensMs, traceMs, sceneMs).
    const stageMs = Object.fromEntries(['lensMs', 'traceMs', 'sceneMs'].filter(k => stages.some(t => t[k] != null)).map(k => [k, stats(stages.map(t => t[k]).filter(v => v != null)).median]));
    const s = await engine.statistics();
    // One sample() call submits one chunk; a round (one spp of the whole frame at batchSpp) may
    // take several when the staged scratch is smaller than the frame. Frame-level throughput
    // therefore comes from the GPU time summed over all chunks and the attempted paths they
    // accumulated (partial rounds included), expressed per spp of the whole frame.
    const gpuSumMs = gpu.reduce((a, b) => a + b, 0), frameSpp = s.attemptedSamples / (W * W / 1.5);
    return { gpuTimestampMsPerBatch: gpu.length ? stats(gpu) : null, submitToDoneWallMsPerBatch: stats(wall), raw: { gpu, wall, t }, stageMs, pathsPerBatch: W * W / 1.5 * SPP, attemptedSamples: s.attemptedSamples, spp: frameSpp,
      chunks: gpu.length, gpuMsPerFrameSpp: frameSpp > 0 && gpu.length === wall.length ? gpuSumMs / frameSpp : null,
      attemptedPerSecondFromGPU: gpuSumMs > 0 && gpu.length === wall.length ? s.attemptedSamples / (gpuSumMs / 1000) : null, rates: { pass: s.opticalPassRate, hit: s.sceneHitOfPassed, background: s.backgroundOfPassed, bvhError: s.bvhErrorRate, unsupported: s.unsupportedRate, transparencyLimit: s.transparencyLimitRate, reflectionOutside: s.reflectionOutsideRate } };
  }
  const refresh = { initial: await refreshTimed(), initialRepeat: await refreshTimed() };
  step('refresh');
  // ?work=1: per-path primitive tallies from the diagnostics (counting) kernel variant,
  // with the GPU time of those counted batches.
  const countWork = async (force = false) => {
    if (q.get('work') !== '1' && !force) return null;
    const status = await engine.setWorkCounting(true);
    let work = { status };
    if (status === 'counting') {
      // Counted batches are timed like production ones: the HUD runs this variant while open.
      const counted = await batches({});
      const w = await engine.readWork(), paths = Math.max(1, w.counts[0]);
      work = { status, paths, perPath: Object.fromEntries(WORK_COUNTERS.map(([key], i) => [key, w.counts[i] / paths])), gpuTimestampMsPerBatch: counted.gpuTimestampMsPerBatch, stageMs: counted.stageMs, raw: counted.raw };
    }
    await engine.setWorkCounting(false); step('work counted');
    return work;
  };
  // ?phases=: measured phases in order. day/night set the time of day (resource refresh
  // only when it changes) and measure; optics measures the lens kernel alone; refresh,
  // update (same hour), tables and waitN are state changes without a measurement.
  // Day again after night separates scene-dependent cost from drift across the run.
  const phases = {}, work = {}, named = base => { let n = base, i = 2; while (phases[n] || refresh[n]) n = base + i++; return n; };
  let hour = 16.5;
  const setHour = async (next, key) => { daylight.update({ hour: next, date: '2026-09-26' }, true); sceneResources.writeTables(); refresh[key] = await refreshTimed(); hour = next; step(key + ' refreshed'); };
  for (const p of (q.get('phases') ?? 'day,optics,night,day').split(',')) {
    if (p === 'day' || p === 'night') {
      const key = named(p), next = p === 'day' ? 16.5 : 0;
      if (next !== hour) await setHour(next, key);
      phases[key] = await batches({}); step(key + ' batches'); work[key] = await countWork();
    } else if (p === 'optics') { const key = named('opticsOnly'); phases[key] = await batches({ constantEnvironment: [1, 1, 1] }); step(key + ' batches'); }
    // Coherent pixel-centre rays of the reference camera (independent kernel, no lens): isolates traversal divergence.
    else if (p === 'pinhole') { const key = named('pinhole'); phases[key] = await batches({ pinhole: { cameraToWorld: camera.matrixWorld.elements, clipToCamera: camera.projectionMatrixInverse.elements } }); step(key + ' batches'); }
    // Lens rays without mirror reuse (independent kernel): same rays as the mirror kernel, one ray per thread step.
    else if (p === 'independent') { const key = named('independent'); phases[key] = await batches({ mirrorReuse: false }); step(key + ' batches'); }
    else if (p === 'refresh') { refresh[named('refreshOnly')] = await refreshTimed(); step('refresh only'); }
    else if (p === 'update') await setHour(hour, named('update'));
    else if (p === 'tables') { sceneResources.writeTables(); step('tables written'); }
    else if (p.startsWith('wait')) { await new Promise(r => setTimeout(r, Number(p.slice(4)) * 1000)); step(p); }
    // compilebg: compile the counting variant while sampling continues (as the app does), never dispatch it.
    else if (p === 'compilebg') { const a = performance.now(); const pending = engine.setWorkCounting(true); const key = named('compileBg'); phases[key] = await batches({}, { until: pending }); const status = await pending; await engine.setWorkCounting(false); work[key] = { status, compileMs: performance.now() - a }; step('compiled in background'); }
    // compile: build and bind the counting variant without ever dispatching it.
    else if (p === 'compile') { const a = performance.now(); const status = await engine.setWorkCounting(true); await engine.setWorkCounting(false); work[named('compile')] = { status, compileMs: performance.now() - a }; step('compiled'); }
    // count: per-path primitive tallies and the timing of counted batches (the HUD runs this
    // variant on one chunk in four while open). Compiling the variant takes seconds with the GPU
    // idle; the warm-up in batches() brings the clocks back before anything is timed.
    else if (p === 'count') { work[named('count')] = await countWork(true); }
    else throw new Error('Unknown phase ' + p);
  }
  const day = phases.day, night = phases.night, dayRepeat = phases.day2, opticsOnly = phases.opticsOnly;
  // Known, pre-existing Three r183 shadow/reflector issue (reproduced on V1);
  // reported separately, every other GPU error fails.
  const known = errors.filter(e => /Destroyed texture \[Texture "(Point)?ShadowDepthTexture"\] used in a submit/.test(e)), other = errors.filter(e => !known.includes(e));
  const result = { passed: other.length === 0 && Object.values(phases).every(p => p.rates.bvhError === 0), knownThreeShadowErrors: known.length, roundSpp: SPP, environment: { userAgent: navigator.userAgent, adapter: adapter.info, timestampQuery: interop.device.features.has('timestamp-query') },
    image: [W, W / 1.5], batchSpp: 4, sceneBuildMs, firstRasterWallMs, rigWallMs, bvh: sceneResources.stats, refresh, phases, day, night, dayRepeat, opticsOnly, work,
    memory: { bvhAndTablesBytes: sceneResources.stats.gpuBytes, engineBytes: engine.memoryBytes }, lighting: lighting.status, errors };
  out.textContent = JSON.stringify(result, null, 2); document.body.dataset.passed = String(result.passed);
} catch (error) { out.textContent = error.message+'\n'+(error.stack||String(error)); document.body.dataset.passed = 'false'; console.error(error); }
