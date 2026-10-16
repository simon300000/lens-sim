/**
 * Meridional lens layout: element outlines and traced ray bundles for the
 * workbench drawing. Pure geometry (no DOM); drawing conventions follow
 * lens-bench js/optics.js layoutGeometry (GPL-3.0):
 *   - drawn radius: known clear aperture → drawing radius → ray envelope,
 *     widened so traced rays never pass outside a drawn element;
 *   - beyond its own radius a surface continues as a flat mechanical edge;
 *   - adjacent drawn surfaces are clamped so outlines never interpenetrate;
 *   - each field shows the unvignetted meridional pupil: both edges and the chief ray.
 * This is a display aid traced in f64 at the d line, not the GPU renderer.
 */
import { sag, intersectSurface, refract } from '../optics/optical-reference.js';
import { refractiveIndex } from '../optics/glass.js';

const D_LINE = 587.5618;
const SCAN = 161;

function conicLimit(s) {
  if (!s.radiusMm) return Infinity;
  const k = 1 + (s.conic ?? 0);
  return k > 0 ? Math.abs(s.radiusMm) / Math.sqrt(k) * 0.999 : Infinity;
}
/** Sag clamped to the surface's own real domain (no algebraic second branch). */
function safeSag(s, r) {
  const rr = Math.min(Math.abs(r), conicLimit(s));
  const z = sag(s, 0, rr);
  return Number.isFinite(z) ? z : 0;
}

/** Forward meridional trace; returns [z, y] points from origin to the sensor plane, or null if blocked. */
export function traceMeridional(p, origin, direction, { stopRadiusMm = null, wavelengthNm = D_LINE } = {}) {
  let point = [0, origin[1], origin[2]];
  let d = direction;
  const path = [[point[2], point[1]]];
  for (const raw of p.surfaces) {
    const s = raw.index === p.stopIndex && stopRadiusMm !== null ? { ...raw, apertureRadiusMm: stopRadiusMm } : raw;
    const hit = intersectSurface(s, point, d);
    if (hit.status) return null;
    const ni = refractiveIndex(p.glasses[s.mediumBefore], wavelengthNm);
    const nt = refractiveIndex(p.glasses[s.mediumAfter], wavelengthNm);
    const v = refract(d, hit.normal, ni, nt);
    if (!v) return null;
    point = hit.point; d = v;
    path.push([point[2], point[1]]);
  }
  if (!(d[2] > 1e-9)) return null;
  const t = (p.sensorZMm - point[2]) / d[2];
  if (!(t >= 0)) return null;
  path.push([p.sensorZMm, point[1] + d[1] * t]);
  return path;
}

/** Stop-plane height of a traced path (index = stop surface + 1 in the point list). */
const stopHeight = (p, path) => path[p.stopIndex + 1][1];

function launcher(p, fieldRad, lead) {
  const finite = Number.isFinite(p.objectDistanceMm) && p.objectDistanceMm > 0;
  if (finite) {
    const D = p.objectDistanceMm, origin = [0, -D * Math.tan(fieldRad), -D];
    return (y) => {
      const dir = [0, y - origin[1], D];
      const n = Math.hypot(dir[1], dir[2]);
      return [origin, [0, dir[1] / n, dir[2] / n]];
    };
  }
  const dir = [0, Math.sin(fieldRad), Math.cos(fieldRad)];
  // y is the height where the ray crosses the first-vertex plane z = 0.
  return (y) => [[0, y - Math.tan(fieldRad) * lead, -lead], dir];
}

function fieldBundle(p, fieldRad, { lead, span, stopRadiusMm, rays: nRay }) {
  const launch = launcher(p, fieldRad, lead);
  const trace = (y) => { const [o, d] = launch(y); return traceMeridional(p, o, d, { stopRadiusMm }); };
  // Heavily vignetted edge fields can pass through a sliver narrower than the coarse step: densify once.
  let samples = [], passing = [], count = SCAN;
  for (const n of [SCAN, SCAN * 8]) {
    count = n;
    samples = [];
    for (let i = 0; i < n; i++) { const y = -span + (2 * span * i) / (n - 1); samples.push({ y, path: trace(y) }); }
    passing = samples.map((s, i) => (s.path ? i : -1)).filter((i) => i >= 0);
    if (passing.length >= 3) break;
  }
  if (!passing.length) return null;
  // Contiguous passing run around the sample closest to the stop centre (the chief ray).
  let centre = passing[0];
  for (const i of passing) if (Math.abs(stopHeight(p, samples[i].path)) < Math.abs(stopHeight(p, samples[centre].path))) centre = i;
  let lo = centre, hi = centre;
  while (lo > 0 && samples[lo - 1].path) lo--;
  while (hi < count - 1 && samples[hi + 1].path) hi++;
  const refineEdge = (inside, outside) => {
    let a = samples[inside].y, b = samples[outside]?.y ?? a, best = samples[inside];
    if (outside < 0 || outside >= count) return best;
    for (let k = 0; k < 18; k++) {
      const m = (a + b) / 2, path = trace(m);
      if (path) { a = m; best = { y: m, path }; } else b = m;
    }
    return best;
  };
  const low = refineEdge(lo, lo - 1), high = refineEdge(hi, hi + 1);
  // Chief ray: secant on stop height between neighbouring passing samples.
  let chief = samples[centre];
  const neighbour = centre + 1 <= hi ? centre + 1 : centre - 1;
  if (neighbour >= lo && neighbour <= hi && neighbour !== centre) {
    let a = samples[centre], b = samples[neighbour];
    for (let k = 0; k < 12; k++) {
      const ha = stopHeight(p, a.path), hb = stopHeight(p, b.path);
      if (Math.abs(hb - ha) < 1e-12) break;
      const y = b.y - hb * (b.y - a.y) / (hb - ha);
      if (!(y >= low.y && y <= high.y)) break;
      const path = trace(y);
      if (!path) break;
      a = b; b = { y, path };
      if (Math.abs(stopHeight(p, path)) < 1e-7) break;
    }
    chief = Math.abs(stopHeight(p, b.path)) < Math.abs(stopHeight(p, chief.path)) ? b : chief;
  }
  const picks = [low];
  for (let i = 1; i < nRay - 1; i++) {
    if (nRay === 3) { picks.push(chief); continue; }
    const y = low.y + ((high.y - low.y) * i) / (nRay - 1);
    picks.push(i === (nRay - 1) / 2 ? chief : { y, path: trace(y) });
  }
  if (high !== low) picks.push(high);
  const rays = picks.map((r) => r.path).filter(Boolean);
  const imageHeightMm = chief.path.at(-1)[1];
  // Unvignetted pupil span in normalized stop coordinates, as lens-bench labels it.
  const pupil = stopRadiusMm > 0 ? [stopHeight(p, low.path) / stopRadiusMm, stopHeight(p, high.path) / stopRadiusMm] : null;
  return { rays, imageHeightMm, pupil };
}

function profile(s, own, extent, steps = 40) {
  const half = [];
  for (let i = 0; i <= steps; i++) {
    const r = (extent * i) / steps;
    half.push([s.zMm + safeSag(s, Math.min(r, own)), r]);
  }
  const lower = half.slice(1).reverse().map(([z, y]) => [z, -y]);
  return [...lower, ...half];
}

/**
 * @param p slim prescription: surfaces (zMm, radiusMm, conic, aspheric/xodd, apertureRadiusMm, drawRadiusMm,
 *          mediumBefore/After), glasses, stopIndex, stopRadiusMm, sensorZMm, objectDistanceMm, sensorMm
 * @param options focalLengthMm (for the field range), fields (fractions of the image half-diagonal), rays per field
 */
export function computeLensLayout(p, { focalLengthMm, fields = [0, 0.7, 1], rays = 3 } = {}) {
  const S = p.surfaces;
  if (!S?.length) throw new Error('没有可绘制的面');
  const sensorMm = p.sensorMm ?? [36, 24];
  const halfDiagonal = Math.hypot(...sensorMm) / 2;
  const lastZ = S.at(-1).zMm;
  const total = Math.max(p.sensorZMm, lastZ) - S[0].zMm;
  const lead = Math.max(total * 0.12, 2);
  const known = S.map((s) => s.apertureRadiusMm ?? s.drawRadiusMm ?? 0);
  const span = Math.max(1.3 * Math.max(...known, p.stopRadiusMm ?? 0, 1), 4);
  const f = Math.abs(focalLengthMm) || total;
  const thetaMax = Math.min(Math.atan(halfDiagonal / f), (80 * Math.PI) / 180);

  const bundles = [];
  for (const [fi, fraction] of fields.entries()) {
    const fieldRad = Math.atan(Math.tan(thetaMax) * fraction);
    const bundle = fieldBundle(p, fieldRad, { lead, span: span + Math.abs(Math.tan(fieldRad)) * total * 0.5, stopRadiusMm: p.stopRadiusMm ?? null, rays });
    bundles.push({ fieldIndex: fi, fraction, fieldDeg: (fieldRad * 180) / Math.PI, ...(bundle ?? { rays: [], imageHeightMm: null, pupil: null }), vignetted: !bundle });
  }

  // Entry segments all start the same distance before the first surface, so steep fields do not stretch the drawing.
  for (const b of bundles) for (const path of b.rays) {
    const [z0, y0] = path[0], [z1, y1] = path[1], length = Math.hypot(z1 - z0, y1 - y0);
    if (length > lead) path[0] = [z1 - ((z1 - z0) * lead) / length, y1 - ((y1 - y0) * lead) / length];
  }
  // Ray envelope per surface (point i+1 of each path lies on surface i).
  const envelope = S.map(() => 0);
  for (const b of bundles) for (const path of b.rays) for (let i = 0; i < S.length; i++) envelope[i] = Math.max(envelope[i], Math.abs(path[i + 1][1]));
  const isGlass = (i) => S[i] && S[i].mediumAfter !== 'air';
  const drawn = (i) => isGlass(i) || (i > 0 && isGlass(i - 1));
  const draw = S.map((s, i) => {
    if (s.apertureRadiusMm) return s.apertureRadiusMm;
    if (s.drawRadiusMm) return Math.max(s.drawRadiusMm, envelope[i] * 1.002);
    return Math.max(envelope[i] * 1.06, (p.stopRadiusMm ?? 1) * 0.3);
  }).map((r, i) => Math.min(r, conicLimit(S[i])));
  // Clamp neighbouring drawn surfaces so no outline crosses its neighbour (flat edges included).
  const order = S.map((_, i) => i).filter(drawn);
  const extentOf = (j) => Math.max(draw[j], isGlass(j) && j + 1 < S.length ? draw[j + 1] : 0, j > 0 && isGlass(j - 1) ? draw[j - 1] : 0);
  for (let k = 0; k + 1 < order.length; k++) {
    const a = order[k], b = order[k + 1];
    if (isGlass(a) && b === a + 1) continue; // same element: front and back may meet at the edge
    const A = S[a], B = S[b], eA = extentOf(a), eB = extentOf(b);
    const gap = (r) => (r > eA + 1e-9 || r > eB + 1e-9 ? 1 : B.zMm + safeSag(B, Math.min(r, draw[b])) - (A.zMm + safeSag(A, Math.min(r, draw[a]))));
    const want = Math.max(draw[a], draw[b]);
    if (gap(want) >= 0) continue;
    let lo = 0, hi = want;
    for (let i = 1; i <= 64; i++) { const r = (want * i) / 64; if (gap(r) < 0) { hi = r; lo = (want * (i - 1)) / 64; break; } }
    for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (gap(m) >= 0) lo = m; else hi = m; }
    draw[a] = Math.min(draw[a], lo); draw[b] = Math.min(draw[b], lo);
  }

  const elements = [];
  for (let i = 0; i + 1 < S.length; i++) {
    if (!isGlass(i)) continue;
    const extent = Math.max(draw[i], draw[i + 1]);
    elements.push({ first: i, last: i + 1, front: profile(S[i], draw[i], extent), back: profile(S[i + 1], draw[i + 1], extent),
      cemented: i > 0 && isGlass(i - 1), glass: S[i].material ?? p.glasses?.[S[i].mediumAfter]?.name ?? '' });
  }
  const stopZ = S[p.stopIndex].zMm;
  const stopR = p.stopRadiusMm ?? S[p.stopIndex].apertureRadiusMm ?? draw[p.stopIndex];
  const imageHeight = Math.max(halfDiagonal, ...bundles.map((b) => Math.abs(b.imageHeightMm ?? 0)));

  let minZ = -lead, maxZ = Math.max(p.sensorZMm, lastZ), maxY = Math.max(stopR * 1.45 + 0.5, imageHeight);
  for (const e of elements) for (const [z, y] of [...e.front, ...e.back]) { minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); maxY = Math.max(maxY, Math.abs(y)); }
  for (const b of bundles) for (const path of b.rays) for (const [z, y] of path) { minZ = Math.min(minZ, z); maxY = Math.max(maxY, Math.abs(y)); }
  return {
    elements, bundles, drawRadius: draw,
    stop: { z: stopZ, radius: stopR, index: p.stopIndex },
    sensor: { z: p.sensorZMm, halfHeight: halfDiagonal },
    bounds: { minZ, maxZ, maxY: maxY * 1.06 },
    totalTrackMm: p.sensorZMm - S[0].zMm,
  };
}
