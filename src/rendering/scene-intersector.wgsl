// SceneIntersector: nearest-hit query against the registered scene triangles.
// Portable WebGPU compute traversal (no hardware ray query is assumed).
// The host declares sceneNodes, sceneInstances and sceneTriangles bindings.
// Coordinates: world metres. The instance-local ray keeps the UNNORMALIZED
// transformed direction, so t is identical in world and local space.
// Triangle test: watertight ray/triangle (Woop, Benthin, Wald, JCGT 2(1), 2013),
// independently written; boxes are stored rounded outward and the slab exit
// is enlarged by 2*gamma(3) (Ize, JCGT 2(2), 2013) so shared edges are closed.
struct BvhNode { lo: vec3f, a: u32, hi: vec3f, b: u32 }
struct SceneInstance {
  w2o0: vec4f, w2o1: vec4f, w2o2: vec4f,       // world -> geometry (row-major 3x4)
  frame0: vec4f, frame1: vec4f, frame2: vec4f, // geometry -> TSL positionLocal (instanceMatrix or identity)
  info: vec4u,                                 // BLAS root node, material, flags, source record
  color: vec4f,                                // instance colour (1 if absent)
}
struct SceneTriangle { p0: vec3f, i0: u32, p1: vec3f, i1: u32, p2: vec3f, i2: u32, prim: u32, blas: u32, pad0: u32, pad1: u32 }

const SCENE_STACK_SIZE: u32 = 64u;            // == STACK_SIZE in bvh-builder.js
const SCENE_MAX_NODE_VISITS: u32 = 1048576u;  // safety bound; exceeding is an error, never background
const SCENE_LEAF_BIT: u32 = 0x80000000u;
const SCENE_MAX_LEAF: u32 = 16u;              // builder writes <= 4; larger means corruption
const SCENE_NO_HIT: f32 = 3.0e38;
const HIT_NONE: u32 = 0u;
const HIT_FOUND: u32 = 1u;
const HIT_ERROR: u32 = 2u;
// Error codes accompanying HIT_ERROR.
const BVH_ERR_RAY: u32 = 1u;
const BVH_ERR_STACK: u32 = 2u;
const BVH_ERR_NODE: u32 = 3u;
const BVH_ERR_VISITS: u32 = 4u;
const BVH_ERR_INSTANCE: u32 = 5u;
const BVH_ERR_TRIANGLE: u32 = 6u;
const SIDE_FRONT: u32 = 0u;
const SIDE_BACK: u32 = 1u;
const SIDE_DOUBLE: u32 = 2u;
const INSTANCE_SIDE_MASK: u32 = 3u;
const INSTANCE_RECEIVE_SHADOW: u32 = 4u;
const INSTANCE_TRANSPARENT: u32 = 8u;
const INSTANCE_UNSUPPORTED: u32 = 16u;
const INSTANCE_VERTEX_COLOR: u32 = 32u;
const INSTANCE_COLOR: u32 = 64u;

struct SceneHit {
  t: f32, b1: f32, b2: f32,          // barycentric weights of p1 and p2
  instance: u32, triangle: u32, status: u32, error: u32,
  front: bool, visits: u32,
}

// Loop bound the compiler cannot prove constant (the node array is never
// empty for a built scene), so heavy loop bodies such as transparency layers
// are not fully unrolled into many copies of traversal + shading.
fn sceneRuntimeBound(n: u32) -> u32 { return select(n, n + 1u, arrayLength(&sceneNodes) == 0u); }
fn sceneFinite3(v: vec3f) -> bool { return all(abs(v) < vec3f(1e30)); }
fn sceneLocalPoint(I: SceneInstance, p: vec3f) -> vec3f {
  return vec3f(dot(I.w2o0.xyz, p) + I.w2o0.w, dot(I.w2o1.xyz, p) + I.w2o1.w, dot(I.w2o2.xyz, p) + I.w2o2.w);
}
fn sceneLocalVector(I: SceneInstance, v: vec3f) -> vec3f {
  return vec3f(dot(I.w2o0.xyz, v), dot(I.w2o1.xyz, v), dot(I.w2o2.xyz, v));
}
// Inverse-transpose normal: n_world = (W2O)^T n_local.
fn sceneWorldNormal(I: SceneInstance, n: vec3f) -> vec3f {
  return I.w2o0.xyz * n.x + I.w2o1.xyz * n.y + I.w2o2.xyz * n.z;
}
fn sceneSafeInverse(d: vec3f) -> vec3f {
  // A zero component becomes +-1e-30 so 1/d stays finite and (bound-o)*inv
  // never forms 0*inf; it does not change the ray.
  let tiny = select(vec3f(1e-30), vec3f(-1e-30), d < vec3f(0.0));
  return 1.0 / select(d, tiny, abs(d) < vec3f(1e-30));
}
fn sceneBox(n: BvhNode, o: vec3f, inv: vec3f, tMin: f32, tMax: f32) -> f32 {
  let t0 = (n.lo - o) * inv;
  let t1 = (n.hi - o) * inv;
  let tn = min(t0, t1);
  let tf = max(t0, t1);
  let enter = max(max(tn.x, tn.y), max(tn.z, tMin));
  let exit = min(min(tf.x, tf.y), min(tf.z, tMax)) * 1.0000004;
  return select(SCENE_NO_HIT, enter, enter <= exit);
}

struct WatertightRay { o: vec3f, kx: u32, ky: u32, kz: u32, s: vec3f }
// Compensated difference of products keeps shared-edge tests antisymmetric
// even when Metal contracts multiply/subtract into FMA. A plain a*b-c*d can
// round the same edge negative in BOTH adjoining triangles, opening a hole at
// the exact chart centre. No epsilon enlargement or false outside hits.
// https://pharr.org/matt/blog/2019/11/03/difference-of-floats
fn sceneDifferenceOfProducts(a:f32,b:f32,c:f32,d:f32)->f32 {
  let cd=c*d;
  let error=fma(-c,d,cd);
  let difference=fma(a,b,-cd);
  return difference+error;
}
fn sceneWatertight(o: vec3f, d: vec3f) -> WatertightRay {
  let a = abs(d);
  var kz = 0u;
  if (a.y > a.x) { kz = 1u; }
  if (a.z > a[kz]) { kz = 2u; }
  var kx = (kz + 1u) % 3u;
  var ky = (kx + 1u) % 3u;
  if (d[kz] < 0.0) { let t = kx; kx = ky; ky = t; }
  return WatertightRay(o, kx, ky, kz, vec3f(d[kx] / d[kz], d[ky] / d[kz], 1.0 / d[kz]));
}
// Returns (t, w0, w1, w2) with t = SCENE_NO_HIT on a miss.
fn sceneTriangle(r: WatertightRay, p0: vec3f, p1: vec3f, p2: vec3f, tMin: f32, tMax: f32) -> vec4f {
  let A = p0 - r.o; let B = p1 - r.o; let C = p2 - r.o;
  let ax = A[r.kx] - r.s.x * A[r.kz]; let ay = A[r.ky] - r.s.y * A[r.kz];
  let bx = B[r.kx] - r.s.x * B[r.kz]; let by = B[r.ky] - r.s.y * B[r.kz];
  let cx = C[r.kx] - r.s.x * C[r.kz]; let cy = C[r.ky] - r.s.y * C[r.kz];
  let u = sceneDifferenceOfProducts(cx,by,cy,bx);
  let v = sceneDifferenceOfProducts(ax,cy,ay,cx);
  let w = sceneDifferenceOfProducts(bx,ay,by,ax);
  let miss = vec4f(SCENE_NO_HIT, 0.0, 0.0, 0.0);
  if ((u < 0.0 || v < 0.0 || w < 0.0) && (u > 0.0 || v > 0.0 || w > 0.0)) { return miss; }
  let det = u + v + w;
  if (det == 0.0 || !(abs(det) < 1e30)) { return miss; }
  let t = (u * r.s.z * A[r.kz] + v * r.s.z * B[r.kz] + w * r.s.z * C[r.kz]) / det;
  if (!(t > tMin && t < tMax)) { return miss; }
  return vec4f(t, u / det, v / det, w / det);
}

fn sceneAcceptsFace(flags: u32, front: bool) -> bool {
  let side = flags & INSTANCE_SIDE_MASK;
  return side == SIDE_DOUBLE || ((side == SIDE_FRONT) == front);
}

fn sceneError(hit: SceneHit, code: u32, visits: u32) -> SceneHit {
  var h = hit; h.status = HIT_ERROR; h.error = code; h.visits = visits; return h;
}

/// Nearest accepted surface with t in (tMin, tMax). Never stops at the first
/// candidate; all overlapping subtrees are visited until they are farther.
fn sceneIntersect(originW: vec3f, dirW: vec3f, tMin: f32, tMax: f32) -> SceneHit {
  var hit: SceneHit;
  hit.t = tMax; hit.status = HIT_NONE;
  if (!sceneFinite3(originW) || !sceneFinite3(dirW) || !(dot(dirW, dirW) > 1e-24) || !(tMin >= 0.0) || !(tMax > tMin)) {
    return sceneError(hit, BVH_ERR_RAY, 0u);
  }
  let nodeCount = arrayLength(&sceneNodes);
  let instanceCount = arrayLength(&sceneInstances);
  let triangleCount = arrayLength(&sceneTriangles);
  let invW = sceneSafeInverse(dirW);
  var stackNode: array<u32, SCENE_STACK_SIZE>;
  var stackT: array<f32, SCENE_STACK_SIZE>;
  var sp = 0u;
  var o = originW; var d = dirW; var inv = invW;
  var ray = sceneWatertight(originW, dirW);
  var inBlas = false; var blasBase = 0u; var instance = 0u; var flags = 0u;
  var visits = 0u;
  if (sceneBox(sceneNodes[0], o, inv, tMin, hit.t) >= SCENE_NO_HIT) { return hit; }
  var node = 0u;
  loop {
    visits++;
    if (visits > SCENE_MAX_NODE_VISITS) { return sceneError(hit, BVH_ERR_VISITS, visits); }
    if (node >= nodeCount) { return sceneError(hit, BVH_ERR_NODE, visits); }
    let n = sceneNodes[node];
    var next = 0xffffffffu;
    if ((n.b & SCENE_LEAF_BIT) != 0u) {
      let count = n.b & ~SCENE_LEAF_BIT;
      if (!inBlas) {
        if (count != 1u || n.a >= instanceCount) { return sceneError(hit, BVH_ERR_INSTANCE, visits); }
        let I = sceneInstances[n.a];
        let lo = sceneLocalPoint(I, originW);
        let ld = sceneLocalVector(I, dirW);
        if (!sceneFinite3(lo) || !sceneFinite3(ld) || !(dot(ld, ld) > 0.0)) { return sceneError(hit, BVH_ERR_RAY, visits); }
        let root = I.info.x;
        if (root >= nodeCount) { return sceneError(hit, BVH_ERR_NODE, visits); }
        let linv = sceneSafeInverse(ld);
        if (sceneBox(sceneNodes[root], lo, linv, tMin, hit.t) < SCENE_NO_HIT) {
          inBlas = true; blasBase = sp; instance = n.a; flags = I.info.z;
          o = lo; d = ld; inv = linv; ray = sceneWatertight(lo, ld);
          next = root;
        }
      } else {
        if (count == 0u || count > SCENE_MAX_LEAF || n.a >= triangleCount || count > triangleCount - n.a) {
          return sceneError(hit, BVH_ERR_TRIANGLE, visits);
        }
        for (var k = 0u; k < count; k++) {
          let tri = sceneTriangles[n.a + k];
          let r = sceneTriangle(ray, tri.p0, tri.p1, tri.p2, tMin, hit.t);
          if (r.x >= SCENE_NO_HIT) { continue; }
          let front = dot(cross(tri.p1 - tri.p0, tri.p2 - tri.p0), d) < 0.0;
          if (!sceneAcceptsFace(flags, front)) { continue; }
          hit.t = r.x; hit.b1 = r.z; hit.b2 = r.w;
          hit.instance = instance; hit.triangle = n.a + k; hit.front = front; hit.status = HIT_FOUND;
        }
      }
    } else {
      if (n.a >= nodeCount || n.b >= nodeCount) { return sceneError(hit, BVH_ERR_NODE, visits); }
      let tl = sceneBox(sceneNodes[n.a], o, inv, tMin, hit.t);
      let tr = sceneBox(sceneNodes[n.b], o, inv, tMin, hit.t);
      if (tl < SCENE_NO_HIT && tr < SCENE_NO_HIT) {
        if (sp >= SCENE_STACK_SIZE) { return sceneError(hit, BVH_ERR_STACK, visits); }
        if (tl <= tr) { stackNode[sp] = n.b; stackT[sp] = tr; next = n.a; }
        else { stackNode[sp] = n.a; stackT[sp] = tl; next = n.b; }
        sp++;
      } else if (tl < SCENE_NO_HIT) { next = n.a; }
      else if (tr < SCENE_NO_HIT) { next = n.b; }
    }
    if (next != 0xffffffffu) { node = next; continue; }
    // Pop the nearest unvisited entry that can still contain a closer hit.
    var found = false;
    loop {
      if (inBlas && sp == blasBase) { inBlas = false; o = originW; d = dirW; inv = invW; }
      if (sp == 0u) { break; }
      sp--;
      if (stackT[sp] <= hit.t) { node = stackNode[sp]; found = true; break; }
    }
    if (!found) { break; }
  }
  hit.visits = visits;
  return hit;
}
