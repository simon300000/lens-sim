import { createSceneBuilder } from '../scene/scene-builder.js';

/** Default BVH worker; bundlers (Vite, webpack/Next) emit it from this literal form. */
export const defaultBVHWorker = () => new Worker(new URL('../scene/bvh-worker.js', import.meta.url), { type: 'module', name: 'lens-bvh' });

/** The worker starts with the first build, so a tracer without a scene spawns none. */
function createWorkerClient(factory) {
  let worker = null, nextId = 0; const pending = new Map();
  const start = () => {
    worker = factory();
    worker.onmessage = ({ data }) => { const p = pending.get(data.id); if (!p) return; pending.delete(data.id); data.ok ? p.resolve(data) : p.reject(new Error(data.error)); };
    worker.onerror = event => { for (const p of pending.values()) p.reject(new Error(event.message || 'BVH worker failed')); pending.clear(); };
  };
  return {
    request(message, transfer = []) { if (!worker) start(); const id = ++nextId; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ ...message, id }, transfer); }); },
    terminate() { worker?.terminate(); for (const p of pending.values()) p.reject(new Error('BVH worker terminated')); pending.clear(); },
  };
}

/** GPU-resident two-level BVH of a scene source (scene/scene-source.js): nodes,
 * instances, triangles and vertex attributes. Framework-free; built off the
 * main thread unless worker === false (or no Worker exists). Builds are
 * serialized; each successful one bumps `revision` (the engine rebinds).
 *   worker: undefined = bundled bvh-worker.js, false = inline, () => Worker = host-provided
 * Per-key BLAS caching: entries sent as { key } reuse the source of an earlier
 * build, so instance/transform-only updates rebuild just the TLAS. */
export function createSceneBVH({ interop, worker: factory } = {}) {
  const { device } = interop;
  const inline = factory === false || (typeof Worker === 'undefined' && !factory);
  const client = inline ? null : createWorkerClient(factory || defaultBVHWorker);
  const builder = inline ? createSceneBuilder() : null;
  const known = new Map();
  let buffers = null, stats = null, revision = 0, disposed = false, queue = Promise.resolve(), origin = null, lastInstances = null;
  const counters = { fullBuilds: 0, tlasRebuilds: 0, blasBuilt: 0, blasReused: 0 };
  const limit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);

  async function build(source, { reason = 'scene', transfer = false } = {}) {
    const started = performance.now();
    const blas = source.blas.map(entry => entry.positions || !known.has(entry.key) ? entry : { key: entry.key });
    const request = { blas, instances: source.instances, origin };
    let result;
    if (client) {
      const transfers = transfer ? blas.filter(e => e.positions).flatMap(e => [e.positions, e.indices, e.normals, e.uvs, e.colors, e.primitiveIds].filter(Boolean).map(a => a.buffer)) : [];
      result = await client.request({ type: 'build', ...request }, [...new Set(transfers)]);
    } else result = builder.build(request);
    if (disposed) return null;
    const { packed } = result;
    const uploadStarted = performance.now();
    const data = { nodes: packed.nodes, instances: packed.instances, triangles: packed.triangles, vertices: packed.vertices };
    for (const [name, values] of Object.entries(data)) {
      if (values.byteLength > limit) throw new Error(`场景 ${name} 缓冲 ${values.byteLength} 字节超出此 GPU 的存储绑定上限 ${limit}`);
    }
    interop.memoryBudget?.assertAdditional(Object.values(data).reduce((n, a) => n + a.byteLength, 0), '新旧 BVH 并存的分配峰值');
    device.pushErrorScope('out-of-memory');
    const next = {}; let allocationError;
    try { for (const [name, values] of Object.entries(data)) next[name] = interop.storage(values, `Lens BVH ${name}`); }
    catch (error) { allocationError = error; }
    const oom = await device.popErrorScope();
    if (allocationError || oom) { for (const b of Object.values(next)) interop.release(b); throw allocationError || new Error('场景 BVH 显存分配失败：' + oom.message); }
    if (buffers) for (const b of Object.values(buffers)) interop.release(b);
    buffers = next;
    known.clear(); for (const info of result.blasInfo) known.set(info.key, info);
    lastInstances = source.instances;
    const t = packed.stats.timing;
    counters.blasBuilt += t.blasRebuilt; counters.blasReused += t.blasReused;
    if (reason === 'tlas') counters.tlasRebuilds++; else counters.fullBuilds++;
    revision++;
    stats = { ...packed.stats, expandReport: result.expandReport, blas: result.blasInfo.length, reason, worker: !!client,
      buildWallMs: uploadStarted - started, uploadSubmitMs: performance.now() - uploadStarted,
      gpuBytes: Object.values(buffers).reduce((s, b) => s + b.size, 0), counters: { ...counters } };
    return { stats, instances: result.instances };
  }
  const bvh = {
    get buffers() { return buffers; }, get stats() { return stats; }, get revision() { return revision; },
    get ready() { return !!buffers; }, get counters() { return { ...counters }; }, get worker() { return !!client; },
    get origin() { return origin ? [...origin] : [0, 0, 0]; },
    /** Info of a BLAS key from the last build ({ triangleCount, bounds, ... }), or undefined. */
    blasInfo(key) { return known.get(key); },
    hasBlas(key) { return known.has(key); },
    /** Build and upload; resolves to { stats, instances } (expanded instance arrays) or null after dispose.
     * transfer: move the new sources' ArrayBuffers to the worker instead of copying them. */
    setScene(source, options) {
      const run = queue.then(() => build(source, options));
      queue = run.catch(() => {});
      return run;
    },
    /** Recentre the world frame (f64 origin subtracted from all transforms); rebuilds the TLAS. */
    setOrigin(next) {
      origin = next && next.some(v => v !== 0) ? [...next] : null;
      if (!lastInstances) return Promise.resolve(null);
      return bvh.setScene({ blas: [...known.keys()].map(key => ({ key })), instances: lastInstances }, { reason: 'tlas' });
    },
    bindings(base) {
      return [{ binding: base, resource: { buffer: buffers.nodes } }, { binding: base + 1, resource: { buffer: buffers.instances } },
        { binding: base + 2, resource: { buffer: buffers.triangles } }, { binding: base + 3, resource: { buffer: buffers.vertices } }];
    },
    dispose() { disposed = true; client?.terminate(); builder?.dispose(); if (buffers) for (const b of Object.values(buffers)) interop.release(b); buffers = null; },
  };
  return bvh;
}
