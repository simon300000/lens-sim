import { buildSceneBuffers } from './bvh-builder.js';
import { expandInstances } from './instance-expand.js';
import { normalizeBlasSource, normalizeInstances } from './scene-source.js';

/** Scene source -> packed GPU buffer images, keeping BLAS sources and builds
 * by key so instance-only changes rebuild just the TLAS. Pure JavaScript: the
 * same object runs in the BVH Worker (bvh-worker.js) and inline (Node, or
 * hosts without workers).
 *   build({ blas, instances, origin }) -> { packed, instances, expandReport, blasInfo }
 * blas entries without positions refer to the source cached under their key. */
export function createSceneBuilder() {
  const sourceCache = new Map(), blasCache = new Map();
  return {
    get keys() { return [...sourceCache.keys()]; },
    build({ blas, instances, origin = null }) {
      const started = Date.now();
      for (const entry of blas) if (entry.positions) {
        sourceCache.set(entry.key, normalizeBlasSource(entry));
        blasCache.delete(entry.key);
      }
      const blasKeys = blas.map(entry => entry.key);
      const blasSources = blasKeys.map(key => {
        const source = sourceCache.get(key);
        if (!source) throw new Error('Scene builder has no BLAS source ' + key);
        return source;
      });
      // Drop sources/builds no longer referenced by the current scene.
      const live = new Set(blasKeys);
      for (const key of [...sourceCache.keys()]) if (!live.has(key)) { sourceCache.delete(key); blasCache.delete(key); }
      const normalizeMs = Date.now() - started;
      const expandStarted = Date.now();
      const expanded = expandInstances(normalizeInstances(instances), blasSources.map(s => s.bounds), blasSources.map(s => s.points ?? null), origin);
      const expandMs = Date.now() - expandStarted;
      const packed = buildSceneBuffers({ blasSources, blasKeys, instances: expanded.instances, blasCache });
      Object.assign(packed.stats.timing, { expandMs, normalizeMs });
      const blasInfo = blasSources.map(s => ({ key: s.key, triangleCount: s.triangleCount, vertexCount: s.vertexCount, bounds: s.bounds, hasNormal: s.hasNormal, hasUV: s.hasUV, hasColor: s.hasColor }));
      return { packed, instances: expanded.instances, expandReport: expanded.report, blasInfo };
    },
    dispose() { sourceCache.clear(); blasCache.clear(); },
  };
}

/** Transferable buffers of a build result (worker -> main thread). */
export function buildTransfers({ packed, instances: i }) {
  return [packed.nodes, packed.triangles, packed.vertices, packed.instances, packed.instanceOrder.buffer,
    ...[i.w2o, i.frame, i.blas, i.material, i.flags, i.color, i.object, i.instance, i.bounds].map(a => a.buffer)];
}
