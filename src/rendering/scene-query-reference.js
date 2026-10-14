/** f64 test reference for the bounded, single-layer GPU radiance query.
 * Coordinates: world metres, WebGPU clip z=0..1, texture row zero at top.
 * Projective stepping follows McGuire/Mara, JCGT 3(4), 2014;
 * this implementation uses bounded secant refinement of a depth slab.
 * This module is a test oracle, never a user-facing rendering backend.
 */
export const SCENE_HIT = 4;
export const SCENE_BACKGROUND = 5;
export const SCENE_CACHE_MISS = 6;
const mul = (m, v) => [0, 1, 2, 3].map(r => m[r] * v[0] + m[r + 4] * v[1] + m[r + 8] * v[2] + m[r + 12] * v[3]);
const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
export function directionalEnvironment(direction, sky) {
  const y = direction[1];
  return y >= 0 ? mix(sky.horizon, sky.zenith, Math.sqrt(Math.min(1, y)))
    : mix(sky.horizon, sky.ground, Math.sqrt(Math.min(1, -y)));
}
export function projectWorld(point, worldToClip) {
  const c = mul(worldToClip, [...point, 1]);
  return { uv: [c[0] / c[3] * .5 + .5, .5 - c[1] / c[3] * .5], depth: c[2] / c[3], clip: c };
}
export function querySceneReference(origin, direction, cache) {
  const { width, height, worldToClip, clipToWorld, worldToView, depth, color } = cache;
  const sky = cache.sky ?? { zenith: [.2, .3, .5], horizon: [.5, .5, .5], ground: [.05, .04, .03] };
  const thickness = cache.thickness ?? .03;
  const maxDistance = cache.maxDistance ?? 500;
  const maxSteps = Math.min(128, Math.max(1, cache.maxSteps ?? 128));
  const stepPixels = Math.max(.5, cache.stepPixels ?? 1);
  const magnitude = Math.hypot(...direction);
  const validDirection = Number.isFinite(magnitude) && magnitude >= 1e-10;
  const env = validDirection ? directionalEnvironment(direction.map(x => x / magnitude), sky) : [...sky.horizon];
  let visited = 0;
  const result = (status, position = origin, rgb = env) => ({ status, position, rgb, visited });
  if (!origin.every(Number.isFinite) || !Number.isFinite(magnitude) || magnitude < 1e-10) return result(SCENE_CACHE_MISS, [0, 0, 0]);
  const d = direction.map(x => x / magnitude);
  const endpoint = origin.map((x, i) => x + maxDistance * d[i]);
  const c0 = mul(worldToClip, [...origin, 1]), c1 = mul(worldToClip, [...endpoint, 1]);
  // Homogeneous clipping retains actual ray origin displacement.
  const planes = c => [c[0] + c[3], c[3] - c[0], c[1] + c[3], c[3] - c[1], c[2], c[3] - c[2], c[3] - 1e-6];
  const f0 = planes(c0), f1 = planes(c1);
  let lo = 0, hi = 1, clippedSide = false;
  for (let i = 0; i < 7; i++) {
    if (f0[i] < 0 && f1[i] < 0) return result(SCENE_CACHE_MISS);
    if (f0[i] < 0 || f1[i] < 0) {
      const t = f0[i] / (f0[i] - f1[i]);
      if (f0[i] < 0) lo = Math.max(lo, t);
      else if (t < hi) { hi = t; clippedSide = i < 4; }
    }
  }
  if (hi <= lo) return result(SCENE_CACHE_MISS);
  // The texture domain is half-open. A clipped side-plane intersection lies
  // exactly on UV=0/1, and roundoff can put it just outside. Advance the SAME
  // ray by a scale-aware f32 numerical inset; never clamp its projected UV.
  const entry = mix(origin, endpoint, lo);
  const insetM = 32 * 2 ** -23 * Math.max(1, Math.hypot(...origin), Math.hypot(...entry));
  const insetT = Math.min((hi - lo) * .0001, insetM / maxDistance);
  if (lo > 0) lo += insetT;
  if (hi < 1) hi -= insetT;
  const a = mix(origin, endpoint, lo), b = mix(origin, endpoint, hi);
  const ca = mul(worldToClip, [...a, 1]), cb = mul(worldToClip, [...b, 1]);
  const ka = 1 / ca[3], kb = 1 / cb[3];
  const qa = a.map(x => x * ka), qb = b.map(x => x * kb);
  const pa = projectWorld(a, worldToClip).uv, pb = projectWorld(b, worldToClip).uv;
  const length = Math.max(Math.abs((pb[0] - pa[0]) * width), Math.abs((pb[1] - pa[1]) * height));
  const steps = Math.min(maxSteps, Math.max(1, Math.ceil(length / stepPixels)));
  const inspect = point => {
    const p = projectWorld(point, worldToClip);
    if (p.uv.some(x => x < 0 || x >= 1)) return null;
    const x = Math.floor(p.uv[0] * width), y = Math.floor(p.uv[1] * height), index = y * width + x;
    const z = depth[index];
    if (!Number.isFinite(z) || z < 0 || z > 1) return null;
    if (z >= 1 - 1e-7) return { background: true, point, gap: -1e30, sceneDepth: 1e30, index, rgb: Array.from(color.slice(index * 4, index * 4 + 3)) };
    const uv = [(x + .5) / width, (y + .5) / height];
    const h = mul(clipToWorld, [uv[0] * 2 - 1, 1 - uv[1] * 2, z, 1]);
    const surface = h.slice(0, 3).map(v => v / h[3]);
    const sceneDepth = -mul(worldToView, [...surface, 1])[2];
    return { background: false, point, gap: -mul(worldToView, [...point, 1])[2] - sceneDepth, sceneDepth, index, surface };
  };
  let previous = inspect(a), seenGeometry = previous && !previous.background;
  if (!previous || previous.gap > thickness) return result(SCENE_CACHE_MISS);
  for (let i = 1; i <= steps; i++) {
    visited++;
    const s = i / steps, q = mix(qa, qb, s), k = ka + (kb - ka) * s;
    const current = inspect(q.map(x => x / k));
    if (!current) return result(SCENE_CACHE_MISS);
    seenGeometry ||= !current.background;
    if (!current.background && current.gap >= 0 && previous.gap <= 0) {
      if (previous.background || Math.abs(previous.sceneDepth - current.sceneDepth) > Math.max(.15, .05 * current.sceneDepth)) return result(SCENE_CACHE_MISS);
      let low = previous, high = current, best = current;
      for (let j = 0; j < 8; j++) {
        const f = Math.max(.001, Math.min(.999, -low.gap / (high.gap - low.gap)));
        const trial = inspect(mix(low.point, high.point, f));
        if (!trial || trial.background || Math.abs(trial.sceneDepth - current.sceneDepth) > Math.max(.15, .05 * current.sceneDepth)) return result(SCENE_CACHE_MISS);
        best = trial;
        if (Math.abs(trial.gap) <= thickness) break;
        if (trial.gap < 0) low = trial; else high = trial;
      }
      if (Math.abs(best.gap) > thickness) return result(SCENE_CACHE_MISS);
      const rgb = color.slice(best.index * 4, best.index * 4 + 3);
      return result(SCENE_HIT, best.point, Array.from(rgb));
    }
    if (!current.background && current.gap > thickness) return result(SCENE_CACHE_MISS);
    previous = current;
  }
  if (!seenGeometry && !clippedSide && previous.background) return result(SCENE_BACKGROUND, b, previous.rgb);
  return result(SCENE_CACHE_MISS, b);
}
