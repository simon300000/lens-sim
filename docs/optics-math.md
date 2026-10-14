# Optical coordinates, sampling and reference tests

All lens geometry is in **mm**. The object is at negative local z; interfaces are
ordered along +z and the sensor is behind the last interface. A surface is the
primary sag sheet `z = vertexZ + c*r²/(1+sqrt(1-(1+k)*c²*r²)) + Σ A(4+2j)*r^(4+2j)`.
Positive radius curves towards the sensor. R=0 is a plane. Algebraic conic roots
on the other sheet are discarded by checking the primary sag, not by guessing a
radius-dependent ray direction. The normal is proportional to `(-ds/dx,-ds/dy,1)`.

`optical-core.wgsl` contains no bindings: integration supplies the current lens's
`opticalSurfaces`, `glassLut`, and `optics` buffers on its existing GPU device.
The public entry is `traceOptics(origin, direction, lambdaNm, reverse)`. Its
result contains the final position, unit direction and status: 0 success,
1 physical blockage, 2 total internal reflection, 3 numerical/invalid input.
`optical-reference.js` is a small f64 reference for tests/control calculations;
it is not a second imaging backend.

Each interface stores both adjacent media. In reverse traversal, after/before
become incident/transmitted respectively. Snell's law orients the normal against
the incident ray. A negative transmitted discriminant is TIR. Coincident
interfaces and reciprocity from an exact surface point accept a zero-distance
intersection; no arbitrary ray-origin offset is accumulated between surfaces.

The conic quadratic uses the stable q form to avoid cancellation. An asphere
uses the conic root or vertex plane as its initial guess, with at most 32 bounded
Newton steps on the GPU. A failed Newton solve falls back to a finite axial sag
interval intersected with a radial cylinder, scanning 64 brackets and refining
one bracket at most 32 times. All of these iterations solve **the same ray**.
Tangential roots or exceptionally oscillatory aspheres that escape this finite
bracketing remain numerical errors; they are not silently labeled vignetting.
GPU sag residual tolerance is `1e-5 + 8e-7*max(abs(vertexZ), length(rayOrigin))`
mm. CPU reference tolerances are stricter. Physical clear aperture and the
separate numerical domain are never interchangeable.

GPU packing normalizes radial polynomial coefficients: `u=r/rScale`,
`Bp=Ap*rScale^p`. `bounds.y` in the unchanged 96-byte surface ABI is the positive
radial normalization scale in mm. It is the known physical clear radius, or the
explicit numerical domain when physical radius is unknown. The asphere vectors
store B4 through B26, not raw A4 through A26; source assets retain raw mm-based
coefficients. Sag and derivative use Horner evaluation in u². This preserves
terms such as A26=2e-46 at r=50 mm that would lose their coefficient and overflow
their raw radial power in f32. Coefficients that cannot be represented as normal
finite f32 after normalization are explicitly rejected, as WebGPU may flush
subnormals to zero. This packing check does not certify path convergence for an
entire library configuration.

## Sampling measure and conservative rear region

The rear reference plane passes through the last interface vertex. For sensor
point s at Z, actual rear-surface point p at z and reference plane zRef, its
projection is `q.xy = ratio*p.xy + (1-ratio)*s.xy`, with
`ratio=(Z-zRef)/(Z-z)`. Thus its radius is bounded by
`abs(ratio)*Rcap + abs(1-ratio)*Rsensor`.

`rearSamplingRegion` bounds the sag over **1024 full annular intervals**. The
conic component is monotone radially; each signed polynomial term is bounded
independently over both radial endpoints. For each interval with sag in [lo,hi]
and d=Z-zRef > hi, a conservative radius is
`(d*rHigh + max(abs(lo),abs(hi))*Rsensor)/(d-hi)`. This bound includes values
between endpoints and does not depend on finding successful rays. A small
floating-point expansion is additional protection, not the proof itself. A
sensor intersecting the swept rear cap is rejected. Explicit physical rear
radius limits the cap. Missing rear aperture uses a clearly labeled finite
numerical domain derived from twice the maximum documented drawing/physical
radius or sensor diagonal. Such a domain is an approximation, not a known
physical opening; completeness is only guaranteed **within that domain**.

An area-uniform disk sample has `pA=1/(π*R²)` mm⁻². With air at the sensor and
reference plane, ideal transmission T=1 and d in mm, its geometric weight is
`cos(theta)^4 / (d²*pA)`. This dimensionless integral corresponds to incident
solid angle including the sensor cosine. No additional f-number factor is
applied. The fixed global calibration belongs in the rendering integration;
there is no per-lens or per-pixel successful-ray normalization.

Every attempted sample consumes its sample index. Blocked/TIR samples add zero
contribution and remain in the averaging denominator. Numerical failures are
counted separately. Expanding the conservative sampling disk changes pA and
variance, while its expected transmitted energy remains unchanged. Scale values
below one are rejected, as they would invalidate the bounding proof.

The numerical reference `zemax-55` ends with a 15 mm clear-radius plane only about 1.18 mm
from the 20 m paraxial sensor setting. This conservative cap disk can reject
many rays elsewhere in its 23 interfaces; it is deliberately not tightened from
a handful of successful samples. Slow noisy convergence is preferable to
erasing physical throughput losses.

## First order and aperture conversion

The CPU ABCD matrix uses `(height, n*slope)`. Refraction is power `(nt-ni)/R`;
translation is thickness/nt. The first-order system provides only focus initial
values and pupil scaling, not the rendering ray itself. At the physical stop,
the partial matrix A is stop-radius/entrance-pupil-radius. An infinity f-number
therefore sets actual stop radius to `abs(EFL*A)/(2*fNumber)`, bounded by both
native aperture mode and any documented physical stop radius. Only the stop
radius changes. Finite working-f-number records use their declared conjugate
and image-space cone; they are not mistaken for an infinity EFL/EPD label.

For the pinned Zemax reference, f64 ABCD yields EFL **55.01175165669065 mm**, stop
magnification **0.6053716868795971**, and back focal distance
**1.0260605959867084 mm**. The determinant differs from one by less than 1e-12.

## Executed numerical checks

Run `node --test tests/optical-math.test.mjs` for ten independent checks:

- Signed sphere roots, a parabola and plane against closed-form intersections.
- Plane plus A4/A6 asphere sag/normal against explicit polynomial values.
- Snell refraction, TIR and finite-thickness plane-plate lateral displacement.
- Forward/reverse default-lens and asphere paths at 390, 486.1327, 587.5618 and
  770 nm; reciprocity tolerances 2e-7 mm and 2e-8 unit direction.
- Pinned default ABCD and stop-only packing; finite/infinite paraxial focus order.
- 60,000 rear-cap extrema against the interval-proven sampling bound, including
  mixed-sign polynomials and radii between the production interval endpoints.
- Fixed-attempt energy and enlarged-disk PDF invariance. Uniform radiance through
  clear radius b at plane distance d has analytic integral `π*b²/(d²+b²)`.
  The deterministic 100,000-attempt test matches this to 1e-8 absolute.
- Actual 0.25 nm f32 glass LUT propagation through 54 default-lens paths. Measured
  maximum position error **1.6568860844532678e-6 mm**, maximum unit-direction
  error **1.882382258221246e-8**, against analytic f64 glass formula paths.
  With dispersion disabled, sampled wavelength has exactly no geometric effect.
- The selected Canon FL 50 full-frame runtime default, f/2.8: physical aperture
  provenance, rear gap and 1024 fixed Sobol reverse samples, with more than 230
  successful paths and zero numerical failures. Every successful path is traced
  forward again and must return to its original sensor point/direction within
  2e-7 mm / 2e-8 unit direction.
- Normalized f32 Horner at 1001 radii through a 50 mm high-order test asphere;
  A26=2e-46 is retained despite raw f32 underflow and r²⁶ overflow. Polynomial
  sag/derivative match the independent raw f64 polynomial within 2e-7 mm /
  2e-9 inverse-mm; unrepresentable coefficients reject explicitly.

These f64 tests are not a substitute for browser WGSL dispatch validation or a
claim that every structurally supported library record is numerically validated.
GPU integration and image orientation require separate real-device acceptance.
