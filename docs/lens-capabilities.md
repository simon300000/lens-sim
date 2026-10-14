# Lens capability preflight and sampling audit

Source: [anvcor/lens-bench](https://github.com/anvcor/lens-bench), `main` pinned at **8274ca9d34bf75611f5a3c00af54a6a8498f076b**. Its data and any adapted conventions retain the upstream **GPL-3.0** provenance. No upstream files were edited in this work. See [data setup, schema and deliberate update procedure](lens-data.md).

## Parsing is not renderer acceptance

`scripts/build-lens-data.mjs` first uses the existing strict prescription adapter, then calls `preflightLens` from `src/optics/capabilities.js` for each parsed configuration. It records both stages:

* `parserSupported`: the prescription, materials and discrete configuration parse correctly.
* `supported`: current runtime initialization is usable according to the scalar static checks below. This is the flag used to enable configuration selection.
* `validation: "static-preflight-only"`, `gpuValidated: false`: no per-lens GPU image acceptance is inferred from the first two flags.
* A parser/static failure has an explicit `reason` and a `null` configuration asset. A record remains selectable if any configuration passes; rejected configurations retain their own reasons.
* `warnings` preserves upstream/adapter warnings. `capabilityWarnings` is a separate list for renderer caveats. Empirical vignette metadata stays unchanged and unapplied.

Preflight uses the real runtime functions: `normalizeAsphere`, `firstOrder`, `apertureLimits`, and `rearSamplingRegion`; an explicitly requested focus override additionally uses `paraxialSensorZ`. It does not create unused glass LUTs, trace representative rays, fit successful-ray pupils, reject lenses merely because some rays would be physically blocked, or normalize brightness. It checks the current f32 surface ABI, normalized A4–A26 coefficients, surface/media indices, loss of positive vertex separation after f32 conversion, first-order and aperture degeneracies, the **native prescribed image plane**, and the conservative rear-cap projection bound. The final thickness and configured object distance are authoritative: `initialSensorZMm = lens.sensorZMm`, `initialFocusDistanceM = objectDistanceMm / 1000` (null for infinity). This preserves optimized finite-conjugate structures and their cover glass rather than forcing every lens to 20 m. The initial f-number and reference-disk PDF are also saved. An explicit `preflightLens(lens, {focusDistanceM: 20})` checks a paraxial 20 m sensor translation separately; its failure does not reject the native configuration.

Planes, spheres, conics and axisymmetric even aspheres through A26 can pass. DOE, ODD/XODD and other unsupported forms remain parser-rejected; no sphere substitution is made. Tiny raw A26 values may be valid after radial normalization, so raw coefficients are never directly judged by their f32 cast. Any nonzero normalized term that would overflow or become a WebGPU-flushable subnormal rejects the configuration rather than disappearing.

The fixed source yields **458 records / 1,979 configurations**. Parsing accepts **426 records / 1,845 configurations**. Native static initialization accepts **420 records / 1,820 configurations**, rejecting **25** parser-accepted configurations: 17 have a prescribed sensor gap at or below the current rear-sampling solver's **0.05 mm minimum** (including zero-gap cover-glass layouts and 0.026 mm gaps); 8 intersect the conservative rear-surface envelope. These are limitations of the current implementation/domain, not evidence that the commercial optical system is impossible. In particular, `7artisans-af-135mm-f1-8-max` configuration 1 retains its native finite conjugate and 1 mm rear gap even though a 20 m paraxial sensor shift would cross its fixed rear structure. These are static results, not 1,820 GPU-validated lenses. Tests assert pinned-library coverage so source changes require deliberate review.

The default remains `canon-fl-50mm-f1-8`, configuration 0. Preflight agrees exactly with `packLens` on its sampling radius/PDF, physical stop radius and initial sensor distance. Actual runtime GPU regression evidence must be recorded separately; `gpuValidated` is never automatically flipped by asset generation.

## Capture and aperture warnings

The current capture implementation expands the **view frustum**, using `max(50°, 1.6 × nominal horizontal FOV + 10°)` up to a **140°** horizontal pinhole cap. Preflight estimates the nominal field from focal length and the 36×24 mm sensor. **229** accepted configurations exceed that requested guard-band range and receive an explicit `SCENE_CACHE_MISS` warning. This is only a paraxial estimate, not a traced image-circle or fisheye coverage proof; aberrated rays can still leave the cache. A cache miss is never reclassified as lens blockage or described as a natural black corner.

When upstream `fmode` explicitly denotes image height (`height`), a declared maximum image height below the sensor half-diagonal yields a separate field-data warning. A declared angle is not silently interpreted as millimetres. This metadata does not apply an artificial image-circle crop.

Unknown clear apertures remain unknown and warn without universally rejecting the lens. Only explicit tx/sdAp clear radii and the optically calibrated operational stop count as physical clipping. `sdDraw` may help the disclosed finite numerical solving domain but is not promoted to a physical aperture. An unknown rear clear aperture means the reference-disk enclosure is conservative only within that numerical domain, not proof that every unknown physical path is represented. The renderer must continue reporting numerical errors and cache misses separately from physical vignetting.

## Inspection of failed-ray replenishment

At the fixed upstream SHA, the inspected primary CPU Spot and GPU Spot paths **do not replenish failed optical paths until a target success count is reached**. Therefore this task does not fabricate a removed upstream replenishment loop:

* `js/optics.js`, `spotTrace` (lines 2086–2104): a fixed stratified `side × side` grid has one deterministic jittered `(u,v)` per cell. Outside-circle/ellipse samples are skipped; `spotRay` failure advances to the next existing grid cell. `n` counts stored successes, but no random replacement is generated for a failed path. This Spot point-cloud/statistics layout is not used as lens-sim's irradiance estimator.
* `js/spot-webgpu-shader.js`, embedded WGSL `sampleCell`, `generateTraceOpticalTasks`, `writeOpticalPoint`: `sampleCell(cell)` uses fixed `mulberryAt(2*cell)` dimensions; generation owns a fixed output slot and initializes failure to zero. Failed tracing leaves the slot zero. Bounded GPU dispatch does not emit additional replacement cells.
* The same embedded WGSL `aimGenerated` has up to **two solver seeds** (reference prediction, then paraxial seed) for the **same `uv` / stopGoal**. `aimOpticalUniformQueue` solves pending original slots, then marks unsolved slots failed. This is category B numerical aiming, not category A sample replacement, and must not be deleted on that basis.
* `js/optics.js`, `aim` (from line 817) likewise retries seeds/Newton for the same requested stop coordinate. Surface `intersect` (around lines 600–625) performs at most 40 Newton iterations and then bounded scan/bisection on the same geometric ray. Those are necessary numerical solves, not attempts to manufacture extra transmitted flux.

This audit concerns the named optical/Spot paths at the recorded commit, not an assertion about every unrelated rendering or visualization routine in upstream. Lens-sim's fused integrator has its own fixed-attempt sampling and tests; no upstream application/backend is loaded at runtime.

## Validation

Run `node --test tests/lens-capabilities.test.mjs`. Nine tests check default pack agreement, normalized high-order coefficient acceptance/rejection, f32 range/gap errors, unavailable conjugates/envelopes, unknown aperture warnings, capture-limit semantics, field-unit handling and metadata preservation, unsupported form/media errors, and all pinned configurations. This suite is a CPU static/numerical preflight; it does **not** replace browser optical, HDR or GPU validation tests.
