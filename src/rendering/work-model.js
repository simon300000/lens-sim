/**
 * Arithmetic estimate for the diagnostics HUD.
 *
 * WebGPU exposes no hardware performance counters, so FLOPs are never measured.
 * The fused integrator tallies how often each primitive runs (work-counters.wgsl);
 * each tally is multiplied by a FLOP weight hand-counted from the WGSL below and
 * divided by measured GPU time. Counting convention: add/sub/mul/div/min/max/
 * clamp = 1 per component, fma/mix = 2 (mix 3), sqrt/rsqrt/exp/sin/cos/pow = 1,
 * comparisons, integer hashing and texture fetches = 0. Expect ±30 %: the
 * compiler fuses and eliminates operations, and idle SIMD lanes are not seen.
 */
export const WORK_COUNTERS = Object.freeze([
  // key, FLOPs per event, group, label
  ['path', 110, 'sampling', '路径采样'],          // 5 sample dims, sensor point, pupil proposal, launch weight, camera transform
  ['lensSurface', 115, 'lens', '镜面求交'],        // tolerance, conic quadratic, root check, aperture, 2 LUT indices, Snell + normalize
  ['sag', 18, 'lens', '矢高'],                     // conic sag without polynomial
  ['normal', 27, 'lens', '法线'],                  // conic slope + normalize, without polynomial
  ['polyFlops', 1, 'lens', '非球面多项式'],        // already tallied in FLOPs (Horner 2–3 per term, Bernstein 3·N²/2)
  ['box', 26, 'bvh', 'BVH 包围盒'],               // slab test: 12 + 6 min/max + 7 enter/exit
  ['triangle', 50, 'bvh', '三角形'],               // watertight shear, 3 compensated edge functions, depth
  ['instance', 45, 'bvh', '实例变换'],             // world -> local point/vector, safe inverse, shear setup
  ['shade', 320, 'shading', '着色'],               // reconstruction, material, procedural colour, PMREM/DFG image lighting, fog
  ['light', 95, 'shading', '光源'],                // GGX multi-scatter BRDF, attenuation, irradiance
  ['shadowTap', 14, 'shading', '阴影采样'],        // PCF/Vogel tap arithmetic (the compare fetch itself is 0)
  ['noise', 90, 'shading', '噪声'],                // 3D gradient noise: fades, 8 gradients, trilinear
  ['spectral', 60, 'sampling', '光谱'],            // RGB -> non-negative spectrum -> XYZ for one wavelength
  ['environment', 80, 'shading', '环境'],          // sky / stars / moon (noise octaves counted separately)
]);
export const WORK_GROUPS = Object.freeze({ lens: '镜头', bvh: 'BVH', shading: '着色', sampling: '采样与光谱' });

/** Totals (indexed like WORK_COUNTERS) + measured time -> HUD figures. */
export function summarizeWork(counts, { workUnits, msPerWorkUnit, timing }) {
  const by = Object.fromEntries(WORK_COUNTERS.map(([key], i) => [key, counts[i] ?? 0]));
  const groups = Object.fromEntries(Object.keys(WORK_GROUPS).map((g) => [g, 0]));
  let flops = 0;
  WORK_COUNTERS.forEach(([, weight, group], i) => { const f = (counts[i] ?? 0) * weight; groups[group] += f; flops += f; });
  const paths = Math.max(1, by.path);
  const seconds = workUnits > 0 && msPerWorkUnit > 0 ? (workUnits * msPerWorkUnit) / 1000 : null;
  return {
    gflops: seconds ? flops / seconds / 1e9 : null,
    flopsPerPath: flops / paths,
    share: Object.fromEntries(Object.entries(groups).map(([g, f]) => [g, flops > 0 ? f / flops : 0])),
    perPath: {
      lensSurfaces: by.lensSurface / paths,
      sagEvaluations: (by.sag + by.normal) / paths,
      boxes: by.box / paths,
      triangles: by.triangle / paths,
      lights: by.light / Math.max(1, by.shade),
    },
    paths: by.path, timing, sampleSeconds: seconds,
  };
}
