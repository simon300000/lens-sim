// Work tallies for the diagnostics HUD's arithmetic estimate (src/rendering/work-model.js).
// Private, per invocation: a plain register add at each primitive. Staged passes
// reduce into a global buffer only while counting is enabled;
// other pipelines never read them, so the adds compile away. Prepend this file to
// every module that includes optical-core.wgsl or scene-intersector.wgsl.
const WORK_PATH: u32 = 0u;          // destination path (camera transform, accumulation)
const WORK_LENS_SURFACE: u32 = 1u;  // lens interface: conic roots, aperture test, refraction
const WORK_SAG: u32 = 2u;           // conic sag evaluation (polynomial part tallied separately)
const WORK_NORMAL: u32 = 3u;        // surface normal evaluation (polynomial part tallied separately)
const WORK_POLY_FLOPS: u32 = 4u;    // asphere polynomial / Bernstein arithmetic, already in FLOPs
const WORK_BOX: u32 = 5u;           // BVH slab test
const WORK_TRIANGLE: u32 = 6u;      // watertight triangle test
const WORK_INSTANCE: u32 = 7u;      // TLAS -> BLAS ray transform
const WORK_SHADE: u32 = 8u;         // surface reconstruction + material + image-based lighting
const WORK_LIGHT: u32 = 9u;         // one analytic light: BRDF + attenuation
const WORK_SHADOW_TAP: u32 = 10u;   // one PCF / Vogel shadow tap
const WORK_NOISE: u32 = 11u;        // one 3D gradient-noise evaluation
const WORK_SPECTRAL: u32 = 12u;     // RGB -> spectral XYZ contribution
const WORK_ENVIRONMENT: u32 = 13u;  // sky / stars / moon on a background ray
const WORK_OPTICAL_LAUNCH: u32 = 14u; // actual optical launch, shared across mirrored destinations
const WORK_CAMERA_TRANSFORM: u32 = 15u; // successful ray transformed to the scene
const WORK_COUNTERS: u32 = 16u;
var<private> workCounters: array<u32, 16>;
