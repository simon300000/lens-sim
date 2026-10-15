import { buildSceneBuffers } from './bvh-builder.js';
import { expandInstances } from './instance-expand.js';

/** Off-main-thread BVH construction. Keeps BLAS builds and their sources by
 * key so instance-only changes rebuild just the TLAS. Input arrays were
 * copied from Three on the main thread; outputs are transferred back. */
const blasCache = new Map(), sourceCache = new Map();
self.onmessage = ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'dispose') { blasCache.clear(); sourceCache.clear(); self.postMessage({ id, ok: true }); return; }
    if (type !== 'build') throw new Error('Unknown BVH worker request: ' + type);
    for (const [key, source] of data.newSources) sourceCache.set(key, source);
    const blasSources = data.blasKeys.map(key => {
      const source = sourceCache.get(key);
      if (!source) throw new Error('BVH worker missing BLAS source ' + key);
      return source;
    });
    // Drop sources/builds no longer referenced by the current scene.
    const live = new Set(data.blasKeys);
    for (const key of [...sourceCache.keys()]) if (!live.has(key)) { sourceCache.delete(key); blasCache.delete(key); }
    const started = Date.now();
    const expanded = data.instances ? { instances: data.instances, report: null } : expandInstances(data.instanceSources, data.blasBounds);
    const expandMs = Date.now() - started;
    const packed = buildSceneBuffers({ blasSources, blasKeys: data.blasKeys, instances: expanded.instances, blasCache });
    packed.stats.timing.expandMs = expandMs;
    const i = expanded.instances;
    self.postMessage({ id, ok: true, packed, instances: i, expandReport: expanded.report },
      [packed.nodes, packed.triangles, packed.vertices, packed.instances, packed.instanceOrder.buffer,
        ...[i.w2o, i.frame, i.blas, i.material, i.flags, i.color, i.object, i.instance, i.bounds].map(a => a.buffer)]);
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.stack || error) });
  }
};
