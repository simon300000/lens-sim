# Exit-pupil importance sampling

The proposal changes where an attempted ray is drawn, not the optical path.
Every rendering attempt still uses `traceOptics`, including every refracting
surface and physical aperture. Blocked/TIR/numerical paths contribute zero and
consume their original attempt. There are no replacement draws and no division
by successful-ray counts.

## Proposal and estimator

`pupil-sampling.js` defaults to moving-center 128 radial sensor-height bins, with a
configurable 1–1024-bin resolution for experiments. The 129 endpoint nodes are
shared by neighboring intervals. At each node, an aperture-free rear-to-stop
solve proposes a seed and scale at 380, 587.5618 and 780 nm (primary wavelength
only when dispersion is off). Every seed is revalidated through the complete
physical lens. The previous node supplies an initial guess, never acceptance.
A bounded coarse search recovers a seed if the guide point is blocked.

Starting from small rectangles around verified seeds, the algorithm independently
grows left, right, bottom and top edges. Each edge tests 17 evenly spaced
positions plus seed projections. Exponential expansion brackets a passing to
failing boundary, followed by binary refinement. Subsequent sweeps revisit edges
after the orthogonal extent changes. The margin is 2.5% of the guide scale or
1.25% of the measured width, whichever is larger, plus an absolute float margin.
Endpoints and midpoints now each receive an independent narrow-seed physical
boundary search, with continuation hints from the previous height. The fixed
proposal unions all three boxes per interval. The optional `movingCenter:true`
proposal interpolates endpoint box centers by the actual sensor height, then
uses a constant relative rectangle enclosing the endpoint and midpoint boxes
in that moving frame. Widths do not interpolate or shrink. Both modes share
exactly the same physically searched nodes and preserve the global mixture.

The rectangle rotates with sensor position. `pupilBins` and `pupilMovingCenter`
are accepted by the engine optics state for experiments; application defaults
are moving-center128 (set `pupilMovingCenter:false` for fixed bounds). Current partitions are uniform, with midpoint validation,
rather than adaptive subdivision. Physical nodes are cached by optics and bin
count; changing only representation derives a new table without physical tracing.
`precomputeMs` records shared node search, `deriveMs` records representation
construction, `coldBuildMs` is their sum, and `physicalCacheHit` identifies reuse.
Whole-table cache hits return the original object: measure caller wall time to
time those hits rather than reading historical `buildMs` again.

These finite probes are **not a proof of pupil coverage**. The rendering PDF is
always a mixture, with a 5% original full-disc component and 95% uniform local
rectangle component. If the rectangle is larger than the disc, use the disc
alone. Component selection remaps pupil Sobol dimension 2; dimension 3 supplies
the second coordinate. No additional random dimension or successful-draw loop
is needed.

For reference-plane point q, original disc D, local rectangle B, and alpha=.05:

```
p_A(q | sensor) = alpha * 1_D(q) / area(D)
                + (1-alpha) * 1_B(q) / area(B)
weight = (4/pi) * cos(theta)^4 / (sensorZ-referenceZ)^2 / p_A(q | sensor)
```

Both terms are evaluated regardless of which component generated the point.
Rotation has unit Jacobian. Runtime rays are sampled on the original reference
plane, rather than on the stop, so no nonlinear aiming Jacobian is required.
Wavelength sampling retains its existing separate PDF. The fixed radiometric
calibration, spectral reconstruction, f32 XYZ accumulator and attempted-spp
normalization stay unchanged. Rectangle samples outside D have zero contribution
to the original integral; they are not replaced. Even an incorrectly small box
retains support everywhere in D through the global component. Within D,
`p_A >= .05/area(D)`, bounding proposal-induced weight inflation relative to the
original sampler by 20×. Missed regions can therefore still cause large/rare
weights, but cannot be silently clipped or renormalized away.

A 32,784-byte uniform buffer (1024 bounds, 1024 endpoint-center pairs, and a runtime bin count) holds the table, avoiding another storage-buffer
binding and preserving the baseline WebGPU storage-buffer limit. The GPU does
one bin lookup, rotation, mixture draw and density calculation per attempt;
it performs no nonlinear aiming.

## Cache and integration

Tables are cached by immutable lens/configuration identity, sensor Z, sensor
size, stop radius, dispersion, original-domain radius, sampling enablement, and bin count.
Each lens retains at most eight tables. Pose, lighting, accumulation reset,
resolution and target spp do not rebuild tables. Runtime changes upload only a
changed table. A configuration explicitly marked as an angular-only domain disables area
proposals.

The engine defaults to importance sampling. `setLens`/`updateOptics` accept
`pupilSampling:false` for numerical comparisons with the original estimator;
this is not a different physical lens or exposure setting. `engine.pupilTable`
exposes build diagnostics. User-facing camera controls are unchanged.

## Reproducible validation

- `npm test`: mixture overlap and deliberately wrong proposal support, rotation,
  cache invalidation, different apertures/layouts, and full physical f64 tracing.
- `tests/pupil-reference.js`: independently scans the **original full domain**
  on a Cartesian grid, bounds discovered support and refines quadrature. It
  does not use the production stop guide or pupil boxes. Tests compare two
  refinement resolutions; this is numerical evidence, not a coverage proof.
- `/tests/pupil-gpu.html?curve=1`: click the run button, then the timing button after reference preparation,
  in the foreground. Add `&lens=<catalogue-id>` to compare another lens at its
  native sensor position and maximum aperture. Uses
  the production WGSL tracer, proposal sampler and spectral reconstruction.
  Measures hardware GPU timestamps where supported; otherwise explicitly marks
  queue/readback wall time. Records warmup-excluded timings, browser/adapter,
  focus/visibility interruptions, pass rates, weight second moments/maxima,
  numerical failures, and observed contribution outside the local box.
  Compares 12 seeds at approximately 40 ms per estimator and an optional
  eight-seed measured convergence curve. It downloads the complete JSON report.
- `/tests/pupil-engine.html`: production integrator, scene BVH/material shading,
  constant white environment, finite defocused emissive point, HDR resolve and
  original attempt counters. The sparse original point estimator uses more
  samples for correctness; this page is not a timing benchmark.
- `node scripts/run-gpu-tests.mjs pupil-engine pupil-gpu?autorun=1`: optional
  existing runner. Its default SwiftShader timings describe software rendering,
  not hardware. Exclude hidden, unfocused, error or interrupted benchmark runs.

CPU comparisons include sensor heights 0, 5 and 15 mm and 390, 550 and 770 nm,
plus stopped-down Otus and Canon lenses. They compare energy, angular pupil
histograms and second moments at a defocused object plane (reciprocal point
spread), rather than treating pass rate as proof of unchanged bokeh. The GPU
white spectral reference integrates independent f64 quadrature at 32 wavelengths.
Timing results for one lens/probe do not establish scene-wide speedups for every
lens, resolution or lighting condition.

## Measured results (2026-10-15)

Local IAB Chromium 155, Apple Metal 3, hardware timestamps; foreground and
focus tracked. Configuration 0, maximum model aperture, native sensor Z except
Otus uses the reported 1.373 mm rear gap. Fixed sensor positions; white emission,
dispersion enabled. Pass rates below are at height 0 / 550 nm (65,536 attempts).
MSE ratios use independent 32-wavelength f64 reference RGB, twelve seeds, and
approximately 40 ms GPU execution per estimator. The ratio is an error reduction,
not a scene-FPS multiplier. Two interrupted Canon preparation runs were excluded.

| Lens | Original pass | Importance pass | Equal-time RGB MSE reduction | Build ms |
| --- | ---: | ---: | ---: | ---: |
| nikon-z-58mm-f0-95-noct-s | 0.0565% | 8.8165% | 272.03x | 435.0 |
| sony-fe-vario-tessar-t-16-35mm-f4-za-oss | 0.0015% | 1.1108% | 1714.09x | 517.9 |
| sony-fe-600mm-f4-gm-oss | 11.4410% | 23.6099% | 1.18x | 418.8 |
| canon-ef-40mm-f2-8-stm | 60.3409% | 60.3409% | 1.03x | 104.1 |
| canon-fl-50mm-f1-8 | 66.9998% | 66.9998% | 1.01x | 105.0 |
| zeiss-otus-55mm-f1-4 | 0.0488% | 8.0719% | 198.06x | 298.8 |

Broad-pupil Canon lenses already pass about 60–67% of global samples at the
centre. Their local rectangles are not smaller than the disc there, so the
sampler retains the original distribution and results are essentially unchanged.
The 600 mm lens has a moderate gain; fast lenses with near-sensor cover glass
and the wide lens have the largest benefit. These results cover five additional
lenses beyond Otus, not the entire catalogue.

Otus convergence (eight additional seeds): the original estimator reaches
0.341% relative RGB RMSE in 512.05 ms; importance sampling reaches 0.343% in
32.10 ms (about 16x less measured GPU time at essentially the same error).
Precompute is excluded from that warm-cache comparison and is reported above.
No contribution outside the local proposal was observed in these probes; this
is not a proof that such contributions never exist. The global mixture remains
mandatory. At Otus height 15 mm, the unchanged f32 tracer still reports around
0.12% numerical failures per attempt, which remain zero contributions and are
reported rather than relabelled as successful paths. CPU f64 energy comparisons
at the tested fields/wavelengths differ by less than 0.3%.

Successful-ray weight distribution for Otus centre, 550 nm (f64 check): original
5th/50th/95th percentiles approximately 876/980/1106, maximum 1122; importance
5.36/6.01/6.78, maximum 6.87. The all-attempt weight second moment changes from
482.8 to 2.96. Both zero attempts and successful samples remain in the estimator.

Raw reports: [six valid GPU runs](../artifacts/dev/pupil-matrix.json),
[all runs including excluded ones](../artifacts/dev/pupil-matrix-raw.json),
[CPU tests](../artifacts/dev/pupil-cpu-tests.log). Artifacts are local and ignored
by Git; the test pages above reproduce them.

The production BVH/scene/HDR test also passes: white image mean ratio 0.99549,
finite defocused point total RGB flux ratio 1.00547; centre shifts under 0.05 px,
second moments agree within 0.7%. The independently traced f64 8×8 point-spread
histograms pass alongside pupil histograms. The very sparse global image needs
262,144 attempted spp versus 16,384 for the importance correctness run; their
remaining pixel RGB L1 difference is 27.7%, so these noisy images are not a
pixel-exact reference. Full-scene wall times of 12.10 s and 2.24 s have different
attempt budgets and **must not be presented as an equal-quality speedup**.
No BVH, unsupported material, transparency-limit, nonfinite-radiance or HDR
validation errors occurred. [Production result](../artifacts/dev/pupil-engine.json).

The same production test passes in Safari Technology Preview through a separate
tab, without restarting or clearing the main Safari. White ratio 0.9954898,
point flux ratio 1.0054734 and image L1 0.2771949 match Chromium to numerical
precision. This is a native-browser compatibility/correctness check; the
six-lens timestamp benchmark above was run in Chromium, not Safari.
[Safari TP result](../artifacts/dev/pupil-engine-safari-tp.json).

## Iterative-bounds experiments (2026-10-16)

`node scripts/pupil-sweep.mjs` saves `artifacts/pupil-sweep.json` and prints a
compact summary. The frozen `tests/fixtures/pupil-sampling-legacy.js` reproduces
the previous 32-bin proposal. Five native-gap lenses, five independent image
heights and three wavelengths compare 32/64/128/256 iterative bins against that
baseline. A dense f64 grid in the legacy search region measures observed omitted
energy; additional independent full-disc probes search for detached support.
The finite checks are evidence rather than a proof of complete support.

`node scripts/pupil-dev-server.mjs` serves the foreground benchmark at
`http://127.0.0.1:5174/tests/pupil-benchmark.html`. It records cold table builds,
shader/pipeline compilation, and warmup-excluded physical-trace dispatches
separately. It compares the same five proposals with three seeds, three image
heights and three wavelengths. A POST to the local server saves
`artifacts/pupil-browser-benchmark.json`. Hidden/unfocused runs, device loss and
GPU validation errors invalidate performance results. Hardware timestamps and
queue/readback wall time are separate fields. The fixed-ray test measures
proposal/tracer throughput and variance; it does not establish whole-scene FPS.
The production path is checked separately with
`/tests/pupil-engine.html?report=1`, which saves a local correctness report.

Final parameter tables, Safari/Windows measurements and caveats: [2026-10-16 report](benchmarks/pupil-iterative-2026-10-16.md).

## Resolution and moving-center experiment

The new uniform layout fits within the 65,536-byte uniform limit verified on
Safari Technology Preview. `tests/pupil-layout.html` checks the CPU/GPU bound,
point and PDF mapping, including rotated sensor positions and endpoint clamping.
`node scripts/pupil-sweep.mjs` now compares fixed/moving128/256/512/1024 and saves
`artifacts/pupil-resolution-cpu.json`. The same variants in
`tests/pupil-benchmark.html` save `artifacts/pupil-resolution-browser.json`.
These builds use full independently searched midpoint bounds, so their cold
precompute cost is not directly comparable to the earlier edge-only midpoint
implementation.

`tests/pupil-render-benchmark.html` compares actual production BVH/material/spectral
images at 48×32. A physical emissive stripe scene and finite defocused point use
80/240 ms queue-complete render wall-time budgets and four seeds per variant.
Table construction, warmup, reset, readback, and resolve are excluded from that
budget. Reference images average two independent 16,384-spp seeds; a third
fixed128 high-spp seed checks mean energy and image agreement. This measures
same-render-time image error, not just successful-ray throughput. The report
saves actual elapsed time, spp, MSE, reference noise and preview images to
`artifacts/pupil-resolution-render.json`. Cold setup and amortized render-only
costs must be considered separately when selecting a proposal.

Resolution/moving-center parameter tables and actual same-time image-error results: [追加实验报告](benchmarks/pupil-resolution-2026-10-16.md).

Cross-brand/structure validation (17 additional lenses, 18 configurations, 10 brands), including DOE/XODD/angular controls and Windows-authoritative performance: [跨品牌验证](benchmarks/pupil-diverse-2026-10-16.md).

Default selection (2026-10-16, after cross-brand validation): moving center, 128 bins, 5% global mixture. Historical benchmark reports retain the defaults that applied when they were run.

Numerical default-bounds preview: `node scripts/pupil-bounds-preview.mjs`, then `python scripts/plot-pupil-bounds.py` (Pillow). The plot compares fixed128 (orange) with the default moving128 (cyan) at five actual image heights; it preserves the native 1mm sensor gap and 5% global mixture.
