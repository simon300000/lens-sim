# Single-layer scene-radiance query

`scene-radiance.wgsl` is the bounded scene segment of the hybrid renderer. It does
not trace the villa's triangles. Its inputs are an unexposed linear-HDR beauty
texture and its aligned non-MSAA WebGPU depth texture from one capture version.
The optical segment supplies a real displaced world-space ray origin, not just
a direction. World distances are metres; lens-local millimetres must be converted
at the optical/world boundary. The capture camera's `matrixWorldInverse`,
`projectionMatrix * matrixWorldInverse`, and its inverse are column-major.
WebGPU NDC z is [0,1]; texture row zero is at the top, so NDC y is negated once.

The implementation clips the finite world ray to the capture frustum, then
steps its projection with perspective-correct `Q = worldPosition / clip.w` and
`k = 1 / clip.w` interpolation. A depth slab crossing triggers eight bounded
world-space secant refinements. A fronto-parallel layer has a linear depth gap,
so the first secant evaluation recovers its intersection. The maximum is 128
projected intervals plus eight refinements. At very large projected extent the
bounded budget increases stride; subpixel features can be missed. The fixed
depth tolerance (default 0.03 m) is a screen-space approximation, not an optical
surface tolerance. Abrupt layer changes greater than max(0.15 m,5% depth) return
cache miss rather than constructing a surface between unrelated depth samples.
Colour is fetched from the same nearest texel as depth to avoid blending across
occlusion boundaries. There is no UV clamp, hole filling, ray reissue or success
normalization. The derivation of projective stepping follows
[McGuire and Mara, JCGT 3(4), 2014](https://jcgt.org/published/0003/04/04/);
this is an independently written variant, not copied source code.

Texture coordinates occupy an open upper boundary. After homogeneous clipping,
the exact entry point can round to UV=1 even though the later ray is covered.
The query advances the same ray into the clipped segment by a numerical inset
of `32 * f32_epsilon * max(1 m, |origin|, |entry|)`, bounded to 0.01% of the
clipped interval; the exit is similarly inset when clipped. This retains the
same optical ray, never clamps UV and never turns an actual side exit into
background. A real Canon FL 50mm f/1.8 f/4 reverse-ray regression reproduced
53 false boundary misses among 492 physical passes before this correction.

`SceneQueryParameters` is a 272-byte uniform struct, in this order:

| Field | Meaning |
| --- | --- |
| worldToClip, clipToWorld, worldToView | Three mat4, 192 bytes |
| viewport | width, height, near metres, far metres |
| trace | max distance metres, slab metres, pixels/step, max steps <=128 |
| skyZenith, skyHorizon, skyGround | scene-linear RGB directional fallback, vec4 each |

The host declares `captureColor: texture_2d<f32>`,
`captureDepth: texture_depth_2d`, and `sceneUniform: SceneQueryParameters`.
The shader defines
`queryScene(originWorld:vec3<f32>, directionWorld:vec3<f32>) -> SceneQueryResult`.
The result contains `rgb`, `position`, and `status`:

| Value | Status | Meaning |
| --- | --- | --- |
| 4 | SCENE_HIT | Actual query ray's visible-layer depth-slab intersection |
| 5 | SCENE_BACKGROUND | Entire in-frustum segment is clear depth; capture sky RGB |
| 6 | SCENE_CACHE_MISS | Outside coverage, hidden layer, edge discontinuity, invalid or unresolved segment |

The existing sky material has `depthWrite:false` (`src/lighting.js`), so its
background clear depth is 1. An in-cache background query preserves actual
capture sky/star/solar colour. Missing coverage uses a deterministic linear-HDR
zenith/horizon/ground approximation. It must be counted as missing coverage,
never as optical blockage or a naturally black lens corner. A finite max-distance
cutoff limits what can be queried, independently of actual image-circle size.

The host must expand the capture **frustum**, not only its texture resolution,
and report uncovered rays. It must use matching capture revisions and reset
optical accumulation when capture content changes. Wider/fisheye lenses may
exceed this cache even with guard band. One central layer cannot recover surfaces
hidden from the central capture, correct arbitrary ray-dependent mirror/water
radiance or transparent layers, or promise accurate foreground occlusion blur.
The pre-existing water/reflections are retained as central-view approximations.
Normal data may be captured by the host for other purposes; this provider does
not claim a normal-based material/light re-evaluation.

`scene-query-reference.js` is a small CPU f64 numerical test oracle, not an
alternate user-facing renderer. `node --test tests/scene-query.test.mjs` checks
near/far and y orientation, non-centred origins, independent depths, HDR values,
discontinuities, background/miss separation, bounds and world camera transforms.
GPU validation and capture scheduling are integration responsibilities and are
not established by those CPU tests alone.
