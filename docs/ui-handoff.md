# lens-sim UI handoff — Claude Opus 5.5

## V2 handoff: geometry first hit + real-time lighting (current)

The lens image no longer looks up a single-layer screen capture. Every optical path that passes the lens is intersected with the real registered scene geometry (two-level BVH on the GPU), shaded at that real hit with the scene's materials and lights, using raster-generated shadow maps / PMREM / water reflection. It is NOT full path tracing (no multi-bounce GI). The raster navigation view stays as it was.

Model: explicit `claude-opus-5-5`. Same boundaries as V1: own `src/ui/**`, `tests/ui*.mjs`, `docs/ui-implementation.md`. Do not edit main.js, index.html, style.css, time-controls.js, rendering/, optics/, spectral/, scene/, shaders or tests outside `tests/ui*`. Only small necessary changes; do not redesign the panel.

### State changes (src/rendering/control-store.js)

Removed (no longer exist; delete UI that shows them): `diagnostics.captures`, `diagnostics.cacheMissRate`, `diagnostics.captureMs`, `display.diagnostic === 'cache-miss'`, `revisions.scene`.

Added:

* `renderModel: { id: 'geometry-first-hit-realtime-lighting', label: '几何首交点 + 实时光照', approximations: string[] }` — show the label clearly as the lens mode name (e.g. next to "B · 镜头追迹"), and the approximations list in the collapsible limitations/notes. Never call it "完整路径追踪".
* `scene: { status: 'pending'|'building'|'ready'|'error', message: string, summary: null | {...}, lighting: null | {...} }`
  * `status/message`: real BVH/scene preparation state. Show it (e.g. "场景准备：构建 BVH…" / "BVH 就绪：N 个实例" / error text). Lens mode cannot sample until `ready`; do not fake progress (there is no percentage).
  * `summary` (after build): `instances, uniqueTriangles, expandedTriangles, meshes, blas, materials, bvhNodes, tlasNodes, blasNodes, tlasDepth, maxBlasDepth, gpuBytes, buildWallMs, extractMs, uploadSubmitMs, worker:boolean, environmentObjects, unsupported: string[], counters:{fullBuilds,tlasRebuilds,blasBuilt,blasReused,materialUploads}, timing:{blasMs,tlasMs,packMs,totalMs,blasRebuilt,blasReused}`. Put a compact subset in the collapsible diagnostics (instances, base triangles, BVH nodes/depth, GPU bytes, build ms and whether a Worker was used). `unsupported` non-empty → visible warning listing materials (these surfaces contribute zero and are counted, never painted grey).
  * `lighting`: `{ ok, errors: string[], warnings: string[], lights:{directional,point,pointShadows,hemisphere}, environment:boolean, reflection:boolean }`. Show errors prominently (lens image stops on errors), warnings in diagnostics.
* `diagnostics` new fields (fractions 0..1; actual values only):
  * over all attempts: `opticalBlockedRate, tirRate, numericalErrorRate, hitRate, backgroundRate, opticalPassRate, radianceInvalidRate`
  * over optical paths that reached the scene (label the denominator "占通过镜头的光线"): `bvhErrorRate, unsupportedRate, transparencyLimitRate, reflectionOutsideRate, sceneHitOfPassed, backgroundOfPassed`
  * `lightingRefreshMs` (CPU submit wall time of the raster resource refresh, nullable), `lightingRefreshes` (count), `computeMs` (GPU timestamp of one sample tile, nullable), `timingSource` string — display as given, never invent numbers.
  * Status meaning: OPTICAL_BLOCKED / OPTICAL_TIR / OPTICAL_NUMERICAL_ERROR are lens-side; SCENE_HIT / SCENE_BACKGROUND normal; SCENE_UNSUPPORTED (material not implemented), BVH_TRAVERSAL_ERROR (implementation error; backend stops accumulation), TRANSPARENCY_LIMIT (more than 6 alpha layers on one ray; contributes zero). `reflectionOutsideRate` = water hits whose reference-view planar reflection lookup fell outside the main camera view (approximation diagnostic, not an error).
* `revisions: { geometry, material, lighting, camera, optics, display, accumulation }`.
* `af.lastResult.target` (after AF-S): `{ infinity?, distanceM, hitDistanceM, transparentLayers }` — AF now uses the real BVH intersection along the lens reference ray (first opaque surface; water/glass layers are passed through and counted). `af.message` already contains a readable summary.

### Commands

* `setDiagnostic(value)`: values are now `beauty`, `scene-error`, `status`, `geometry-depth`, `geometry-normal`, `geometry-material`.
  * `scene-error` and `status` are resolve-only maps of the current accumulation (R/G/B meaning: scene-error R = BVH error + transparency limit, G = unsupported material, B = reflection outside reference view; status R = numerical, G = blocked/TIR, B = scene hit).
  * `geometry-*` accumulate debug values per path (depth = exp(-t/15 m), world normal ×0.5+0.5, material id hash colour) and therefore RESTART accumulation when switched to/from. Put them in a collapsible "几何/法线/材质诊断" group or a single select with clear "（重新累计）" hint.
  * Diagnostic maps are displayed without exposure/bloom (raw).
* `rebuildScene()`: re-scans registered scene objects and does the minimal BVH/material update (debug/dev control; optional to expose in collapsed diagnostics).
* All V1 commands unchanged.

### Required visible content (small changes only)

1. Lens mode name: "几何首交点 + 实时光照" (renderModel.label). Keep A · 光栅近似 navigation view.
2. Real scene preparation / BVH status.
3. Concise approximation notes (renderModel.approximations) inside the existing limitations disclosure; remove the old "单层 RGB/深度 / 缓存未命中" texts.
4. Collapsible geometry / normal / material / error diagnostics (see setDiagnostic).
5. Replace the old high-cache-miss warning by: lighting errors, unsupported materials, BVH errors (> 0), transparency limit rate (> 0.1%).
6. Existing lens / aperture / focus / sampling / display controls unchanged.
7. Simple performance numbers that the backend actually provides: computeMs (GPU timestamp, may be null), lightingRefreshMs (CPU submit), BVH build ms. No invented throughput.

Update `tests/ui-lens.test.mjs` (and `tests/ui-fake-dom.mjs` if needed) for the new fields; `npm test` must pass. Record the revision in docs/ui-implementation.md (session id, model, files). Codex will provide real browser screenshots afterwards for revision in the same session.


## V1 handoff (historical)

You implement the actual UI, not only suggestions. Explicit model `claude-opus-5-5`, no fallback, no additional agents. Work locally; never push, deploy, modify submodule, or override existing user changes. Record your session and touched files in docs/ui-implementation.md (this file is also allowed). Codex owns all physics, rendering, state, integration, lifecycle and final acceptance.

## Existing application

ES modules, Vite 7.3.7, Three.js 0.183.2, no UI framework. `npm run dev -- --port 5173 --strictPort`, `npm test`, `npm run build`. `index.html` contains full canvas `#scene`, original branding, output badge `#output-status`, time/date panel `#time-controls`, loading curtain. Time controls are wired by src/time-controls.js: retain these elements and semantics. OrbitControls uses canvas pointer events. Existing HDR/SDR badge and time/date controls must keep working. Do not invent screenshots: real screenshot will be handed over when browser starts.

## Edit boundaries

Own `src/ui/**` including its CSS and UI-only tests `tests/ui*.mjs`. May write `docs/ui-implementation.md`. Read all source as needed. DO NOT edit main.js, index.html, global style.css, time-controls.js, optics/, spectral/, rendering/, hdr-output.js, package files or vendor. Codex mounts `createLensUI({store, container})` from `src/ui/lens-ui.js` into a new container and imports your CSS via your module. Return `{dispose()}`. You may style existing page elements by scoped body class `.lens-ui-mounted` or carefully targeted media queries from your CSS; do not remove existing controls. No framework additions.

## Real interface (already implemented)

`src/rendering/control-store.js`: `store.getState()`, `store.subscribe(fn)` (immediate snapshot, returns unsubscribe), `await store.dispatch(type,value)` (rejects on failure). Immutable snapshots, no polling. Backend is asynchronous. UI should show command failures and busy/disabled states, not fabricate progress, AF, performance or data. All controls only dispatch; never touch GPU, renderer, buffers, optics math, camera FOV or control target. Import nothing from optics internals.

State fields:

* status: loading/ready/error; error:null|string; mode:raster/lens.
* lenses: [{id,name,available,reason?,configurations?}], lensId, configurationIndex, configurations:[{index,title,available,reason?}], warnings:string[]. Include unavailable lenses and reasons.
* limits.fNumber:[min,max]; limits.imageDistanceMm:[min,max].
* optics: fNumber, focusDistanceM (number or null = infinity), imageDistanceMm (last vertex to sensor, mm), focalLengthMm, sensorMm:[36,24], dispersion:boolean, focusModel, distanceReference. Model fixed internal lens groups, sensor translation; distance measured from first object-side vertex. No blur-strength slider. Aperture changes stop only; physics backend enforces constraints.
* sampling: targetSpp (1..4096 integer), spp (actual attempts per pixel), batchSpp (1..4), resolution (width 240..960, image always 3:2 letterboxed), paused, seed.
* display: exposureEV (-6..6 additional stops), bloom:boolean, diagnostic:beauty/cache-miss/status, output:auto/sdr; actualOutput:hdr/sdr-tone-mapped. Exposure/output do not reset optics.
* af: status:idle/busy/success/error; message; autoOnRelease:boolean. AF-S on demand, keyboard F outside inputs; failure preserves last valid focus. Auto after orbit release optional and debounced by backend.
* diagnostics: captures, pipelineCompilations, cacheMissRate/numericalErrorRate/opticalBlockedRate/tirRate fractions0..1, attemptedSamples integer, captureMs/computeMs nullable (never invent), timingSource, width,height,memoryBytes. Show high cache misses warning. Backend provides actual values only.
* revisions:{scene,optics,display,accumulation} for optional diagnostics.

Commands: `setMode('raster'|'lens')`, `selectLens(id)`, `selectConfiguration(index)`, `setFNumber(number)`, `setFocusDistance(number|null)`, `setImageDistance(number mm)`, `autofocus()`, `setAutoFocusOnRelease(boolean)`, `setTargetSpp(integer)`, `setResolution(integer width)`, `setPaused(boolean)`, `reset()`, `setDispersion(boolean)`, `setExposureEV(number)`, `setBloom(boolean)`, `setDiagnostic(value)`, `setOutput('auto'|'sdr')`. Dispatch by exact camel-case name. Ready state gates commands; AF/lens loading additionally disables conflicting optics operations. Lens mode must never silently display raster as a successful optical image.

## UI requirements and acceptance

Chinese interface, concise, scene first, simple grouped controls (lens/config/aperture, focus/AF, sampling, display). Common controls visible; technical diagnostics collapsible. Keep full image usable with OrbitControls. Desktop and narrow mobile layout, keyboard focus, explicit units, labels, disabled states and real async errors. No blocking dashboard or decorative animations. Lens/config supported range and data warnings, f-number limits, focus distance/infinity, sensor image distance fine adjustment, AF-S, spp, pause/resume, reset, display exposure/Bloom/output, raster A/B, dispersion, cache-miss visualization and diagnostics required. Do not fake progress or normalize brightness. Use actual spp/target for progress only.

Physics scope: actual prescription reverse refractive tracing, one continuous wavelength per attempted path; failed paths remain zero, no replenishment; f32 XYZ accumulation. Existing RGB linear raster + single-layer depth is approximate screen-space scene, not full path tracing; RGB->spectrum is approximate; T=1 no coating/ghost/diffraction/noise. Need visible concise limitations in disclosure/warnings. Unknown glass, DOE/odd surfaces unavailable. No UI claim of full spectral scene, perfect foreground bokeh, light field, internal focusing, or real T-stop. Existing water remains center-view approximation.

Run actual checks available. Codex will connect backend and return browser screenshots/feedback to this same Claude session for revision. Do not redesign physics or write a competing control store.
