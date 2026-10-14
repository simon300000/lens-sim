# Real lens hybrid V1 — implementation and acceptance

Local implementation, 2026-10-15. No push, deployment, or commit in the working repository. The original scene and its native WebGPU renderer remain; optical display is an explicit A/B mode, never a silent raster fallback.

## Runtime and ownership

Three.js **0.183.2**, Vite **7.3.7**, ES modules. No dependency upgrade or framework. `src/hdr-output.js` and the lockfile retain their existing conventions. New private backend access is contained in `src/rendering/three-interop.js`, checks r183/device lifetime, and is exercised by a native shared-resource test. The independent mathematical WGSL modules are compiled as one fused per-pixel optical compute kernel; public Three `StorageTexture` provides the final image. There is no second rendering device or CPU image transport in the application.

* `src/optics/`: strict prescription/glass adapter, runtime packing, physical intersections/refraction, conservative rear sampling, focus trace/reduction.
* `src/spectral/`: nonnegative authored RGB spectral reconstruction, published analytical CMF approximation, XYZ/Linear-sRGB, fixed 5-dimensional scrambled Sobol samples.
* `src/rendering/`: explicit HDR raster capture, bounded depth query, fused optical integration, f32/u32 storage accumulation, display resolve, revision-aware scheduling, lightweight UI boundary.
* `src/ui/`: actual Claude implementation. `main.js` assembles scene/lifecycle and wires existing controls.

The final graph reads the mean XYZ image, converts to Linear-sRGB, applies optional Bloom, then the existing one-exposure/one-encoding HDR/SDR output. Beauty capture is before exposure/Bloom/tone mapping. Scene capture is not a node dependency of final display, so static progressive batches cannot retrigger it.

Normal application operation does not read back full-frame pixels. The old startup night pixel probe is opt-in with `?gpu-diagnostics=1`; `window.__SANTEI__.captureOutputRange()` retains an explicit on-demand debug path. Normal AF/statistics/timestamp readbacks are small summaries. Validation pages may deliberately read pixel buffers for numerical acceptance.

## Claude implementation evidence

Installed CLI **2.1.299** was checked with `claude --version` and `--help`, then launched in a real PTY at the project root with `--model claude-opus-5-5`. `/status` explicitly reported that full model ID and session **7ab40175-5f8b-4e4a-a2cd-0418b2698331**. The saved session's actual assistant `message.model` values were independently inspected: the sole value was `claude-opus-5-5`; tool names were Read/Write/Edit/Bash, with no Agent/Task delegation. Authentication and configured permissions were retained.

Claude read `docs/ui-handoff.md`, the implemented control store, existing HTML/CSS/time controls and actual screenshots. It wrote `src/ui/lens-ui.js`, `lens-ui-core.js`, `lens-ui-format.js`, `lens-ui.css`, `tests/ui-lens.test.mjs`, its minimal test DOM helper, and `docs/ui-implementation.md`. It ran its checks and revised the same session after screenshots exposed common controls below the fold, then added recovery controls, explicit rate denominators, uncalibrated micro-focus labels and live breakpoint handling. A later direct human message in that CLI session explicitly requested removing the branding/Japan-time labels and adding brand → lens selection; those targeted `index.html` / `time-controls.js` edits are preserved and documented as revision 5. Brand values come directly from the upstream manifest through Codex's interface. Codex did not replace the UI implementation. The shared assembly and all optical/GPU implementation remained Codex-owned.

The same session was resumed explicitly with `--resume 7ab40175-5f8b-4e4a-a2cd-0418b2698331 --model claude-opus-5-5` after the installed CLI became 2.1.300. `/status` again confirmed the exact model. Claude implemented revision 6's visible centre AF-S marker and its state/disposal/layout tests. The marker is a body-level sibling of the panel, centred on the sensor/viewport, with pointer events disabled. Its state follows real backend AF results. The session was then exited normally.

See [the Claude implementation record](ui-implementation.md) for the exact frontend behavior and layout revisions. Live integrated browser acceptance is recorded below; Node UI tests alone are not substituted for that check.

The final direct request to Codex removed the remaining decorative scene-note sentence/block from `index.html`; this was a small content correction after Claude's UI implementation.

## Fixed upstream data

Submodule URL: `https://github.com/anvcor/lens-bench.git`, branch metadata `main`, actual gitlink **8274ca9d34bf75611f5a3c00af54a6a8498f076b**. Submodule contents are unchanged. The source LICENSE is GPL-3.0; converted data and adapted formula conventions retain provenance and the complete license. Build never fetches a moving main. See [data/update instructions](lens-data.md).

458 records: **426 parseable**, **420 with at least one statically usable configuration**. 1845 parseable configurations, **1820 accepted by the native-prescription initialization/ABI preflight**, 25 explicitly unavailable under that setup (17 image gaps at/below the current 0.05 mm sampling limit, 8 rear-cap envelope intersections). Original sensor position and finite/infinite object distance are retained; no forced 20 m initialization rejects valid close-focus structures. The list is not a claim of exhaustive GPU image validation. Actual path probes cover the default Canon FL 50 and Canon EF 40 STM, including its asphere; the diagnostic image tests use the default lens. Every generated entry explicitly retains `gpuValidated:false` for library-wide coverage.

Default: actual **Canon FL 50mm F1.8, INF configuration**, 11 spherical/plane interfaces, EFL approximately **49.0616 mm**, initial f/2.8, fixed 36×24 mm sensor. Glass interfaces have explicit clear radii; the independent stop radius is calibrated from native fno **1.86** and entrance-pupil magnification, with an explicit missing-independent-stop warning. `sdDraw` is never promoted to a physical aperture.

Supported mathematical forms: axial planes, signed spheres/conics and even polynomial aspheres A4–A26, with normalized radial coefficients and bounded same-ray numerical solves. DOE, odd/special forms, unknown glass, invalid configurations and unrepresentable/invalid initialization geometry remain unavailable. Empirical vig/vigCoord data is retained but never multiplied onto geometric clipping. The upstream Spot paths inspected skip failed fixed samples; no replenishment deletion is fabricated. Necessary intersection/aiming iterations are retained. See [capability and replenishment audit](lens-capabilities.md).

## Measurement convention

Sensor coordinates and all optical geometry are mm; world scene coordinates are m. +z runs object → sensor, object space is negative z, the first vertex is z=0, and the row's glass is the medium after its interface. Reverse tracing swaps both media. The sensor's physical inversion is explicit and tested with asymmetric yellow/cyan markers.

The reference plane is the rear vertex plane. Its disk encloses projections of the entire known rear physical cap for every sensor point using an annular interval bound; an unknown cap uses a disclosed numerical domain. It is not an unproved rear half-aperture projection or fitted successful-ray pupil. Disc samples have `pA=1/(πR²)` in mm⁻² and use `cos⁴θ/(d² pA)` for T=1, with one fixed global calibration `4/π`. Blocked/TIR attempts are zero, remain in the integer denominator and advance sampleIndex. No per-lens/pixel/frame success normalization or additional f-number multiplier is applied.

Glass LUT is 0.25 nm, current-lens-only. The spectral support is 380–780 nm; the source lacks manufacturer-certified range metadata, so that limitation is visible. RGB spectral reconstruction is an emission metamer approximation, not measured D65 or recovered material/light spectra. XYZ has normalized Ywhite=1, D65 sRGB primaries, fixed XYZ→Linear-sRGB conversion. See [spectral sources and tolerances](spectral.md).

AF uses one reference wavelength and one final image plane for all wavelengths. It traces a deterministic fixed first-plane beam budget selected before tracing (2048 baseline, increased for small apertures, bounded at 65536). Failed AF beams are not replenished. The same valid beams form a quadratic variance in z; GPU trace and cross-workgroup reduction are separate. A common z origin at the current sensor reduces f32 moment cancellation. Values below the estimated moment precision are displayed as a bound, not a perfect zero RMS. Infinite focus uses parallel object-side beams. This is sensor translation with fixed internal structure, not a commercial internal-focus mechanism.

## Native GPU environment and numerical results

Actual browser: Windows 10/11 platform Win32, **Chrome 155.0.0.0**, WebGPU adapter vendor **nvidia**, architecture **lovelace**. Exact board name/device string was not exposed. `timestamp-query` was present. HDR canvas accepted **rgba16float / srgb / extended**. No Safari, Firefox, macOS, mobile hardware, integrated GPU or physical-display luminance claim is made.

The JSON evidence is generated by the executable `/tests/*.html` pages and retained locally in ignored `artifacts/`. Timing below is explicitly distinguished from JS submission time.

| Acceptance | Measured result |
| --- | --- |
| Shared HDR chain | Geometry/raster → compute → final output on one device; linear pixel `[4,.5,.25,1]` retained; repeated display capture count stayed 1 |
| Continuous spectra | 120/120 Sobol f32 bit parity fixtures; 11 colors × 16384 wavelength strata; max scaled RGB error **3.797e-5**, under 1e-4 tolerance, including RGB `[200,20,2]` |
| CPU/GPU optical paths | 1257 rays, analytic fixtures plus two actual Canon lenses; statuses agree; maximum position error **1.201e-5 mm**, direction **4.882e-7**, reciprocal sensor position **3.156e-5 mm** |
| Actual dispersion | Strong-dispersion test geometry changes direction by **0.05747**, while dispersion disabled gives **exact zero** wavelength path difference |
| Batch invariance | 1 spp × 8 vs 4 spp × 2: exact integer/status counters and **0 XYZ prefix difference** |
| Fixed-attempt energy | 3,145,728 attempts per case: mean Y f/2.8 **1.82263**, f/5.6 **0.46295**; pass rates **27.574% / 6.847%** |
| Sampling area/PDF | Double disk radius, quarter pA: mean energy ratio **0.9999069**; no successful-ray renormalization |
| Optical HDR | Uniform HDR input yielded values above 1 (open case peak **2.75977**), finite rgba16float output |
| Scene/capture isolation | All tested static batches/focus/aperture/display changes retained capture count 1; a scene revision increased it to 2 |
| Runtime | Raising target continues; pause stops attempts; paused reset clears actual display; rejected updates preserve state; stale AF cannot lock busy; display changes preserve accumulation |
| Small aperture | f/22 infinite focus: **326/65536** valid deterministic beams; successful bounded sensor plane; RMS below moment precision displayed as a bound |

The data tests independently compared glass formulas to upstream to 2e-13, bounded default-reference f32 LUT index error by 3e-7 and measured ray path error **1.657e-6 mm / 1.883e-8 direction**. Static preflight is separate from these real GPU measurements.

The multi-depth test has striped planes at **0.6 / 1.2 / 3 m**, an actual finite 4 mm white emitter, and asymmetric markers. At each target's corresponding focus its measured column contrast exceeds the best other focus by approximately **1.76× / 1.64× / 1.95×**. Capture count remains 1. This verifies distance-dependent optical sharpness rather than uniform screen blur. Bloom is off, exposure is fixed at 1, dispersion is off for this focus-isolation case.

The diagnostic scene intentionally exposes depth/foreground edges. After correcting numerical frustum-entry artifacts, real single-layer cache misses remain about **10–11% of optically passed rays**, are counted and warned, and use the disclosed deterministic environment approximation. A fully covering constant-depth plane has **zero cache misses**, so this is distinguished from numerical clipping and optical blockage.

## Performance scope

Diagnostic scene, Canon FL 50, 11 interfaces, **240×160, 512 spp, 4 spp/batch**, 768×512 capture: sampled GPU timestamps were approximately **0.328–0.85 ms per batch** across cold/warm runs (not an average steady-state benchmark). A batch attempts 153,600 paths, corresponding to roughly **180–469 million attempted paths/s** for those particular recorded timestamps. Initialization of six optical pipelines was **833 ms CPU wall time** cold and **22.8 ms** in the warm rerun; initial diagnostic raster submission/compilation **23.4 ms CPU wall time**, not GPU raster time. New capture/optics/AF resources total approximately **12.16 MB**, excluding the original forest/villa geometry, shadow maps, Three pipeline caches, Bloom and driver allocations. Do not interpret that as whole-process GPU memory.

Cold shaders, different scene coverage, screen-space traversal, dispersion, resolution and driver scheduling change performance. Main-scene live measurements and UI acceptance are recorded in the final integration addendum below.

## Approximation and remaining platform boundaries

Single RGB/depth layer cannot recover hidden surfaces, correct arbitrary directional mirror/transparent radiance, provide a light field or accurate foreground occlusion bokeh. Water keeps the centre-view planar reflection appearance. Capture frustum has an actual enlarged angular guard band capped at 140° horizontally; outside rays are SCENE_CACHE_MISS, never disguised as natural black corners. Missing material spectra, exact certified glass range, physical T-stop, coating/absorption, ghosts, diffraction, wave optics, noise, motion blur, flash and scene BVH/path tracing remain outside V1. Unknown physical apertures and finite numerical domains are explicit warnings.

Display means are rgba16float; f32 accumulation is retained separately. Unrepresentable display values are bounded below half-float overflow (65000); this is not per-frame exposure normalization. Negative out-of-gamut Linear-sRGB from XYZ is clipped only for display. Browser/OS screenshot previews are ordinary image captures and do not prove HDR monitor nits.

## Final integration addendum

Final source passed **115/115 Node tests** and `npm run build`. An independent clone of the current local source (not an original-repository commit or push) initialized the canonical pinned submodule, ran `npm ci`, regenerated all lens assets, passed the same 115 tests, and built successfully. The validation checkout remained clean. Node was **v26.7.0**, npm **11.19.0**. Generated manifest SHA-256 was **653E84F7928F497D5B8E33BBCB08FE7538D7D0E1A7379980835FBFD77357EB33** in both checkouts. Existing package-install permission policy was retained; npm reported the existing unapproved esbuild postinstall, and the installed platform package still built successfully. The original repository HEAD remained **e7f72949e23fd298f0c71efe47678b4e40ce0906** and the upstream working tree remained unchanged.

Native Chrome interaction checks, using actual DOM controls and backend diagnostic attributes:

* Switched raster A / lens B, changed real lens and discrete configuration, adjusted f-number/manual focus, ran AF-S by button and F outside inputs, paused/resumed/reset, and raised target spp without replacing the renderer. Lens/configuration updates kept six resident optical pipelines.
* Entering 10 m by keyboard produced an actual 34.091 mm image gap and reduced the test-beam RMS from 0.0232 to 0.0025 mm. A final centre AF-S after orbiting acquired a target at **39.3074 m**, image gap **33.9117335 mm**, with **634/2048** beams and RMS **0.0113 → 0.0025 mm**. The visible marker's state changed to the real `success` result.
* At paused 60 spp, changed exposure to +3 EV, disabled Bloom and selected SDR: spp, optics revision and capture count remained unchanged. Paused reset displayed zero accumulated image, then resuming advanced attempts.
* Filtering brand alone preserved the active lens and optics revision. Selecting Nikon's actual Ai-S 45 mm f/2.8P changed the backend prescription and native image distance; restored the default Canon afterwards. Unavailable entries remained disabled with explicit reasons.
* Real canvas dragging outside the panel changed the camera/scene revision. Orbit damping can cause additional captures while the camera continues moving; the independent stationary runtime tests retained one capture through optical batches.
* At **992×785**, the marker centre was exactly **(496,392.5)**; at **390×844**, exactly **(195,422)**. It has `pointer-events:none`. Live desktop → narrow switching restored the narrow collapsed choice; returning restored the desktop expanded choice. Narrow document width/scroll width both measured 390 px. Escape closes the panel and restores focus. Final screenshots are retained in `artifacts/`.
* The decorative scene-note sentence, identity/seal and Japanese-time UI wording are absent. Actual astronomy still uses the documented fixed geographic site/timezone; removing a label did not change the Sun/Moon calculation. Real 00:00 and 24:00 advanced to successive midnights; noon produced approximately **106434 lux**, midnight sunlight zero and moonlight approximately **0.1973 lux** for the tested date.

Original HDR and astronomy tests pass. Native GPU evidence files are `hybrid-chain-v1.json`, `hybrid-gpu-acceptance.json`, `runtime-gpu-acceptance.json`, `imaging-gpu-acceptance.json` and `hdr-gpu-v1.json` under ignored `artifacts/`. These tests reported no GPU validation errors or non-finite output. The normal main page reported zero GPU errors and no default full-frame diagnostic readback attributes.

Full villa/forest startup in observed runs took approximately **26.9–36.6 s CPU wall time**, including scene construction, original shading/lighting and compilation; first optical full-scene raster submission/compilation was about **12.6 s CPU wall time** in the cold run. These are not optical-dispatch GPU timings. Earlier full-scene **480×320, 1 spp/batch** timestamps were **2.42–4.39 ms**, with approximately **18.61 MB** new renderer resource descriptors after capture. Default formal batches are now 4 spp; final live **480×320, 4 spp/batch** timestamp samples were **2.69–6.88 ms**. The final page reached **256/256 spp (39,321,600 attempts)**, then stopped. Once damping settled, scene revision stayed 100 and captures stayed 37 through accumulation and exposure changes; those preceding captures were during actual camera movement. Final numerical error rate was zero, scene-cache miss rate **7.375% of passed optical rays**, six optical pipelines, and zero GPU errors. `artifacts/ui-live-final.json` records that state. Foreground/background browser scheduling can throttle frame delivery independently of GPU throughput. No claim is made that the complete villa starts in the optical-pipeline-only initialization time.

Library-wide parsing/preflight does not certify every lens's visual quality or AF convergence. Near-sensor cover glass and conservative rear disks can have low geometric acceptance and slow convergence. V1 does not add fitted-pupil importance sampling to conceal this. Only the recorded platform/lenses/fixtures were GPU-tested. Remaining platform and screen-space limitations above are explicit, not pending features represented as passed.

## Generated-asset packaging correction

The initial implementation mistakenly tracked normalized `public/lenses/` output alongside the pinned source submodule. At the user's request these 460 generated assets were removed from version control, the directory was added to `.gitignore`, and npm `predev` / `pretest` / `prebuild` now regenerate it from the submodule. The generated license copy still ships in built output. No source data or submodule content was removed. A fresh independent source clone, explicitly checked to have no generated manifest before testing, passed automatic data generation, all 115 tests and production build; the manifest hash matched the earlier result and the clone remained clean. `dist/`, `node_modules/`, `artifacts/` and generated lens assets are not versioned.
