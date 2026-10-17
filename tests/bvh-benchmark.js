import intersector from '../src/rendering/scene-intersector.wgsl?raw';
import counters from '../src/rendering/work-counters.wgsl?raw';
import { buildBvhVariant } from './bvh-variants.js';
import { loadBvhWorkload } from './bvh-workloads.js';
import { buildLeafSizeVariant, provePackedStackCapacity } from './bvh-build-variants.js';

const q = new URLSearchParams(location.search);
const integer = (key, fallback, min, max) => {
  const value = Number(q.get(key) ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error('Invalid ' + key);
  return value;
};
const rayCount = integer('rays', 8192, 64, 262144);
const rounds = integer('rounds', 9, 3, 41), warmups = integer('warmups', 2, 1, 10);
const names = (q.get('workloads') || 'diagnostic,edges,villa,vegetation').split(',');
const selected = (q.get('variants') || 'baseline,static-axis,reciprocal,tiny-leaf,stack-size,stack-proved,parallel-fast,combined,fast-combined,leaf2,leaf8,leaf8+tiny-leaf,leaf8+combined,leaf8+fast-combined').split(',');
const baselineIndex = selected.indexOf('baseline');
if (baselineIndex >= 0) selected.splice(baselineIndex, 1);
selected.unshift('baseline');
if (new Set(selected).size !== selected.length) throw new Error('Duplicate variants are not allowed');
const out = document.querySelector('#result');
const step = text => { console.log('[step] ' + text); document.querySelector('#status').textContent = text; };
const distribution = values => {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  const median = n % 2 ? sorted[n >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  return { n, median, min: sorted[0], max: sorted.at(-1), mean: sorted.reduce((a, b) => a + b, 0) / n,
    p25: sorted[Math.floor((n - 1) * .25)], p75: sorted[Math.floor((n - 1) * .75)] };
};
const hash = bytes => {
  let value = 2166136261;
  for (const b of new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength)) value = Math.imul(value ^ b, 16777619) >>> 0;
  return value.toString(16).padStart(8, '0');
};
const bindings = [
  'struct RayIn { origin: vec3f, tMin: f32, direction: vec3f, tMax: f32 }',
  'struct HitOut { t:f32, b1:f32, b2:f32, instance:u32, triangle:u32, status:u32, error:u32, front:u32 }',
  '@group(0) @binding(0) var<storage,read> rays:array<RayIn>;',
  '@group(0) @binding(1) var<storage,read_write> hits:array<HitOut>;',
  '@group(0) @binding(2) var<storage,read> sceneNodes:array<BvhNode>;',
  '@group(0) @binding(3) var<storage,read> sceneInstances:array<SceneInstance>;',
  '@group(0) @binding(4) var<storage,read> sceneTriangles:array<SceneTriangle>;',
].join('\n');

function kernel(source, instrumented) {
  if (instrumented) {
    const patch = (from, to) => {
      if (source.split(from).length !== 2) throw new Error('Instrumentation anchor changed: ' + from);
      source = source.replace(from, to);
    };
    patch('        sp++;', '        sp++; benchPeakStack=max(benchPeakStack,sp);');
    patch('  workCounters[WORK_BOX]++;', '  workCounters[WORK_BOX]++; if(benchBoxIsBlas){benchBlasBoxes++;}else{benchTlasBoxes++;}');
    patch('    let n = sceneNodes[node];', '    let n = sceneNodes[node]; benchBoxIsBlas=inBlas;');
    patch('        let linv = sceneSafeInverse(ld);', '        benchBoxIsBlas=true; let linv = sceneSafeInverse(ld);');
  }
  return counters + source + bindings + (instrumented
    ? '\nvar<private> benchPeakStack:u32; var<private> benchBoxIsBlas:bool; var<private> benchTlasBoxes:u32; var<private> benchBlasBoxes:u32;\n@group(0) @binding(5) var<storage,read_write> metrics:array<vec4u>;\n' : '\n') + [
    '@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {',
    '  if(id.x>=arrayLength(&rays)){return;}',
    '  let r=rays[id.x]; let h=sceneIntersect(r.origin,r.direction,r.tMin,r.tMax);',
    '  hits[id.x]=HitOut(h.t,h.b1,h.b2,h.instance,h.triangle,h.status,h.error,select(0u,1u,h.front));',
    ...(instrumented ? [
      '  metrics[id.x*2u]=vec4u(h.visits,workCounters[WORK_BOX],workCounters[WORK_TRIANGLE],workCounters[WORK_INSTANCE]);',
      '  metrics[id.x*2u+1u]=vec4u(benchPeakStack,benchTlasBoxes,benchBlasBoxes,0u);',
    ] : []),
    '}',
  ].join('\n');
}
function hitRecords(raw, packed) {
  const f = new Float32Array(raw), u = new Uint32Array(raw), instance = new Uint32Array(packed.instances), tri = new Uint32Array(packed.triangles);
  return Array.from({ length: raw.byteLength / 32 }, (_, i) => {
    const o = i * 8, found = u[o + 5] === 1, inst = u[o + 3], t = u[o + 4];
    return { t: f[o], bary: [1 - f[o + 1] - f[o + 2], f[o + 1], f[o + 2]],
      instance: found ? instance[inst * 32 + 27] : null, primitive: found ? tri[t * 16 + 12] : null,
      blas: found ? tri[t * 16 + 13] : null, material: found ? instance[inst * 32 + 25] : null,
      status: u[o + 5], error: u[o + 6], front: Boolean(u[o + 7]) };
  });
}
function sharedBoundary(a, e, extracted) {
  if (!extracted || a.instance !== e.instance) return false;
  const source = extracted.blas[extracted.instances.blas[a.instance]];
  const vertexKeys = hit => {
    const triangle = source.primitiveIds.indexOf(hit.primitive);
    if (triangle < 0) return [];
    return [0, 1, 2].map(k => {
      const offset = source.indices[triangle * 3 + k] * 3;
      return [source.positions[offset], source.positions[offset + 1], source.positions[offset + 2]].join(',');
    });
  };
  const av = vertexKeys(a), ev = vertexKeys(e), shared = new Set(av.filter(v => ev.includes(v)));
  if (!shared.size) return false;
  const offShared = (keys, bary) => keys.reduce((sum, key, i) => sum + (shared.has(key) ? 0 : Math.abs(bary[i])), 0);
  return offShared(av, a.bary) <= 1e-4 && offShared(ev, e.bary) <= 1e-4;
}
function compare(actual, expected, { reference = false, extracted = null } = {}) {
  const result = { tested: expected.length, errors: 0, statusMismatch: 0, identityMismatch: 0, facingMismatch: 0,
    distanceMismatch: 0, barycentricMismatch: 0, nonFinite: 0, sharedEdgeTies: 0, maxRelativeTError: 0, maxBarycentricError: 0, examples: [] };
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i], e = expected[i], es = reference ? (e ? 1 : 0) : e.status;
    const example = kind => { if (result.examples.length < 5) result.examples.push({ i, kind, actual: a, expected: e }); };
    if (a.status === 2) { result.errors++; example('error'); }
    if (a.status !== es) { result.statusMismatch++; example('status'); continue; }
    if (a.status !== 1) continue;
    if (![a.t, ...a.bary].every(Number.isFinite)) { result.nonFinite++; example('non-finite'); continue; }
    const dt = Math.abs(a.t - e.t) / Math.max(1, Math.abs(e.t));
    result.maxRelativeTError = Math.max(result.maxRelativeTError, dt);
    if (dt > 2e-5) { result.distanceMismatch++; example('t'); }
    const same = a.instance === e.instance && a.primitive === e.primitive;
    if (!same) {
      const boundary = Math.min(...a.bary) <= 1e-4 && Math.min(...e.bary) <= 1e-4;
      if (dt <= 2e-5 && boundary && sharedBoundary(a, e, extracted)) result.sharedEdgeTies++;
      else { result.identityMismatch++; example('identity'); }
    } else {
      if (a.front !== e.front) { result.facingMismatch++; example('front'); }
      const db = Math.max(...a.bary.map((v, j) => Math.abs(v - e.bary[j])));
      result.maxBarycentricError = Math.max(result.maxBarycentricError, db);
      if (db > 1e-3) { result.barycentricMismatch++; example('bary'); }
    }
  }
  result.passed = ['errors','statusMismatch','identityMismatch','facingMismatch','distanceMismatch','barycentricMismatch','nonFinite'].every(k => result[k] === 0);
  return result;
}
const report = {
  schema: 2,
  baselineChanges: ['Exact parallel-axis slab handling; original failing baseline retained by optional original variant'],
  sourceCommit: 'dbfdffb702bf50c03ed7bd109734946bf146a87b', createdAt: new Date().toISOString(),
  methodology: {
    rayCount, rounds, warmups, selected,
    workloadRevision: '2026-10-17-restored-v2; compare only identical ray and geometry hashes within this report',
    timing: 'Timestamp-query around one isolated nearest-hit compute pass; compilation, scene build, warmups and readback excluded.',
    ordering: 'Each round rotates variants and reverses every second round; one untimed warm dispatch precedes every sample; paired baseline ratios retained. Interleaved, not fully position-balanced.',
    instrumentation: 'Work counters and stack peak are measured in a separate untimed pipeline.',
    scope: 'Static scene geometry, deterministic diagnostic and camera/aperture rays. No complete-render or actual lens-exit-ray speedup claim.',
    thresholds: { relativeT: 2e-5, barycentric: 1e-3, sameInstanceSharedTopologyBoundaryTie: 1e-4 },
  }, workloads: [], errors: [], passed: false,
};
function publish() { window.__bvhBenchmark = report; out.textContent = JSON.stringify(report, null, 2); }
document.querySelector('#download').addEventListener('click', () => {
  const link = document.createElement('a'), url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  link.href = url; link.download = 'bvh-benchmark.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});

let device;
try {
  if (!navigator.gpu) throw new Error('WebGPU unavailable in this browser');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter');
  const info = adapter.info ?? await adapter.requestAdapterInfo();
  const hasTimestamp = adapter.features.has('timestamp-query');
  if (!hasTimestamp) report.methodology.timing = 'Timestamp-query unavailable; GPU timings and speedups remain null. Only submit-to-completion wall times and correctness are recorded.';
  if (adapter.limits.maxStorageBuffersPerShaderStage < 6) throw new Error('At least six storage buffers are required');
  device = await adapter.requestDevice({
    requiredFeatures: hasTimestamp ? ['timestamp-query'] : [],
    requiredLimits: { maxStorageBuffersPerShaderStage: 6, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize },
  });
  device.addEventListener('uncapturederror', e => { report.errors.push(e.error.message); step('GPU error: ' + e.error.message); });
  device.lost.then(x => { if (x.reason !== 'destroyed') report.errors.push('Device lost: ' + x.message); });
  report.environment = { userAgent: navigator.userAgent, adapter: { vendor: info.vendor, architecture: info.architecture,
    device: info.device, description: info.description, isFallbackAdapter: info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null },
    timestampQuery: hasTimestamp, limits: { storageBufferBytes: device.limits.maxStorageBufferBindingSize, storageBuffers: device.limits.maxStorageBuffersPerShaderStage } };
  report.environment.label = q.get('label');
  report.environment.software = /swiftshader|llvmpipe|software/i.test(JSON.stringify(report.environment.adapter)) || report.environment.adapter.isFallbackAdapter === true;
  report.environment.performanceAppliesTo = report.environment.software ? 'This software adapter only; no physical-GPU performance conclusion.' : 'This browser and adapter only.';
  if (q.get('hardware') === '1' && report.environment.software) throw new Error('Hardware run requested but software adapter selected');
  publish();

  function storage(data, label) {
    const buffer = device.createBuffer({ label, size: Math.max(4, data.byteLength ?? data), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    if (typeof data !== 'number') device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  }
  async function compile(source, label, instrumented) {
    const started = performance.now();
    device.pushErrorScope('validation');
    const module = device.createShaderModule({ label, code: kernel(source, instrumented) });
    const messages = (await module.getCompilationInfo()).messages.filter(m => m.type === 'error');
    if (messages.length) throw new Error(label + ': ' + messages.map(m => m.message).join('\n'));
    const pipeline = await device.createComputePipelineAsync({ label, layout: 'auto', compute: { module, entryPoint: 'main' } });
    const error = await device.popErrorScope(); if (error) throw new Error(label + ': ' + error.message);
    return { pipeline, ms: performance.now() - started };
  }
  async function readMany(buffers) {
    const encoder = device.createCommandEncoder(), staging = buffers.map(b => device.createBuffer({ size: b.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
    buffers.forEach((b, i) => encoder.copyBufferToBuffer(b, 0, staging[i], 0, b.size));
    device.queue.submit([encoder.finish()]);
    const result = [];
    for (const b of staging) { await b.mapAsync(GPUMapMode.READ); result.push(b.getMappedRange().slice(0)); b.unmap(); b.destroy(); }
    return result;
  }
  const query = hasTimestamp ? device.createQuerySet({ type: 'timestamp', count: 2 }) : null;
  const queryResolve = hasTimestamp ? device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : null;
  const queryRead = hasTimestamp ? device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }) : null;
  async function dispatch(pipeline, group, n, timed = false) {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass(timed && query ? { timestampWrites: { querySet: query, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {});
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(n / 64)); pass.end();
    if (timed && query) { encoder.resolveQuerySet(query, 0, 2, queryResolve, 0); encoder.copyBufferToBuffer(queryResolve, 0, queryRead, 0, 16); }
    const started = performance.now(); device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone();
    const wallMs = performance.now() - started;
    let gpuMs = null;
    if (timed && query) { await queryRead.mapAsync(GPUMapMode.READ); const times = new BigUint64Array(queryRead.getMappedRange()); gpuMs = Number(times[1] - times[0]) / 1e6; queryRead.unmap(); }
    return { gpuMs, wallMs };
  }

  for (const workloadName of names) {
    step('Preparing ' + workloadName);
    const workload = await loadBvhWorkload(workloadName, { rayCount }), n = workload.rays.length / 8;
    const result = { name: workloadName, rays: n, rayHashFNV1a: hash(workload.rays), metadata: workload.metadata,
      baselineBvh: workload.packed.stats, baselineBufferHashesFNV1a: { nodes: hash(workload.packed.nodes), triangles: hash(workload.packed.triangles), instances: hash(workload.packed.instances) }, variants: [], rounds: [] };
    report.workloads.push(result); publish();
    const rays = storage(workload.rays, 'Fixed benchmark rays'), hits = storage(n * 32, 'Benchmark hits'), metrics = storage(n * 32, 'Untimed traversal metrics');
    const dataPacks = new Map(), compiled = new Map(), variants = [];
    let baselineHits;
    for (const name of selected) {
      const leafMatch = /^leaf(2|8)(?:\+(.*))?$/.exec(name), leaf = leafMatch ? Number(leafMatch[1]) : 4;
      const requestedShader = leafMatch ? (leafMatch[2] || 'baseline') : name;
      const shaderName = requestedShader === 'stack-proved' ? 'stack-size' : requestedShader;
      if (!dataPacks.has(leaf)) {
        const packed = leaf === 4 ? workload.packed : buildLeafSizeVariant(workload.extracted, { maxLeaf: leaf });
        dataPacks.set(leaf, { packed, provedStackCapacity: provePackedStackCapacity(packed), buffers: [storage(packed.nodes, 'Nodes leaf' + leaf), storage(packed.instances, 'Instances'), storage(packed.triangles, 'Triangles')] });
      }
      const data = dataPacks.get(leaf), packed = data.packed;
      if (!(packed.stats.stackBound <= 64)) throw new Error('Scene exceeds validated 64-entry stack');
      const stackSize = ['stack-proved', 'fast-combined'].includes(requestedShader) ? data.provedStackCapacity : packed.stats.stackBound;
      const usesStack = ['stack-size', 'combined', 'fast-combined'].includes(shaderName);
      const source = buildBvhVariant(intersector, { name: shaderName, stackSize });
      const key = shaderName + ':' + (usesStack ? stackSize : 64);
      if (!compiled.has(key)) compiled.set(key, { timed: await compile(source, name, false), instrumented: await compile(source, name + ' metrics', true) });
      const pipelines = compiled.get(key);
      const makeGroup = (pipeline, countMetrics) => device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
        entries: [rays, hits, ...data.buffers, ...(countMetrics ? [metrics] : [])].map((buffer, binding) => ({ binding, resource: { buffer } })) });
      const group = makeGroup(pipelines.timed.pipeline, false), metricGroup = makeGroup(pipelines.instrumented.pipeline, true);
      step(workloadName + ' validate ' + name);
      await dispatch(pipelines.instrumented.pipeline, metricGroup, n);
      const [rawHits, rawMetrics] = await readMany([hits, metrics]), records = hitRecords(rawHits, packed), m = new Uint32Array(rawMetrics);
      if (name === 'baseline') baselineHits = records;
      const totals = [0, 0, 0, 0]; let peakStack = 0, tlasBoxes = 0, blasBoxes = 0;
      for (let i = 0; i < n; i++) { for (let j = 0; j < 4; j++) totals[j] += m[i * 8 + j]; peakStack = Math.max(peakStack, m[i * 8 + 4]); tlasBoxes += m[i * 8 + 5]; blasBoxes += m[i * 8 + 6]; }
      const row = { name, shaderName, leafTarget: leaf, stackCapacity: usesStack ? stackSize : 64, provedStackCapacity: data.provedStackCapacity,
        bvh: packed.stats, compileMs: pipelines.timed.ms, correctness: compare(records, baselineHits, { extracted: workload.extracted }),
        reference: workload.referenceRays ? compare(records, workload.referenceRays, { reference: true, extracted: workload.extracted }) : null,
        observed: { visitsPerRay: totals[0] / n, boxesPerRay: totals[1] / n, trianglesPerRay: totals[2] / n, instancesPerRay: totals[3] / n,
          peakStack, tlasBoxesPerRay: tlasBoxes / n, blasBoxesPerRay: blasBoxes / n, found: records.filter(h => h.status === 1).length, traversalErrors: records.filter(h => h.status === 2).length },
        rawGpuMs: [], rawWallMs: [] };
      row.correctness.passed &&= row.observed.traversalErrors === 0;
      result.variants.push(row); variants.push({ row, pipeline: pipelines.timed.pipeline, group });
      await dispatch(pipelines.timed.pipeline, group, n);
      const [timedHits] = await readMany([hits]); const timedRecords = hitRecords(timedHits, packed);
      row.uninstrumentedCorrectness = compare(timedRecords, baselineHits, { extracted: workload.extracted });
      if (workload.referenceRays) row.uninstrumentedReference = compare(timedRecords, workload.referenceRays, { reference: true, extracted: workload.extracted });
      for (let i = 0; i < warmups; i++) await dispatch(pipelines.timed.pipeline, group, n);
      publish();
    }
    for (let round = 0; round < rounds; round++) {
      const offset = round % variants.length, order = [...variants.slice(offset), ...variants.slice(0, offset)];
      if (round % 2) order.reverse();
      const samples = {};
      for (const v of order) {
        await dispatch(v.pipeline, v.group, n);
        const measurement = await dispatch(v.pipeline, v.group, n, true);
        v.row.rawWallMs.push(measurement.wallMs);
        if (measurement.gpuMs != null) v.row.rawGpuMs.push(measurement.gpuMs);
        samples[v.row.name] = measurement;
      }
      result.rounds.push({ round, order: order.map(v => v.row.name), samples });
      step(workloadName + ' measured round ' + (round + 1) + '/' + rounds); publish();
    }
    const baseline = result.variants[0];
    for (const row of result.variants) {
      row.gpuMs = row.rawGpuMs.length ? distribution(row.rawGpuMs) : null;
      row.wallMs = distribution(row.rawWallMs);
      row.medianSpeedup = row.gpuMs ? distribution(baseline.rawGpuMs).median / row.gpuMs.median : null;
      row.pairedSpeedup = row.rawGpuMs.length ? distribution(row.rawGpuMs.map((ms, i) => baseline.rawGpuMs[i] / ms)) : null;
      row.timeSavedPercent = row.medianSpeedup ? 100 * (1 - 1 / row.medianSpeedup) : null;
      row.passed = row.correctness.passed && row.uninstrumentedCorrectness.passed
        && (!row.reference || row.reference.passed) && (!row.uninstrumentedReference || row.uninstrumentedReference.passed);
    }
    rays.destroy(); hits.destroy(); metrics.destroy();
    for (const data of dataPacks.values()) for (const buffer of data.buffers) buffer.destroy();
    publish();
  }
  query?.destroy(); queryResolve?.destroy(); queryRead?.destroy();
  report.passed = report.errors.length === 0 && report.workloads.every(w => w.variants.every(v => v.passed));
  step('Completed: ' + (report.passed ? 'all correctness checks passed' : 'some experimental variants failed correctness checks'));
} catch (error) {
  report.errors.push(error.stack || String(error)); step('Stopped: ' + error.message);
} finally {
  publish(); document.body.dataset.passed = String(report.passed);
  device?.destroy();
}
