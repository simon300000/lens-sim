import intersectorSource from './scene-intersector.wgsl.js';
import workCountersSource from './work-counters.wgsl.js';
import sampleSource from './scene-sample.wgsl.js';
import surfaceSource from './scene-surface.wgsl.js';
import rayRadianceSource from './ray-radiance.wgsl.js';
import { normalizeShaderEOL } from './shader-source.js';
export { normalizeShaderEOL };
/** Declares the per-invocation work tallies; prepend once per shader module. */
export const WORK_COUNTERS_WGSL = workCountersSource;
/** Expand the traversal template (see scene-intersector.wgsl): one copy per
 * slab test. FAST_ONLY lines stay only in the fast variant. */
export function expandIntersector(source) {
  const text = normalizeShaderEOL(source);
  const begin = text.indexOf('// TRAVERSAL-TEMPLATE-BEGIN'), end = text.indexOf('// TRAVERSAL-TEMPLATE-END');
  if (begin < 0 || end < 0) throw new Error('scene-intersector.wgsl: traversal template markers missing');
  const template = text.slice(begin, end);
  const variant = (name, fast) => template.replaceAll('_VARIANT', name)
    .replace(/^([ \t]*)\/\/FAST_ONLY: ?(.*)$/gm, fast ? '$1$2' : '');
  return text.slice(0, begin) + variant('Fast', true) + variant('Parallel', false) + text.slice(end);
}
export const SCENE_INTERSECTOR_WGSL = expandIntersector(intersectorSource);
export const SCENE_SAMPLE_WGSL = sampleSource;
/** Surface reconstruction and layered composite alone (for a ray provider that traces the BVH itself). */
export const SCENE_COMPOSITE_WGSL = surfaceSource;
/** Engine half of a surface provider's shading stage (reconstruction + layered composite). */
export const SCENE_SURFACE_WGSL = sampleSource + surfaceSource;
/** Engine half of a ray provider's shading stage (no BVH, no trace stage). */
export const SCENE_RAY_WGSL = sampleSource + rayRadianceSource;
