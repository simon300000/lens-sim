# lens-sim V1 UI — implementation record

- Implementer: Claude Code, model `claude-opus-5-5`, session `7ab40175-5f8b-4e4a-a2cd-0418b2698331`. No sub-agents, no model switch. Revision 6 ran in the same resumed session: Opus 5.5 explicitly, confirmed with `/status`, CLI 2.1.300.
- Date: 2026-10-15. Status: revision 6 (centre AF-S reticle). It builds on revision 5 (branding and Japan-time text removed at the user's direct request; brand → lens selection). It builds on revision 4, after the real-browser feedback `artifacts/ui-desktop-v1.png` and `artifacts/ui-narrow-v1.png` (390×844). It adds live breakpoint handling, a sampling-noise hint, and fixes for truncated AF and focus text. Revision 3 added error-state recovery, uncalibrated focus and rate denominators. It builds on revision 2, after the real screenshots `artifacts/ui-before.png` and `artifacts/ui-integrated-first.png` (992×785 Chrome) and Codex's integration feedback. Codex has mounted the UI in `main.js`.
- Boundaries kept, except the user-requested revision 5 edits to `index.html` and `time-controls.js` listed below: I did not edit `main.js`, `index.html`, `style.css`, `time-controls.js`, `optics/`, `spectral/`, `rendering/`, `hdr-output.js`, package files, `vendor/` or Git state. Mounting is left to Codex.

## Files written

| File | Purpose |
| --- | --- |
| `src/ui/lens-ui.js` | Entry point. Imports `lens-ui.css` and re-exports `createLensUI`. |
| `src/ui/lens-ui-core.js` | `createLensUI({ store, container }) → { dispose() }`. Builds the DOM, wires the controls and renders from store snapshots. |
| `src/ui/lens-ui-format.js` | Pure helpers with no DOM: formatting with units, f-number and focus step lists, validation, command gating, the honest view summary, the F-shortcut rule. |
| `src/ui/lens-ui.css` | Panel styles, all scoped under `.lens-ui`. Has a night variant through `body[data-night]`, plus narrow, short-screen, touch and reduced-motion rules. |
| `tests/ui-lens.test.mjs` | 38 UI tests: formatters, gating, every command dispatch, disabled states, errors, coalescing, keyboard, accessible names, dispose. |
| `tests/ui-fake-dom.mjs` | Minimal DOM shim for Node, with controllable `matchMedia` and `doc.setNarrow()` for breakpoint transitions. It is a helper, not a test file: `npm test` only globs `*.test.mjs`. |
| `docs/ui-implementation.md` | This record. |

## Mounting (for Codex)

```js
import { createLensUI } from './ui/lens-ui.js';
const lensUI = createLensUI({ store, container: document.body.appendChild(document.createElement('div')) });
// later: lensUI.dispose();
```

- Mounting adds `<section class="lens-ui">` to the container. It is `position:fixed`, so where the container sits does not matter.
- It adds `body.lens-ui-mounted`, and `dispose()` removes it. The only existing page element this class affects is the legacy `body::after` overlay, which it removes (see revision 4). Identity, time controls and other page styling are untouched.
- Mounting also appends one `<div class="lens-ui-reticle">` (the centre AF-S point) directly to `<body>`, as a sibling of the container and panel. `dispose()` removes it.
- `dispose()` unsubscribes from the store, removes every listener (including the document `keydown` used for F) and removes the DOM.
- Imports: only `./lens-ui-format.js`. Tests also import `src/rendering/control-store.js` (read-only). Nothing comes from optics or rendering internals.

## Behaviour

- **Layout**
  - Above 700 px wide: a left column at `top:126px; left:40px`, between the identity mark and the caption/garden clock. It is 320 px wide, or 288 px at 1100 px and below, and its height is capped at `100dvh − 366px`. The body scrolls internally. In the real 992×785 screenshot this column covers only the left trees and stepping stones. The villa, deck, pond and right-hand trees stay clear, whereas the first right-side placement covered the porch and pond.
  - Widths up to 700 px: a chip under the identity mark, collapsed by default. When open it becomes a sheet above the garden clock.
  - Short screens: the sheet may cover the clock.
  - The collapsed header always shows what is on screen.
  - The open/collapsed choice is remembered per layout (narrow or wide) in `localStorage`, wrapped in try/catch. It falls back to open on wide screens and collapsed on narrow ones.
  - A `matchMedia('(max-width: 700px)')` change listener re-applies the right layout's choice on live resize: wide → narrow uses the narrow choice (default collapsed), and narrow → wide returns to the wide choice. The key follows the current layout. If focus was inside the body when it collapses, focus moves to the toggle. The listener uses `addEventListener` or the older `addListener` and is removed on `dispose()`.
- **Honest header summary**
  - Raster mode: `光栅近似预览（非镜头成像）`.
  - Lens mode with no samples yet: `镜头追迹 · 等待首批样本`.
  - Lens mode with samples: actual `spp/target`.
  - Diagnostic views: `诊断视图：…（非成像）`.
  - Loading or error states are shown as such.
- **Groups**, in order. Common actions come first so they sit above the fold at 992×785.
  - 画面: A/B mode toggle.
  - Quick bar: AF-S (F) with a short status label and pause/resume. The backend AF message sits on its own line (up to 2 lines) so it is not truncated. Below that, a `<progress>` with text from the actual spp and target.
  - 对焦: when `optics.focusDistanceKnown === false` (after an image-distance micro-adjust), the number field is empty with the placeholder `未标定`, ∞ is not shown as pressed, `aria-valuetext` says `未标定（上次设定 …）`, and the hint reads `物距未标定（上次设定 X）：像距已微调，实际物距未换算` in the warning colour. Neither ∞ nor the last request is presented as a calibrated distance. Otherwise: log-scale distance slider from 0.1 m to 1 km plus ∞, typed metres, ∞ button. Image distance in mm with ±0.01 mm nudges inside the limits. A one-line hint covers the focus model and distance reference. Auto-AF on orbit release.
  - 镜头与光圈:
    - One row for search and "available only".
    - One row for the lens select (unavailable lenses grouped and disabled with their reasons) and a 96 px configuration select (per-configuration reasons).
    - One line for focal length, sensor size and `可用 n/N`.
    - Warnings collapse to a one-line `<details>` summary: `数据提示 N 条` plus the first warning, truncated with an ellipsis. Expanding it shows the full list.
    - Aperture slider over nominal third stops between the exact limits, typed f-number, dispersion.
  - 采样: a two-line hint says the grain comes from the Monte Carlo integration over wavelength and aperture, fades roughly as 1/√spp, and that raising the target keeps accumulating. It also says there is no sensor noise and no denoising. One row for target spp (powers of two from 1 to 4096; a non-preset value from the store is added), resolution, and 重置. Below it, the high cache-miss warning (≥10 % once samples exist) with a link to the `cache-miss` view.
  - 显示: exposure −6…+6 EV in ⅓ steps plus a zero button, Bloom, view select (成像/缓存未命中/路径状态), auto/SDR output, actual output.
- **Collapsible sections**
  - 技术诊断: rate bars grouped by denominator, plus every diagnostics field. A `null` timing shows `未测量`; no values are invented.
    - 占尝试光线 (per attempted ray): 通过镜头 (`opticalPassRate`), 镜筒/光阑遮挡, 全内反射, 数值失败. The 通过镜头 row appears only when the backend provides that field.
    - 占通过镜头的光线 (per ray that passed the optics): 场景缓存未命中 (`cacheMissRate`). Each row's tooltip names its denominator.
    - The high-miss warning reads `场景缓存未命中偏高：x%（占通过镜头的光线）`.
  - 物理范围与局限: concise limitations taken from the handoff.
- **Commands**
  - Every command name dispatches exactly as in the handoff.
  - Nothing dispatches unless `status === 'ready'`, with one exception. With `status === 'error'`, the recovery commands `setMode` (both A and B), `selectLens` and `selectConfiguration` stay enabled; the lens and configuration ones only when `state.lenses` is non-empty and no lens load is in flight. A stale AF busy flag does not block recovery. All physics sliders, AF, sampling and display controls stay locked until ready. The alert suggests switching to 「A · 光栅近似」 or another lens or configuration, and the header reads `镜头后端错误 · 非镜头成像` or `· 光栅近似`. The backend may still reject a recovery command, and that rejection shows as a normal command error.
  - Optics commands are also locked while AF is busy (store or in flight) or while `selectLens`/`selectConfiguration` is in flight.
  - Repeated slider-type commands coalesce: while one is in flight, only the latest value is sent next.
  - A rejected dispatch shows `<控件>失败：<message>` in an assertive live region with a dismiss button. Controls re-sync to the store snapshot.
  - A backend `state.error` appears as `role="alert"`.
  - Typed values are checked against `limits` before dispatch, using `aria-invalid` and an inline message. Text being typed or dragged is never overwritten by a snapshot.
- **Keyboard and accessibility**
  - F triggers AF-S unless focus is in an input, select, textarea or contenteditable, a modifier is held, or the key is auto-repeating. When AF is unavailable, the reason is announced politely.
  - Esc collapses the panel and returns focus to the toggle.
  - Native controls throughout. Every input has a label, `aria-valuetext` gives f/…, distances and EV, explicit units appear everywhere, and `:focus-visible` rings are shown. Touch targets grow under `pointer:coarse`.

- **Resolution**: the engine snaps width to a multiple of 3 with a minimum of 48 (`optical-engine.js:60`). Presets are therefore 240/360/480/600/720/960, all exact. Labels mirror the snapping: 320 shows as `321×214` and 640 as `639×426`. If the store reports a non-multiple, the select shows the snapped value. If the backend later accepts arbitrary integer dimensions, only `snapResolution` in `lens-ui-format.js` needs to change.

## Revision 2 changes (after the integration screenshots)

- Order changed: AF-S, pause and progress moved into a quick bar under the mode switch, and the focus group now comes before the lens group.
- The lens and configuration selects share one row, and the meta and count text share one line.
- Raw warnings no longer push controls down: they are a collapsed one-line summary that expands to the full list.
- The sampling selects and reset share one row, and the cache-miss warning is full width below them.
- The panel moved to a narrower left column to keep the villa and pond visible. The open state is remembered.
- Image-distance and focus hints were shortened to one line each.
- Resolution presets and labels now match what the engine renders.
- New tests: snapping labels, DOM order of the common actions, open-state memory with blocked storage, collapsed warnings summary.

## Revision 3 changes

- Error-state recovery gating for `setMode`, `selectLens` and `selectConfiguration` in `isCommandEnabled`, with `RECOVERY_COMMANDS` defined in `lens-ui-format.js`.
- Uncalibrated focus display through `describeFocus()`.
- Rate denominators labelled to match `optical-engine.js` statistics.
- New tests: recovery gating as pure logic, recovery in the DOM with and without a lens catalogue, uncalibrated focus at ∞ and at a finite distance, and rate denominators.
- Codex confirmed that `reset()` only resets accumulation, so the 重置 / 重置采样 label is correct.

## Revision 4 changes

- Breakpoint transitions handled live, with separate wide and narrow memory. Fixes the bug where `narrow` and `openKey` were captured only at mount.
- Sampling-noise hint added. `<progress>` is described by it.
- AF message moved to its own line. In the real screenshot it was cut off as `待命 · 初始像…`.
- The focus field shows 4 significant digits (`40.64`). It previously showed `40.6433`, which overflowed and rendered as `40,64…` in a comma-decimal locale.
- Focus hint shortened to one line.
- **Display fidelity:** `src/style.css` has a full-screen `body::after` linear gradient over the canvas, a warm-white wash at top and bottom, with a darker night variant `body[data-night="true"]::after`. It grades the displayed image outside the HDR pipeline and adds a nonphysical vignette-like effect. `lens-ui.css` now removes it with `html body.lens-ui-mounted::after{content:none;display:none;background:none}`. Specificity (0,1,3) beats both legacy selectors (0,0,2 and 0,1,2) whatever order the stylesheets load in. This applies to both A (raster) and B (lens), so the A/B comparison and the displayed optical image are ungraded. `style.css` and the shaders are unchanged. The identity, time-panel and lens-panel backgrounds are separate elements and are kept. Raw-canvas readback tests were never affected, because the overlay is DOM-only. When the UI is disposed, the class is removed and the legacy overlay returns.
- New tests: breakpoint transitions (wide → narrow → wide, separate keys, focus leaving the hidden body, listener removed on dispose), the sampling hint, focus-field precision, and the gradient override rule with the legacy selectors left unchanged.
- Interactions Codex reported as verified in the real browser (not re-run here): lens change, configuration, keyboard focus entry, F AF, pause/exposure/Bloom/SDR keeping spp/revisions/capture, and reset/resume, with no GPU errors.

## Revision 5 changes (user request, 2026-10-15)

**Edits outside the original UI boundary.** The user asked directly to remove the branding and the Japan-time references. I made minimal targeted edits on top of the current files, with no other changes:

- `index.html`:
  - title `lens-sim — 山庭 · 山间别墅` → `lens-sim`.
  - Removed `<header class="identity">` (山庭 seal, SANTEI) and `<footer class="caption">` (01 / 山间别墅与庭园).
  - Removed `<p class="time-location">长野山地 · 日本标准时间 UTC+9</p>`.
  - Slider `aria-valuetext` `16:30，日本标准时间` → `16:30`.
  - Loading curtain: removed the 山庭 mark and 正在营造山间庭院. It keeps `#loading`, `#loading-message` (now `正在加载场景`) and the line, because `main.js` writes status and errors there.
- `src/time-controls.js`: slider `aria-valuetext` is now just the time, without `，日本标准时间`.

Kept as they were:
- `style.css`. Its `.identity` and `.caption` rules are now unused. `.loading-mark+p` no longer matches, so `lens-ui.css` styles `#loading-message` directly; `#loading.error p` still applies on error.
- The scene note `山有远色，庭有生意。`, which was not in the request. Codex later removed it from `index.html` at the user's request. The UI does not restore it.
- `astronomy.js` `SITE` (still computes the sky for Matsumoto at UTC+9). It is not displayed.
- The meta description, `window.__SANTEI__` and the README.

**Layout.** With the identity mark gone, the panel moves up:
- Wide: `top:34px`, with height up to `100dvh − 234px` because the caption reserve is gone.
- Narrow: the chip and sheet sit at `top:24px`.

**Two-layer lens choice.**
- Row 1: brand select (`全部品牌 · N`, then brands by count, `其他 / 未分类` last) plus a short search field.
- Row 2: lens select (only that brand's lenses, available and unavailable grouped, with reasons) plus the configuration select.
- When the active lens is not in the chosen brand or search, the lens select shows a disabled `选择镜头…（n）` (or `无匹配镜头`) instead of another lens. Choosing a brand dispatches nothing; only picking a lens sends `selectLens`.
- The brand follows the active lens initially and whenever the backend switches lens, unless the person picked 全部品牌.
- 仅列出可用镜头 moves under the meta line, and brand counts follow it.
- **Brand source:** the UI uses `lens.brand` when present. Codex now passes it through (`hybrid-runtime.js:201`, `brand:l.brand??null`), so the store is the source of truth. The `brandOf()` name fallback is used only if a lens has no brand (`null`). A test checks it still reproduces `public/lenses/manifest.json` brands for all 458 lenses.

**Tests.** The lens tests were rewritten for the brand → lens flow, and tests were added for brand following and for the fallback matching the manifest. Visual check in the scratchpad harness against the real 458-lens manifest: 992×785 with Nikon chosen, 390×844 open, and the neutral loading curtain.

## Revision 6 changes: centre AF-S reticle

- **What:** a small static single AF-point marker at the viewport centre: four 1.5 px corner brackets (30×20 px box) and a 2 px centre dot. Light stroke with a dark halo, so it reads on bright and dark parts of the scene. The canvas fills the viewport and the 36×24 sensor image is letterboxed about the same centre, so the viewport centre is the AF-S point.
- **Where:** `<div class="lens-ui-reticle" aria-hidden="true">`, appended directly to `<body>`. It is a sibling of the panel, not inside it, because the panel's `backdrop-filter` would become the containing block for `position:fixed` and shift the marker. CSS: `position:fixed; left:50%; top:50%; transform:translate(-50%,-50%); pointer-events:none; z-index:2`, above the canvas and below the panels and clock. Orbit dragging passes through it.
- **State, from the store only:**
  - Hidden unless `status === 'ready'`, so not shown while loading or on error.
  - `data-mode` follows `state.mode`; raster is shown at 55 % opacity.
  - `data-af` follows `state.af.status` (idle neutral, busy amber, success green, error red). An in-flight `autofocus()` request alone does not restyle it.
  - No animation, no transitions, no progress or fake focus indication.
  - It is `aria-hidden`, because AF status is already announced by the panel's status line.
- **Tests:**
  - DOM: it is a direct child of `<body>`, not inside the container, `aria-hidden`, and hidden while loading or on error. `data-af`/`data-mode` track the store and not the pending request, and `dispose()` removes it.
  - CSS: fixed at 50 %/50 % with the translate, click-through, no `backdrop-filter`, no animation, transition or keyframes, and not scoped under the panel.
- **Visual check:** in the harness at 992×785 the marker centre is at pixel (496, 392), the exact viewport centre, over the villa interior.
- No physics, GPU or `main.js` changes, and no other redesign. Branding removal and the brand → lens selection are kept as they were.

## Checks run (2026-10-15)

- `node --test tests/ui-lens.test.mjs`: 38/38 pass.
- `npm test`: 115/115 pass (the whole suite, including the current backend tests).
- `npm run build`: succeeds, with the UI now bundled through Codex's mount. The built CSS contains `html body.lens-ui-mounted:after{content:none;display:none;background:none}`.
- I did not start or stop the parent Vite server on 5173. I tried headless Chrome against it, but it stays on the loading curtain because there is no WebGPU in headless. For layout I used my scratchpad harness on port 5199 (since stopped), with `ui-before.png` as the background at 992×785, in both the day and night palettes.
- Visual check: I used a temporary harness in the session scratchpad (not in the repo). It loaded the real `index.html` markup, `style.css`, `control-store.js` and `lens-ui.js` through Vite 7.3.7 with a mocked static background and no WebGPU. I captured headless Chrome screenshots at 1440×900 (day and night), 900×760, and 390×844 collapsed and open. These are layout checks only, not screenshots of the real scene.

## Known open points for feedback

- Thresholds: the cache-miss warning starts at 10 %. Focus slider range is 0.1 m–1 km; typed values can go outside it and the backend enforces the real limits.
- The left column has been checked only against the real screenshot used as a background, not with the live canvas. A new real screenshot would confirm OrbitControls dragging next to the panel and the final scroll depth.

## Codex integration acceptance after revision 6

The live native-WebGPU page was checked at 992×785 and 390×844, including actual OrbitControls dragging, the real AF-S button result, viewport-centred click-through marker, live breakpoint switching and collapsed narrow layout without horizontal overflow. The final screenshots are `artifacts/ui-desktop-final.png` and `artifacts/ui-narrow-final.png`; backend/UI measurements are recorded in [V1 validation](validation-v1.md). This resolves the live-canvas feedback point above; it does not change Claude's harness-only verification record.

## Revision 7 (V2 geometry first hit)

- **Model and session:** Claude Code, model `claude-opus-5-5` (Opus 5.5), session `fbd71847-7724-452e-b4fb-49bf965b236f` (https://claude.ai/code/session_01LgsFp2nzrJXK2xC1uaXMcz). No sub-agents. Date: 2026-10-15. Task: the "V2 handoff" section of `docs/ui-handoff.md`.
- **Files changed:** `src/ui/lens-ui-core.js`, `src/ui/lens-ui-format.js`, `src/ui/lens-ui.css`, `tests/ui-lens.test.mjs`, and this file. I read `control-store.js`, `hybrid-runtime.js` and `optical-engine.js` to confirm the field and command names, and did not edit them. No changes to rendering, shaders, `main.js`, `index.html` or package files.
- **What changed** (small changes only; the layout and existing controls are the same):
  1. **Lens mode name:** a line under the A/B switch shows `B 模式：${renderModel.label}` ("几何首交点 + 实时光照"). The B radio is still "B · 镜头追迹", with an updated tooltip. Nothing in the UI says "路径追踪".
  2. **Scene status:** a status line shows the real `scene.status/message`: "场景准备：…" while pending or building, the backend's "BVH 就绪：…" message when ready, and "场景准备失败：…" on error. There is no percentage. In lens mode with 0 spp, the summary says "场景准备中/场景准备失败" instead of "等待首批样本" until the scene is `ready`.
  3. **Limitations:** I removed the single-layer RGB/depth, screen-space and occluded-foreground texts and replaced the scene item with the BVH first-hit + real-time lighting description (no multi-bounce GI). The `renderModel.approximations` list is shown under "物理范围与局限".
  4. **Diagnostic views:** the view select lists 成像 / 场景错误分布 / 路径状态, plus an optgroup "几何/法线/材质诊断（重新累计）" with depth, normal and material ID. It dispatches `setDiagnostic` with the backend values. A hint says the diagnostic maps skip exposure and Bloom, and that the geometry views restart accumulation. "重新扫描场景" (`rebuildScene`) is in the collapsed 技术诊断 section and is disabled while the scene is building.
  5. **Warnings:** the cache-miss warning and its "查看分布" link are gone. A warning list under the scene status shows lighting errors (error style), unsupported materials (counted, contribute zero), BVH traversal errors (> 0) and transparency limit (> 0.1 %), with the denominator "占通过镜头的光线". Lighting warnings are in 技术诊断.
  6. **Rates:** the per-attempt group shows 通过镜头 / 遮挡 / 全内反射 / 数值失败 / 场景命中 / 背景 / 辐亮度无效. The "占通过镜头的光线" group shows 场景命中 / 背景 / 未支持材质 / 透明层超限 / BVH 遍历错误 / 水面反射出参考视野. A row stays hidden until the backend publishes that field.
  7. **Performance:** the GPU compute time (`computeMs`, single tile), lighting refresh (`lightingRefreshMs` CPU submit + count), the timing source, and the BVH summary (instances, base triangles, nodes/depth, GPU bytes, build ms, Worker vs. main thread), light counts and the new revision keys. Null timings show "—" (`formatMs` now returns "—" instead of "未测量"). I removed "捕获耗时" and "场景捕获". No throughput figure is derived.
- **Tests:** in `tests/ui-lens.test.mjs`, I replaced the cache-miss tests and assertions (`cacheMissRate`, `captureMs`, `'cache-miss'`, `cacheWarn`). New tests cover: the lens mode name, scene status without progress, the approximation list, and that the old texts are gone. They also check each warning source and its threshold, the timings and BVH summary (including "—" for null), the diagnostic optgroup and restart hint, `rebuildScene` dispatch and disabling, and the rate denominators for every new field.
- **Checks run:** `node --test tests/ui-lens.test.mjs` 43/43 pass, and `npm test` 122/122 pass. I did not run `npm run build` (it needed approval in this session). I did no browser or visual check; real screenshots from Codex are still to come.

## Revision 7b (feedback from Codex's real browser run)

- **Input:** Codex ran the app in real Chromium (headless, SwiftShader WebGPU, full villa scene) at 800×500 and 390×844. Screenshots: `artifacts/ui-review/app-raster.png`, `app-lens-geometry-normal.png`, `app-lens-scene-error.png`, `app-mobile.png`. I looked at the raster and geometry-normal screenshots. Backend facts from that run: the scene was ready with 264,078 instances, lighting was ok, and all error rates were 0.
- **Same session and model** as revision 7. **Files changed:** `src/ui/lens-ui-core.js`, `src/ui/lens-ui-format.js`, `src/ui/lens-ui.css`, `tests/ui-lens.test.mjs`, and this file.
- **Changes:**
  1. **Memory hint:** the sampling hint now says "最高约 4.0 GiB". This is 9504 × 6336 × (`PIXEL_BYTES` 64 + 8 output bytes) = 4,335,648,768 B ≈ 4.04 GiB (4.3 GB), calculated from `sampling-plan.js`. The handoff said "about 4.2 GiB", but the formula gives 4.0 GiB.
  2. **One status line:** the mode name and scene status are now one compact line, e.g. `B：几何首交点 + 实时光照 · BVH 就绪 264,078 实例`. The instance count comes from `scene.summary.instances`, and the full backend message is kept as a tooltip. When ready, the line stays on one line and is cut with an ellipsis if too long. Pending, building and error states use the warn or error colour and wrap, so they are never cut or hidden.
  3. **Legends:** when a diagnostic view is selected, a one-line colour key starts the hint under the view select. scene-error: "R=BVH错误/透明层超限 · G=未支持材质 · B=水面反射出参考视野 · 黑=无". status: "R=数值失败 · G=镜头遮挡/全反射 · B=场景命中". depth: "亮=近 exp(-t/15 m)". normal: "世界法线×0.5+0.5". material: "材质 ID 哈希色".
  4. **Doc:** renamed the earlier V2 heading to "Revision 7".
- **Checks run:** `npm test` 122/122 pass. The tests assert the exact merged line, the line for each scene state, the 4.0 GiB text and every legend. I did no new browser check of the 800×500 layout.
