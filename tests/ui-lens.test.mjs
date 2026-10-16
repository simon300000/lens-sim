import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlStore } from '../src/rendering/control-store.js';
import { createLensUI } from '../src/ui/lens-ui-core.js';
import {
  computeGates, describeView, filterLenses, formatEV, formatFNumber, formatFocus, formatRate, isAutofocusShortcut,
  nearestStep, stepsForFNumber, stepsForFocus, validateFNumber, validateSpp,
} from '../src/ui/lens-ui-format.js';
import { FakeEvent, createFakeDocument, input, key, toggle } from './ui-fake-dom.mjs';

const LENSES = [
  { id: 'zemax-55', name: 'Zemax 对照 55mm', focalLengthMm: 55, available: true },
  { id: 'canon-ef-50mm-f1-8-stm', name: 'Canon EF 50mm F1.8 STM', focalLengthMm: 50, available: true },
  { id: 'doe-lens', name: 'Canon EF 400mm F4 DO IS USM', focalLengthMm: 400, available: false, reason: '含 DOE 面' },
];
const READY = {
  status: 'ready', mode: 'raster', lenses: LENSES, lensId: 'zemax-55', configurationIndex: 0,
  configurations: [{ index: 0, title: 'INF', available: true }, { index: 1, title: 'MFD', available: false, reason: '负厚度' }],
  warnings: ['第 3 面缺少通光口径'], limits: { fNumber: [1.79, 22], imageDistanceMm: [0.1, 200] },
};

/** Backend double: records dispatches; each one waits until the test settles it. */
function setup({ initial = READY, narrow = false, auto = true } = {}) {
  const doc = createFakeDocument({ narrow });
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const store = createControlStore(initial);
  const calls = [];
  store.setHandler((command) => new Promise((resolve, reject) => {
    calls.push({ ...command, resolve, reject });
    if (auto) resolve();
  }));
  const ui = createLensUI({ store, container });
  const $ = (ref) => container.querySelector(`[data-ref="${ref}"]`);
  const radio = (group, value) => container.querySelector(`[data-ref="${group}-${value}"]`);
  return { doc, container, store, ui, calls, $, radio };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const types = (calls) => calls.map((c) => [c.type, c.value]);

test('format: f-number steps include exact limits and nominal third stops', () => {
  const steps = stepsForFNumber([1.79, 22]);
  assert.equal(steps[0], 1.79);
  assert.equal(steps.at(-1), 22);
  assert.ok(steps.includes(2.8) && steps.includes(5.6) && steps.includes(11));
  assert.ok(!steps.includes(1.8), 'nominal 1.8 collapses into the 1.79 limit');
  assert.deepEqual(stepsForFNumber([2, 2]), [2]);
  assert.equal(formatFNumber(0.95), 'f/0.95');
  assert.equal(formatFNumber(2.8), 'f/2.8');
});

test('format: focus steps are log spaced and end at infinity', () => {
  const steps = stepsForFocus();
  assert.equal(steps.at(-1), null);
  assert.equal(steps[0], 0.1);
  assert.equal(steps.at(-2), 1000);
  assert.equal(steps[nearestStep(steps, 20)], 20);
  assert.equal(nearestStep(steps, null), steps.length - 1);
  assert.equal(formatFocus(null), '∞');
  assert.equal(formatFocus(0.45), '45 cm');
  assert.equal(formatFocus(3.2), '3.20 m');
});

test('format: units, rates and validation messages', () => {
  assert.equal(formatEV(0), '±0.0 EV');
  assert.equal(formatEV(1 / 3), '+0.3 EV');
  assert.equal(formatEV(-2), '−2.0 EV');
  assert.equal(formatRate(0.123), '12.3%');
  assert.equal(formatRate(0.00001), '<0.01%');
  assert.equal(validateFNumber(1.2, [1.8, 22]), '最小 f/1.8');
  assert.equal(validateFNumber(5.6, [1.8, 22]), '');
  assert.equal(validateSpp(0), ''); // zero selects continuous rendering
  assert.ok(validateSpp(-1) && validateSpp(2.5) && validateSpp(5000));
  assert.equal(validateSpp(64), '');
});

test('format: lens mode is never described as an image before samples exist', () => {
  assert.match(describeView({ status: 'ready', mode: 'raster' }).text, /光栅近似/);
  assert.match(describeView({ status: 'ready', mode: 'lens', sampling: { spp: 0, targetSpp: 64 } }).text, /等待首批样本/);
  assert.match(describeView({ status: 'ready', mode: 'lens', sampling: { spp: 12, targetSpp: 64 } }).text, /12\/64 spp/);
  assert.equal(describeView({ status: 'error', mode: 'lens' }).tone, 'error');
});

test('format: gates and keyboard shortcut rules', () => {
  assert.equal(computeGates({ status: 'loading' }).opticsLocked, true);
  assert.equal(computeGates({ status: 'ready', af: { status: 'busy' } }).afBusy, true);
  assert.equal(computeGates({ status: 'ready' }, new Set(['selectLens'])).lensLoading, true);
  assert.equal(isAutofocusShortcut({ key: 'f', target: { tagName: 'BODY' } }), true);
  assert.equal(isAutofocusShortcut({ key: 'F', target: { tagName: 'BUTTON' } }), true);
  assert.equal(isAutofocusShortcut({ key: 'f', target: { tagName: 'INPUT' } }), false);
  assert.equal(isAutofocusShortcut({ key: 'f', target: { tagName: 'DIV', isContentEditable: true } }), false);
  assert.equal(isAutofocusShortcut({ key: 'f', ctrlKey: true, target: {} }), false);
  assert.equal(isAutofocusShortcut({ key: 'f', repeat: true, target: {} }), false);
  assert.deepEqual(filterLenses(LENSES, { query: 'canon', availableOnly: true }).map((l) => l.id), ['canon-ef-50mm-f1-8-stm']);
  assert.deepEqual(filterLenses(LENSES, { brand: '佳能 Canon' }).map((l) => l.id), ['canon-ef-50mm-f1-8-stm', 'doe-lens']);
  assert.deepEqual(filterLenses(LENSES, { query: 'nothing' }), []);
});

test('mounts into the container, marks the body and disposes cleanly', () => {
  const { doc, container, store, ui, $ } = setup();
  assert.ok($('root'));
  assert.ok(doc.body.classList.contains('lens-ui-mounted'));
  ui.dispose();
  assert.equal(container.children.length, 0);
  assert.ok(!doc.body.classList.contains('lens-ui-mounted'));
  assert.equal(doc.listenerCount(), 0, 'document keydown listener removed');
  assert.equal(doc.mediaListenerCount(), 0, 'breakpoint listener removed');
  store.update({ status: 'error', error: 'late' }); // must not throw after dispose
});

test('loading state disables every command control', () => {
  const { $, radio } = setup({ initial: { status: 'loading' } });
  for (const ref of ['lensSelect', 'fRange', 'fInput', 'afButton', 'focusRange', 'focusInf', 'imageInput', 'sppSelect',
    'resSelect', 'pauseButton', 'resetButton', 'evRange', 'bloom', 'diagSelect', 'dispersion']) {
    assert.equal($(ref).disabled, true, `${ref} disabled while loading`);
  }
  assert.equal(radio('mode', 'lens').disabled, true);
  assert.match($('summary').textContent, /加载中/);
  assert.equal($('root').getAttribute('aria-busy'), 'true');
});

test('backend error is shown as an alert', () => {
  const { $ } = setup({ initial: { ...READY, status: 'error', error: 'WebGPU 设备丢失' } });
  assert.equal($('fatal').hidden, false);
  assert.match($('fatal').textContent, /WebGPU 设备丢失/);
  assert.equal($('fatal').getAttribute('role'), 'alert');
});

test('mode A/B and display controls dispatch exact command names', async () => {
  const { calls, radio, $, store } = setup();
  toggle(radio('mode', 'lens'), true);
  toggle($('bloom'), false);
  input($('diagSelect'), 'geometry-normal');
  toggle(radio('output', 'sdr'), true);
  input($('evRange'), '1');
  await flush();
  assert.deepEqual(types(calls), [['setMode', 'lens'], ['setBloom', false], ['setDiagnostic', 'geometry-normal'],
    ['setOutput', 'sdr'], ['setExposureEV', 1]]);
  assert.equal($('evZero').disabled, true, 'already at 0 EV in the store');
  store.update({ display: { ...store.getState().display, exposureEV: 1 } });
  assert.equal($('evOut').textContent, '+1.0 EV');
  $('evZero').click();
  await flush();
  assert.deepEqual(types(calls).at(-1), ['setExposureEV', 0]);
});

test('two-layer lens choice: brand first, then lens; unavailable lenses stay listed with reasons', async () => {
  const { $, calls } = setup();
  // Brand follows the active lens; the brand list shows counts, uncategorised last.
  assert.equal($('brandSelect').value, '其他 / 未分类');
  assert.deepEqual($('brandSelect').options.map((o) => o.textContent), ['全部品牌 · 3', '佳能 Canon · 2', '其他 / 未分类 · 1']);
  assert.deepEqual($('lensSelect').options.map((o) => o.value), ['zemax-55']);
  assert.match($('lensCount').textContent, /可用 2\/3 · 列出 1/);
  const mfd = $('configSelect').options.find((o) => o.value === '1');
  assert.equal(mfd.disabled, true);
  assert.match(mfd.textContent, /负厚度/);
  assert.equal($('warnings').children.length, 1);
  assert.equal($('warnDetails').hidden, false);
  assert.equal($('warnDetails').hasAttribute('open'), false, 'warnings start collapsed to a one-line summary');
  assert.match($('warnSummary').textContent, /数据提示 1 条第 3 面缺少通光口径/);

  // Choosing a brand only filters; it never dispatches by itself.
  input($('brandSelect'), '佳能 Canon');
  await flush();
  assert.equal(calls.length, 0);
  const options = $('lensSelect').options;
  assert.deepEqual(options.map((o) => o.value), ['', 'canon-ef-50mm-f1-8-stm', 'doe-lens']);
  assert.equal(options[0].disabled, true);
  assert.match(options[0].textContent, /选择镜头…（2）/);
  assert.equal($('lensSelect').value, '', 'another brand never shows a different lens as selected');
  const doe = options.find((o) => o.value === 'doe-lens');
  assert.equal(doe.disabled, true);
  assert.match(doe.textContent, /不可用：含 DOE 面/);
  assert.match($('announcer').textContent, /佳能 Canon：2 支镜头/);

  input($('lensFilter'), 'stm');
  assert.deepEqual($('lensSelect').options.map((o) => o.value), ['', 'canon-ef-50mm-f1-8-stm'], 'search narrows within the brand');
  input($('lensFilter'), 'xyz');
  assert.match($('lensSelect').options[0].textContent, /无匹配镜头/);
  input($('lensFilter'), '');
  toggle($('availableOnly'), true);
  assert.ok(!$('lensSelect').options.some((o) => o.value === 'doe-lens'));
  assert.match($('brandSelect').options.find((o) => o.value === '佳能 Canon').textContent, /· 1$/, 'counts follow the filter');

  input($('lensSelect'), 'canon-ef-50mm-f1-8-stm');
  await flush();
  assert.deepEqual(types(calls), [['selectLens', 'canon-ef-50mm-f1-8-stm']]);
});

test('brand follows the active lens when the backend switches lens, unless 全部品牌 was chosen', () => {
  const { $, store } = setup();
  store.update({ lensId: 'canon-ef-50mm-f1-8-stm' });
  assert.equal($('brandSelect').value, '佳能 Canon');
  assert.equal($('lensSelect').value, 'canon-ef-50mm-f1-8-stm');
  input($('brandSelect'), '*');
  store.update({ lensId: 'zemax-55' });
  assert.equal($('brandSelect').value, '*');
  assert.deepEqual($('lensSelect').options.map((o) => o.value).filter(Boolean).length, 3);
  assert.equal($('lensSelect').value, 'zemax-55');
});

test('brand comes from the store when present, otherwise from the name, matching the catalogue exactly', async () => {
  const { brandOf } = await import('../src/ui/lens-ui-format.js');
  const { readFile } = await import('node:fs/promises');
  assert.equal(brandOf({ name: 'Canon EF 50mm', brand: '自定义' }), '自定义');
  const manifest = JSON.parse(await readFile(new URL('../public/lenses/manifest.json', import.meta.url), 'utf8'));
  const mismatched = manifest.lenses.filter((l) => brandOf({ name: l.name, id: l.id }) !== l.brand)
    .map((l) => `${l.name} → ${brandOf({ name: l.name })} ≠ ${l.brand}`);
  assert.deepEqual(mismatched, [], 'name fallback reproduces every manifest brand');
});

test('lens loading locks optics controls but not sampling or display', async () => {
  const { $, calls } = setup({ auto: false });
  input($('brandSelect'), '佳能 Canon');
  input($('lensSelect'), 'canon-ef-50mm-f1-8-stm');
  await flush();
  assert.equal(calls.length, 1);
  for (const ref of ['fRange', 'fInput', 'afButton', 'focusRange', 'imageInput', 'dispersion', 'configSelect']) {
    assert.equal($(ref).disabled, true, `${ref} locked while lens loads`);
  }
  assert.equal($('sppSelect').disabled, false);
  assert.equal($('evRange').disabled, false);
  assert.match($('lensMeta').textContent, /正在载入镜头数据/);
  calls[0].resolve();
  await flush();
  assert.equal($('fRange').disabled, false);
});

test('AF-S: button, F shortcut outside inputs, busy lock, auto-on-release toggle', async () => {
  const { doc, $, calls, store } = setup();
  $('afButton').click();
  const doubled = key(doc.body, 'f');
  assert.equal(doubled.defaultPrevented, true);
  assert.match($('announcer').textContent, /AF-S 当前不可用/, 'no second AF while one is in flight');
  await flush();
  key(doc.body, 'f');
  const typing = key($('lensFilter'), 'f');
  toggle($('afRelease'), true);
  await flush();
  assert.deepEqual(types(calls), [['autofocus', undefined], ['autofocus', undefined], ['setAutoFocusOnRelease', true]]);
  assert.equal(typing.defaultPrevented, false, 'typing f in the search box is untouched');

  store.update({ af: { status: 'busy', message: '', autoOnRelease: true } });
  assert.equal($('afButton').disabled, true);
  assert.equal($('focusRange').disabled, true);
  assert.equal($('imageInput').disabled, true);
  assert.equal($('fRange').disabled, true);
  assert.equal($('evRange').disabled, false);
  const blocked = key(doc.body, 'F');
  assert.equal(blocked.defaultPrevented, true);
  assert.match($('announcer').textContent, /AF-S 当前不可用：正在对焦/);
  assert.equal(calls.length, 3);

  store.update({ af: { status: 'error', message: '对比度不足', autoOnRelease: true } });
  assert.equal($('afStatus').textContent, '对焦失败');
  assert.equal($('afMessage').textContent, '对比度不足', 'the backend message gets its own untruncated line');
  assert.equal($('afButton').disabled, false);
});

test('aperture slider dispatches nominal stops; typed values are checked against limits', async () => {
  const { $, calls, store } = setup();
  store.update({ optics: { ...store.getState().optics, fNumber: 2.8 } });
  const steps = stepsForFNumber([1.79, 22]);
  assert.equal($('fRange').value, String(steps.indexOf(2.8)));
  assert.equal($('fRange').getAttribute('aria-valuetext'), 'f/2.8');
  input($('fRange'), String(steps.indexOf(5.6)));
  input($('fInput'), '1.2');
  await flush();
  assert.deepEqual(types(calls), [['setFNumber', 5.6]]);
  assert.equal($('fInput').getAttribute('aria-invalid'), 'true');
  assert.match($('fHint').textContent, /最小 f\/1.8/);
  input($('fInput'), '8');
  await flush();
  assert.deepEqual(types(calls).at(-1), ['setFNumber', 8]);
  assert.equal($('fInput').hasAttribute('aria-invalid'), false);
});

test('focus distance: slider, typed metres, infinity; image distance nudges within limits', async () => {
  const { $, calls, store } = setup();
  const steps = stepsForFocus();
  input($('focusRange'), String(steps.indexOf(5)));
  await flush();
  input($('focusInput'), '3.5');
  await flush();
  $('focusInf').click();
  await flush();
  assert.deepEqual(types(calls), [['setFocusDistance', 5], ['setFocusDistance', 3.5], ['setFocusDistance', null]]);

  store.update({ optics: { ...store.getState().optics, focusDistanceM: null, imageDistanceMm: 1.234 } });
  assert.equal($('focusInf').getAttribute('aria-pressed'), 'true');
  assert.equal($('focusRange').value, String(steps.length - 1));
  assert.equal($('imageInput').value, '1.234');
  $('imagePlus').click();
  await flush();
  assert.deepEqual(types(calls).at(-1), ['setImageDistance', 1.244]);

  store.update({ optics: { ...store.getState().optics, imageDistanceMm: 0.1 } });
  assert.equal($('imageMinus').disabled, true, 'cannot nudge below the declared minimum');
  input($('imageInput'), '250');
  await flush();
  assert.equal(calls.length, 4, 'out-of-range image distance is not dispatched');
  assert.match($('imageHint').textContent, /最大 200.000 mm/);
});

test('sampling: actual progress, target, resolution, pause and reset', async () => {
  const { $, calls, store } = setup();
  store.update({ sampling: { targetSpp: 64, spp: 12, batchSpp: 2, resolution: 480, paused: false, seed: 7 } });
  assert.equal(Number($('progress').value), 12);
  assert.equal(Number($('progress').max), 64);
  assert.match($('sppText').textContent, /12 \/ 64 spp/);
  assert.match($('resSelect').options.find((o) => o.value === '480').textContent, /480×320/);
  assert.ok($('resSelect').options.every((o) => Number(o.value) % 3 === 0), 'presets are what the engine renders');
  input($('sppSelect'), '256');
  input($('resSelect'), '960');
  $('pauseButton').click();
  $('resetButton').click();
  await flush();
  assert.deepEqual(types(calls), [['setTargetSpp', 256], ['setResolution', 960], ['setPaused', true], ['reset', undefined]]);

  store.update({ sampling: { targetSpp: 100, spp: 100, batchSpp: 1, resolution: 500, paused: true, seed: 7 } }); // engine renders 501×334
  assert.match($('sppText').textContent, /已暂停/);
  assert.equal($('pauseButton').textContent, '继续采样');
  assert.equal($('pauseButton').getAttribute('aria-pressed'), 'true');
  assert.equal($('sppSelect').value, '100', 'non-preset target is still represented');
  assert.equal($('resSelect').value, '501');
  assert.match($('resSelect').options.find((o) => o.value === '501').textContent, /501×334/);
});

test('V2: lens mode name, real scene status and approximation notes come from the store', () => {
  const { $, store, container } = setup();
  // Mode name and scene state share ONE compact line.
  assert.equal($('sceneStatus').textContent, 'B：几何首交点 + 实时光照 · 场景准备：等待开始');
  assert.equal($('sceneStatus').getAttribute('data-scene'), 'pending');
  store.update({ scene: { ...store.getState().scene, status: 'building', message: '提取场景几何并在 Worker 中构建 BVH' } });
  assert.match($('sceneStatus').textContent, /^B：几何首交点 \+ 实时光照 · 场景准备：提取场景几何并在 Worker 中构建 BVH$/);
  assert.doesNotMatch($('sceneStatus').textContent, /%/, 'no invented progress');
  store.update({ scene: { ...store.getState().scene, status: 'ready', message: 'BVH 就绪：12 个实例 · 3400 个基础三角形' } });
  assert.match($('sceneStatus').textContent, /BVH 就绪：12 个实例/, 'message used until a summary exists');
  store.update({ scene: { ...store.getState().scene, summary: { instances: 264078, unsupported: [] } } });
  assert.equal($('sceneStatus').textContent, 'B：几何首交点 + 实时光照 · BVH 就绪 264,078 实例');
  assert.match($('sceneStatus').getAttribute('title'), /3400 个基础三角形/, 'full backend message kept as tooltip');
  store.update({ scene: { ...store.getState().scene, status: 'error', message: 'Worker 崩溃' } });
  assert.match($('sceneStatus').textContent, /B：几何首交点 \+ 实时光照 · 场景准备失败：Worker 崩溃/);
  assert.ok($('sceneStatus').classList.contains('lu-invalid'));
  assert.match(container.textContent, /最高约 4\.0 GiB/);
  const approximations = store.getState().renderModel.approximations;
  assert.equal($('approxList').children.length, approximations.length);
  assert.match($('approxList').textContent, /阴影来自光栅阴影贴图/);
  const text = container.textContent;
  assert.doesNotMatch(text, /单层|缓存未命中|捕获/, 'old screen-capture texts removed');
  assert.doesNotMatch(text, /路径追踪/, 'never claims path tracing');
});

test('V2: lighting errors, unsupported materials, BVH errors and transparency limit replace the cache-miss warning', () => {
  const { $, store } = setup();
  assert.equal($('sceneWarn').hidden, true);
  const base = store.getState();
  store.update({
    scene: { ...base.scene, status: 'ready', summary: { instances: 3, unsupported: [] },
      lighting: { ok: false, errors: ['阴影贴图缺失'], warnings: ['点光源阴影未启用'], lights: { directional: 1, point: 2, pointShadows: 0, hemisphere: 1 }, environment: true, reflection: true } },
  });
  assert.equal($('sceneWarn').hidden, false);
  const first = $('sceneWarn').children[0];
  assert.equal(first.getAttribute('data-level'), 'error');
  assert.match(first.textContent, /光照资源错误：阴影贴图缺失/);
  assert.match($('lightingWarnings').textContent, /点光源阴影未启用/);
  assert.equal($('lightingWarnings').hidden, false);

  store.update({ scene: { ...store.getState().scene, lighting: { ...store.getState().scene.lighting, ok: true, errors: [] }, summary: { instances: 3, unsupported: ['MeshToonMaterial', 'ShaderMaterial'] } } });
  assert.match($('sceneWarn').textContent, /未支持材质（贡献为零）：MeshToonMaterial、ShaderMaterial/);

  // Thresholds: BVH errors > 0, transparency limit > 0.1 %, both over paths that passed the lens.
  store.update({ diagnostics: { ...base.diagnostics, attemptedSamples: 1000, bvhErrorRate: 0, transparencyLimitRate: 0.001 } });
  assert.doesNotMatch($('sceneWarn').textContent, /BVH|透明层/);
  store.update({ diagnostics: { ...base.diagnostics, attemptedSamples: 1000, bvhErrorRate: 0.0002, transparencyLimitRate: 0.004 } });
  assert.match($('sceneWarn').textContent, /BVH 遍历错误 0.02%（占通过镜头的光线/);
  assert.match($('sceneWarn').textContent, /透明层超过上限 0.40%（占通过镜头的光线/);
  assert.equal($('rate-transparencyLimitRate').style.getPropertyValue('width'), '0.4%');
});

test('V2: diagnostics show real timings and BVH summary; nullable timings as —', () => {
  const { $, store } = setup();
  assert.match($('diagList').textContent, /计算耗时（GPU，单分块）—/, 'null GPU timing is not invented');
  assert.match($('diagList').textContent, /光照刷新（CPU 提交）— · 0 次/);
  assert.match($('diagList').textContent, /BVH 构建—/);
  store.update({
    diagnostics: { ...store.getState().diagnostics, computeMs: 3.456, lightingRefreshMs: 12.34, lightingRefreshes: 2 },
    scene: { ...store.getState().scene, status: 'ready', summary: { instances: 12, uniqueTriangles: 3400, bvhNodes: 5000, tlasDepth: 4, maxBlasDepth: 18,
      gpuBytes: 2 * 1024 * 1024, buildWallMs: 85.2, worker: true, unsupported: [] } },
    revisions: { geometry: 1, material: 2, lighting: 3, camera: 4, optics: 5, display: 6, accumulation: 7 },
  });
  const text = $('diagList').textContent;
  assert.match(text, /计算耗时（GPU，单分块）3.46 ms/);
  assert.match(text, /光照刷新（CPU 提交）12.3 ms · 2 次/);
  assert.match(text, /场景实例12/);
  assert.match(text, /基础三角形3,400/);
  assert.match(text, /BVH 节点 \/ 深度5,000 \/ TLAS 4 · BLAS ≤18/);
  assert.match(text, /BVH 显存2.0 MiB/);
  assert.match(text, /BVH 构建85.2 ms · Worker/);
  assert.match(text, /1 \/ 2 \/ 3 \/ 4 \/ 5 \/ 6 \/ 7/);
  assert.doesNotMatch(text, /捕获/);
});

test('V2: geometry diagnostics are grouped with a restart hint; rebuildScene dispatches', async () => {
  const { $, store, calls } = setup();
  const values = $('diagSelect').options.map((o) => o.value);
  assert.deepEqual(values, ['beauty', 'scene-error', 'status', 'geometry-depth', 'geometry-normal', 'geometry-material']);
  const group = $('diagSelect').querySelector('optgroup');
  assert.match(group.getAttribute('label'), /几何\/法线\/材质诊断（重新累计）/);
  assert.equal(group.children.length, 3);
  assert.equal($('diagHint').textContent, '');
  store.update({ display: { ...store.getState().display, diagnostic: 'geometry-depth' } });
  assert.match($('diagHint').textContent, /^亮=近 exp\(-t\/15 m\) · 不经曝光\/Bloom · 切换几何类视图会重新累计$/);
  store.update({ display: { ...store.getState().display, diagnostic: 'geometry-normal' } });
  assert.match($('diagHint').textContent, /^世界法线×0\.5\+0\.5 · /);
  store.update({ display: { ...store.getState().display, diagnostic: 'geometry-material' } });
  assert.match($('diagHint').textContent, /^材质 ID 哈希色 · /);
  store.update({ display: { ...store.getState().display, diagnostic: 'status' } });
  assert.match($('diagHint').textContent, /^R=数值失败 · G=镜头遮挡\/全反射 · B=场景命中 · 不经曝光\/Bloom$/);
  store.update({ display: { ...store.getState().display, diagnostic: 'scene-error' } });
  assert.match($('diagHint').textContent, /^R=BVH错误\/透明层超限 · G=未支持材质 · B=水面反射出参考视野 · 黑=无 · /);
  assert.doesNotMatch($('diagHint').textContent, /重新累计/);
  $('rebuildButton').click();
  await flush();
  assert.deepEqual(types(calls), [['rebuildScene', undefined]]);
  store.update({ scene: { ...store.getState().scene, status: 'building' } });
  assert.equal($('rebuildButton').disabled, true, 'no second rebuild while one is building');
});

test('command failures are shown, controls re-sync to the store, errors can be dismissed', async () => {
  const { $, calls, radio } = setup({ auto: false });
  toggle(radio('mode', 'lens'), true);
  await flush();
  calls[0].reject(new Error('镜头不可用：未知玻璃'));
  await flush();
  const item = $('errors').children[0];
  assert.match(item.textContent, /画面模式失败：镜头不可用：未知玻璃/);
  assert.equal(radio('mode', 'raster').checked, true, 'radio returns to the real mode');
  item.querySelector('[data-dismiss]').click();
  assert.equal($('errors').children.length, 0);
});

test('slider commands coalesce: only the latest value follows an in-flight one', async () => {
  const { $, calls } = setup({ auto: false });
  input($('evRange'), '1');
  input($('evRange'), '2');
  input($('evRange'), '3');
  await flush();
  assert.deepEqual(types(calls), [['setExposureEV', 1]]);
  calls[0].resolve();
  await flush();
  assert.deepEqual(types(calls), [['setExposureEV', 1], ['setExposureEV', 3]]);
});

test('summary states raster vs lens honestly, including diagnostic views', () => {
  const { $, store } = setup();
  assert.match($('summary').textContent, /光栅近似预览（非镜头成像）/);
  store.update({ mode: 'lens', sampling: { ...store.getState().sampling, spp: 0 } });
  assert.match($('summary').textContent, /场景准备中，尚无样本/, 'no samples before the BVH is ready');
  store.update({ scene: { ...store.getState().scene, status: 'error', message: 'Worker 失败' } });
  assert.match($('summary').textContent, /场景准备失败，无样本/);
  store.update({ scene: { ...store.getState().scene, status: 'ready', message: 'BVH 就绪' } });
  assert.match($('summary').textContent, /等待首批样本/);
  store.update({ sampling: { ...store.getState().sampling, spp: 8, targetSpp: 64 } });
  assert.match($('summary').textContent, /镜头追迹 · 8\/64 spp/);
  store.update({ display: { ...store.getState().display, diagnostic: 'scene-error' } });
  assert.match($('summary').textContent, /诊断视图：场景错误分布（非成像）/);
});

test('panel collapses with the toggle and Escape; starts collapsed on narrow screens', () => {
  const wide = setup();
  assert.equal(wide.$('toggle').getAttribute('aria-expanded'), 'true');
  wide.$('afButton').focus();
  key(wide.$('afButton'), 'Escape');
  assert.equal(wide.$('toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(wide.$('body').hidden, true);
  assert.equal(wide.doc.activeElement, wide.$('toggle'));
  wide.$('toggle').click();
  assert.equal(wide.$('body').hidden, false);

  const narrow = setup({ narrow: true });
  assert.equal(narrow.$('toggle').getAttribute('aria-expanded'), 'false');
  assert.match(narrow.$('summary').textContent, /光栅近似/, 'state stays visible while collapsed');
});

test('every form control has an accessible name', () => {
  const { container } = setup();
  const labelled = new Set(container.querySelectorAll('label').map((l) => l.getAttribute('for')).filter(Boolean));
  for (const el of [...container.querySelectorAll('input'), ...container.querySelectorAll('select')]) {
    const wrapped = (() => { for (let n = el.parentNode; n; n = n.parentNode) if (n.tagName === 'LABEL') return true; return false; })();
    assert.ok(wrapped || labelled.has(el.id) || el.getAttribute('aria-label'), `${el.getAttribute('data-ref') || el.tagName} needs a label`);
  }
  for (const button of container.querySelectorAll('button')) {
    assert.ok(button.textContent.trim() || button.getAttribute('aria-label'), 'button needs a name');
  }
});

test('typing does not get overwritten by store updates', () => {
  const { $, store } = setup();
  const field = $('focusInput');
  field.focus();
  field.value = '12';
  field.dispatchEvent(new FakeEvent('input'));
  store.update({ sampling: { ...store.getState().sampling, spp: 4 } });
  assert.equal(field.value, '12');
  field.blur();
  assert.equal(field.value, '20', 'blur without commit returns to the real focus distance');
});

test('format: resolution labels mirror the engine snapping width to multiples of 3', async () => {
  const { resolutionLabel, snapResolution, RESOLUTION_PRESETS } = await import('../src/ui/lens-ui-format.js');
  assert.equal(resolutionLabel(320), '321×214');
  assert.equal(resolutionLabel(640), '639×426');
  assert.equal(resolutionLabel(480), '480×320');
  assert.equal(snapResolution(20), 48);
  for (const width of RESOLUTION_PRESETS) assert.equal(snapResolution(width), width);
});

test('common actions come first: AF-S, pause and progress sit before the focus and lens groups', () => {
  const { container } = setup();
  const order = [...container.querySelector('[data-ref="body"]').descendants()]
    .map((el) => el.getAttribute('data-ref')).filter(Boolean);
  const at = (ref) => order.indexOf(ref);
  assert.ok(at('afButton') < at('focusGroup') && at('pauseButton') < at('focusGroup') && at('progress') < at('focusGroup'));
  assert.ok(at('focusGroup') < at('lensGroup') && at('lensGroup') < at('samplingGroup'));
});

test('panel open state is remembered per layout and survives missing storage', () => {
  const memory = new Map();
  const make = (storage) => {
    const doc = createFakeDocument();
    doc.defaultView.localStorage = storage;
    const container = doc.createElement('div');
    doc.body.appendChild(container);
    const store = createControlStore(READY);
    const ui = createLensUI({ store, container });
    return { ui, toggleButton: container.querySelector('[data-ref="toggle"]') };
  };
  const storage = { getItem: (k) => (memory.has(k) ? memory.get(k) : null), setItem: (k, v) => memory.set(k, v) };
  const first = make(storage);
  first.toggleButton.click();
  assert.equal(memory.get('lens-ui:open:wide'), 'false');
  first.ui.dispose();
  assert.equal(make(storage).toggleButton.getAttribute('aria-expanded'), 'false');
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const fallback = make(broken);
  assert.equal(fallback.toggleButton.getAttribute('aria-expanded'), 'true');
  fallback.toggleButton.click();
  assert.equal(fallback.toggleButton.getAttribute('aria-expanded'), 'false');
});

test('format: recovery commands are the only ones allowed in the error state', async () => {
  const { isCommandEnabled } = await import('../src/ui/lens-ui-format.js');
  const failed = { status: 'error', lenses: LENSES, af: { status: 'busy' } };
  assert.equal(isCommandEnabled('setMode', failed), true);
  assert.equal(isCommandEnabled('selectLens', failed), true, 'a stale AF flag does not block recovery');
  assert.equal(isCommandEnabled('selectConfiguration', failed), true);
  for (const type of ['setFNumber', 'setFocusDistance', 'setImageDistance', 'autofocus', 'setDispersion', 'setTargetSpp', 'setPaused', 'reset', 'setExposureEV']) {
    assert.equal(isCommandEnabled(type, failed), false, `${type} stays locked in error`);
  }
  assert.equal(isCommandEnabled('selectLens', { status: 'error', lenses: [] }), false, 'no catalogue, no lens recovery');
  assert.equal(isCommandEnabled('selectLens', failed, new Set(['selectLens'])), false);
  assert.equal(isCommandEnabled('setMode', { status: 'loading' }), false, 'loading is not an error state');
});

test('error state keeps A/B and lens recovery usable, physics and AF locked', async () => {
  const { $, radio, calls, doc } = setup({ initial: { ...READY, status: 'error', error: 'GPU 数值异常', mode: 'lens' } });
  assert.equal(radio('mode', 'raster').disabled, false);
  assert.equal(radio('mode', 'lens').disabled, false);
  assert.equal($('lensSelect').disabled, false);
  assert.equal($('configSelect').disabled, false);
  assert.equal($('lensFilter').disabled, false);
  for (const ref of ['fRange', 'fInput', 'afButton', 'focusRange', 'focusInput', 'focusInf', 'imageInput', 'imagePlus',
    'dispersion', 'sppSelect', 'resSelect', 'pauseButton', 'resetButton', 'evRange', 'bloom', 'diagSelect']) {
    assert.equal($(ref).disabled, true, `${ref} locked until ready`);
  }
  assert.match($('fatal').textContent, /GPU 数值异常.*光栅近似/);
  assert.match($('summary').textContent, /镜头后端错误 · 非镜头成像/);
  toggle(radio('mode', 'raster'), true);
  await flush();
  assert.equal($('brandSelect').disabled, false);
  input($('brandSelect'), '佳能 Canon');
  input($('lensSelect'), 'canon-ef-50mm-f1-8-stm');
  await flush();
  key(doc.body, 'f');
  await flush();
  assert.deepEqual(types(calls), [['setMode', 'raster'], ['selectLens', 'canon-ef-50mm-f1-8-stm']]);
  assert.match($('announcer').textContent, /AF-S 当前不可用：镜头后端错误/);
});

test('error state without a lens catalogue allows only the mode switch', () => {
  const { $, radio } = setup({ initial: { status: 'error', error: '引擎创建失败', lenses: [] } });
  assert.equal(radio('mode', 'raster').disabled, false);
  assert.equal($('lensSelect').disabled, true);
  assert.equal($('configSelect').disabled, true);
});

test('uncalibrated focus after image-distance micro-adjust is never shown as infinity or a measured distance', () => {
  const { $, store } = setup();
  store.update({ optics: { ...store.getState().optics, focusDistanceM: null, focusDistanceKnown: false, imageDistanceMm: 1.05 } });
  assert.equal($('focusInf').getAttribute('aria-pressed'), 'false', 'last request was ∞ but that is no longer the state');
  assert.equal($('focusInput').value, '');
  assert.equal($('focusInput').placeholder, '未标定');
  assert.match($('focusHint').textContent, /物距未标定（上次设定 ∞）：像距已微调，实际物距未换算/);
  assert.match($('focusRange').getAttribute('aria-valuetext'), /未标定/);

  store.update({ optics: { ...store.getState().optics, focusDistanceM: 3.2, focusDistanceKnown: false } });
  assert.match($('focusHint').textContent, /上次设定 3.20 m/);
  assert.equal($('focusInput').value, '', 'the last request is not shown as the current calibrated value');

  store.update({ optics: { ...store.getState().optics, focusDistanceM: 3.2, focusDistanceKnown: true } });
  assert.equal($('focusInput').value, '3.2');
  assert.doesNotMatch($('focusHint').textContent, /未标定/);
});

test('rate labels state their denominators', () => {
  const { $, store } = setup();
  assert.equal($('rateRow-opticalPassRate').hidden, true, 'optional field hidden until the backend provides it');
  store.update({ diagnostics: { ...store.getState().diagnostics, attemptedSamples: 1000, opticalPassRate: 0.5, tirRate: 0.01, sceneHitOfPassed: 0.8 } });
  assert.equal($('rateRow-opticalPassRate').hidden, false);
  assert.match($('rates').textContent, /占尝试光线通过镜头/);
  assert.match($('rates').textContent, /占通过镜头的光线场景命中/);
  for (const key of ['sceneHitOfPassed', 'backgroundOfPassed', 'unsupportedRate', 'transparencyLimitRate', 'bvhErrorRate', 'reflectionOutsideRate']) {
    assert.match($(`rateRow-${key}`).getAttribute('title'), /占通过镜头的光线/, key);
  }
  for (const key of ['opticalBlockedRate', 'tirRate', 'numericalErrorRate', 'hitRate', 'backgroundRate', 'radianceInvalidRate']) {
    assert.match($(`rateRow-${key}`).getAttribute('title'), /占尝试光线/, key);
  }
  assert.equal($('rateText-sceneHitOfPassed').textContent, '80.0%');
  assert.equal($('rateRow-hitRate').hidden, true, 'hidden until the backend publishes it');
  assert.equal($('rateRow-cacheMissRate'), null, 'removed field has no row');
});

test('live breakpoint changes re-apply the remembered choice for each layout', () => {
  const memory = new Map();
  const doc = createFakeDocument();
  doc.defaultView.localStorage = { getItem: (k) => (memory.has(k) ? memory.get(k) : null), setItem: (k, v) => memory.set(k, v) };
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  createLensUI({ store: createControlStore(READY), container });
  const toggleButton = container.querySelector('[data-ref="toggle"]');
  const body = container.querySelector('[data-ref="body"]');
  const expanded = () => toggleButton.getAttribute('aria-expanded');

  assert.equal(expanded(), 'true', 'wide default: open');
  container.querySelector('[data-ref="afButton"]').focus();
  doc.setNarrow(true);
  assert.equal(expanded(), 'false', 'narrow default: collapsed, not the wide choice');
  assert.equal(body.hidden, true);
  assert.equal(doc.activeElement, toggleButton, 'focus leaves the hidden body');

  toggleButton.click();
  assert.equal(memory.get('lens-ui:open:narrow'), 'true', 'narrow choice stored under the narrow key');
  assert.equal(memory.has('lens-ui:open:wide'), false);

  doc.setNarrow(false);
  assert.equal(expanded(), 'true', 'back to wide default');
  toggleButton.click();
  assert.equal(memory.get('lens-ui:open:wide'), 'false');

  doc.setNarrow(true);
  assert.equal(expanded(), 'true', 'narrow remembers open');
  doc.setNarrow(false);
  assert.equal(expanded(), 'false', 'wide remembers collapsed');
});

test('sampling hint explains Monte Carlo noise without claiming denoising', () => {
  const { $ } = setup();
  assert.match($('sppHint').textContent, /蒙特卡罗/);
  assert.match($('sppHint').textContent, /1\/√spp/);
  assert.match($('sppHint').textContent, /不含传感器噪声，不做降噪/);
  assert.ok($('progress').getAttribute('aria-describedby').includes($('sppHint').id));
});

test('focus field shows four significant digits so it fits', () => {
  const { $, store } = setup();
  store.update({ optics: { ...store.getState().optics, focusDistanceM: 40.64321, focusDistanceKnown: true } });
  assert.equal($('focusInput').value, '40.64');
});

test('mounted UI CSS removes the legacy full-screen gradient over the canvas in day and night', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../src/ui/lens-ui.css', import.meta.url), 'utf8');
  const rule = /html body\.lens-ui-mounted::after\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'override rule present');
  assert.match(rule[1], /content:none/);
  assert.match(rule[1], /display:none/);
  // (0,1,3) must outrank both legacy selectors: body::after (0,0,2) and body[data-night="true"]::after (0,1,2).
  const legacy = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.ok(legacy.includes('body::after') && legacy.includes('body[data-night="true"]::after'), 'legacy selectors unchanged');
  assert.equal(/\.lens-ui-mounted[^{]*\.(identity|time-controls)/.test(css), false, 'identity and clock styling untouched');
});

test('centre AF-S reticle: body-level sibling, hidden unless ready, styled only from real store state, removed on dispose', async () => {
  const { doc, container, store, ui, $, calls } = setup({ initial: { ...READY, status: 'loading' }, auto: false });
  const reticle = doc.body.querySelector('[data-ref="reticle"]');
  assert.ok(reticle, 'mounted');
  assert.equal(reticle.parentNode, doc.body, 'direct child of body, outside the backdrop-filter panel');
  assert.equal(container.querySelector('[data-ref="reticle"]'), null);
  assert.equal(reticle.getAttribute('aria-hidden'), 'true');
  assert.equal(reticle.hidden, true, 'hidden while loading');

  store.update({ status: 'ready', mode: 'lens', af: { status: 'idle', message: '', autoOnRelease: false } });
  assert.equal(reticle.hidden, false);
  assert.equal(reticle.getAttribute('data-af'), 'idle');
  assert.equal(reticle.getAttribute('data-mode'), 'lens');

  $('afButton').click();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(reticle.getAttribute('data-af'), 'idle', 'an in-flight request alone does not restyle the marker');
  store.update({ af: { status: 'busy', message: '', autoOnRelease: false } });
  assert.equal(reticle.getAttribute('data-af'), 'busy');
  store.update({ af: { status: 'success', message: '', autoOnRelease: false } });
  assert.equal(reticle.getAttribute('data-af'), 'success');
  store.update({ mode: 'raster' });
  assert.equal(reticle.getAttribute('data-mode'), 'raster');
  store.update({ status: 'error', error: 'GPU 数值异常' });
  assert.equal(reticle.hidden, true, 'hidden on backend error');

  ui.dispose();
  assert.equal(doc.body.querySelector('[data-ref="reticle"]'), null, 'dispose removes the marker');
});

test('reticle CSS: fixed at the exact viewport centre, click-through, static, outside any filter', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../src/ui/lens-ui.css', import.meta.url), 'utf8');
  const rule = /\.lens-ui-reticle\{([^}]*)\}/.exec(css)[1];
  for (const decl of ['position:fixed', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)', 'pointer-events:none']) {
    assert.ok(rule.includes(decl), `reticle rule has ${decl}`);
  }
  assert.ok(!/backdrop-filter/.test(rule), 'no backdrop-filter on the marker itself');
  const reticleCss = css.split(/\r?\n/).filter((line) => /reticle/.test(line)).join(' ');
  assert.ok(!/animation|transition|@keyframes/.test(reticleCss), 'no animation');
  assert.ok(!/\.lens-ui[^-{]*\.lens-ui-reticle|\.lu-body[^{]*reticle/.test(css), 'not scoped under the panel');
});


test('continuous sampling is selectable, never complete, and remains pausable', async () => {
  const { $, calls, store } = setup();
  input($('sppSelect'), '0');
  await flush();
  assert.deepEqual(types(calls), [['setTargetSpp', 0]]);
  store.update({sampling:{...store.getState().sampling,targetSpp:0,spp:5000}});
  assert.match($('sppText').textContent,/持续采样.*5,000/);
  assert.equal($('progress').getAttribute('value'),null);
  assert.ok($('resSelect').options.some(o=>o.value==='6000'));
  assert.ok($('resSelect').options.some(o=>o.value==='9504'));
  assert.doesNotMatch(describeView({...store.getState(),mode:'lens'}).text,/完成/);
  store.update({sampling:{...store.getState().sampling,paused:true}});
  assert.match($('sppText').textContent,/已暂停/);
  $('pauseButton').click();await flush();
  assert.deepEqual(types(calls).at(-1),['setPaused',false]);
});

test('lens choices sort by increasing focal length after filtering without changing the catalogue', () => {
  const original = [...LENSES, {id:'unknown',name:'Unknown',focalLengthMm:null}];
  assert.deepEqual(filterLenses(original).map(l=>l.id), ['canon-ef-50mm-f1-8-stm','zemax-55','doe-lens','unknown']);
  assert.deepEqual(filterLenses(original,{availableOnly:true,brand:'佳能 Canon'}).map(l=>l.id), ['canon-ef-50mm-f1-8-stm']);
  assert.equal(original[0].id,'zemax-55');
});

test('P toggles the floating diagnostics window; its corner cycles and is remembered', () => {
  const memory = new Map();
  const doc = createFakeDocument();
  doc.defaultView.localStorage = { getItem: (k) => (memory.has(k) ? memory.get(k) : null), setItem: (k, v) => memory.set(k, v) };
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const ui = createLensUI({ store: createControlStore(READY), container });
  const $ = (ref) => container.querySelector(`[data-ref="${ref}"]`);
  assert.equal($('hud').hidden, true, 'off by default');
  key(doc, 'p');
  assert.equal($('hud').hidden, false);
  assert.equal($('hudToggle').getAttribute('aria-pressed'), 'true');
  assert.equal($('hud').getAttribute('data-corner'), 'br');
  $('hudCorner').click();
  assert.equal($('hud').getAttribute('data-corner'), 'bl');
  assert.deepEqual(JSON.parse(memory.get('lens-ui:hud')), { open: true, corner: 'bl' });
  ui.dispose();
  const again = doc.createElement('div'); doc.body.appendChild(again);
  createLensUI({ store: createControlStore(READY), container: again });
  const hud = again.querySelector('[data-ref="hud"]');
  assert.equal(hud.hidden, false, 'reopens where it was');
  assert.equal(hud.getAttribute('data-corner'), 'bl');
});

test('L opens the workbench, which loads the source record into an editable table', async () => {
  const record = { id: 'r', name: 'R lens', tx: '50 5 N-BK7 10\n-50 40 - 10', stop: 1, fno: 4, apmode: 'fno' };
  const { doc, $, calls, container } = setup({ auto: false });
  key(doc, 'l');
  assert.equal($('bench').hidden, false);
  const read = calls.find((c) => c.type === 'getLensRecord');
  assert.ok(read, 'asks the backend for the editable record');
  read.resolve(record);
  await flush(); await flush();
  const cells = container.querySelectorAll('[data-field="R"]');
  assert.deepEqual(cells.map((c) => c.value), ['50', '-50']);
  assert.ok(cells.every((c) => c.getAttribute('aria-label')), 'every cell is labelled');
  assert.equal($('benchApply').disabled, true, 'nothing to apply before an edit');
});

test('save picture dispatches exportImage and is disabled until a lens sample exists', async () => {
  const { $, store, calls } = setup({ auto: false });
  assert.equal($('exportButton').disabled, false, 'raster view can be saved');
  store.update({ mode: 'lens', sampling: { ...store.getState().sampling, spp: 0 } });
  assert.equal($('exportButton').disabled, true, 'no lens image yet');
  store.update({ sampling: { ...store.getState().sampling, spp: 4 } });
  $('exportButton').click();
  await flush();
  assert.ok(calls.some((c) => c.type === 'exportImage'));
});

test('GPU work counting follows the HUD: on while open and ready, off when closed', async () => {
  const { doc, $, calls, store } = setup({ initial: { ...READY, status: 'loading' } });
  key(doc, 'p');
  await flush();
  assert.ok(!calls.some((c) => c.type === 'setWorkCounting'), 'not before the backend is ready');
  store.update({ status: 'ready' });
  await flush();
  assert.deepEqual(calls.filter((c) => c.type === 'setWorkCounting').map((c) => c.value), [true]);
  $('hudClose').click();
  await flush();
  assert.deepEqual(calls.filter((c) => c.type === 'setWorkCounting').map((c) => c.value), [true, false]);
});
