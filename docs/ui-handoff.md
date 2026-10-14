# lens-sim V1 UI handoff — Claude Opus 5.5

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
