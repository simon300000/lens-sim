/**
 * Lens panel DOM. The store snapshot is the only source of truth: controls
 * dispatch commands and re-render from the next snapshot; nothing here touches
 * the renderer, the camera or optics math.
 */
import {
  ACTUAL_OUTPUT_LABELS, AF_LABELS, DIAGNOSTIC_LABELS, DIAGNOSTIC_LEGENDS, GEOMETRY_DIAGNOSTICS, OUTPUT_LABELS, RESOLUTION_PRESETS,
  SPP_PRESETS, STATUS_LABELS, snapResolution, describeFocus, describeScene, sceneWarnings, ALL_BRANDS, brandOf, brandGroups, computeGates, describeView, errorMessage, filterLenses, formatBytes, formatCount,
  formatEV, formatFNumber, formatFocus, formatMs, formatRate, isAutofocusShortcut, isCommandEnabled,
  lensOptionLabel, nearestStep, resolutionLabel, samplingText, stepsForFNumber, stepsForFocus, validateFNumber,
  validateFocus, validateImageDistance,
  isKeyShortcut,
} from './lens-ui-format.js';
import { createLensBench, drawLayoutSVG, layoutFor } from './lens-bench.js';
import { downloadBlob } from '../rendering/image-export.js';
import { WORK_GROUPS } from '../rendering/work-model.js';
import { RASTER_QUALITY_DEFAULTS } from '../rendering/raster-quality.js';

const COMMAND_LABELS = {
  setMode: '画面模式', selectLens: '选择镜头', selectConfiguration: '镜头配置', setFNumber: '光圈',
  setFocusDistance: '对焦距离', setImageDistance: '像距', autofocus: 'AF-S', setAutoFocusOnRelease: '松手自动对焦',
  setTargetSpp: '目标 spp', setResolution: '分辨率', setPaused: '暂停/继续', reset: '重置采样',
  setDispersion: '色散', setExposureEV: '显示曝光', setBloom: 'Bloom', setDiagnostic: '诊断视图', setOutput: '输出',
  rebuildScene: '重新扫描场景', exportImage: '保存图片', loadCustomLens: '载入编辑处方', setRasterQuality: '光栅画质',
};
/** Slider-like commands coalesce to the latest value while one is in flight. */
const COALESCED = new Set(['setFNumber', 'setFocusDistance', 'setImageDistance', 'setExposureEV', 'setTargetSpp',
  'setResolution', 'selectLens', 'selectConfiguration', 'setDiagnostic', 'setOutput', 'setMode']);
const FOCUS_STEPS = stepsForFocus();
const IMAGE_NUDGE_MM = 0.01;

const LIMITATIONS = [
  '镜头：按实际处方逆向折射追迹；每条尝试路径取一个连续波长，失败路径记为零、不补样；XYZ 以 f32 累积。',
  '场景：通过镜头的每条路径与真实场景几何（BVH）求最近交点，并在交点处用实时光照着色；不做多次反弹全局光照。RGB→光谱为近似重建。',
  '未模拟：镀膜与透过率（T=1）、鬼影、波动衍射成像、传感器噪声。f 值为几何光圈，不是 T 值。',
  '对焦：固定镜组，整体移动传感器（无内对焦）；距离自物方第一面顶点起算。',
  '支持 XODD 扩展奇次面和 DOE 指定阶次追迹；未知玻璃、其他特殊面及数值预检失败的配置标为不可用。',
];

let instances = 0;

export function createLensUI({ store, container, liveStats = null } = {}) {
  if (!store || typeof store.subscribe !== 'function' || typeof store.dispatch !== 'function') {
    throw new TypeError('createLensUI 需要 store（getState/subscribe/dispatch）');
  }
  if (!container?.ownerDocument) throw new TypeError('createLensUI 需要挂载容器 container');
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const uid = `lens-ui-${++instances}`;
  const refs = {};
  const cleanups = [];
  const pending = new Set();
  const queued = new Map();
  const commandErrors = new Map();
  const fieldErrors = new Map();
  let state = typeof store.getState === 'function' ? store.getState() : {};
  let disposed = false;
  let lensOptionsKey = '';
  let brandFilter = null; // null: follow the active lens's brand
  let brandForLensId;
  let configOptionsKey = '';
  let errorsKey = '';
  let warningsKey = '';

  const on = (target, type, fn, options) => {
    target.addEventListener(type, fn, options);
    cleanups.push(() => target.removeEventListener(type, fn, options));
  };

  function h(tag, props = {}, ...children) {
    const el = doc.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === false || value === null || value === undefined) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'ref') { refs[value] = el; el.setAttribute('data-ref', value); }
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.appendChild(typeof child === 'string' ? doc.createTextNode(child) : child);
    }
    return el;
  }
  const id = (name) => `${uid}-${name}`;
  const label = (forName, text, extra = {}) => h('label', { for: id(forName), class: 'lu-label', ...extra }, text);
  const hint = (ref, text = '') => h('p', { class: 'lu-hint', ref, id: id(ref), text });
  const check = (ref, text, extra = {}) => h('label', { class: 'lu-check' },
    h('input', { type: 'checkbox', ref, id: id(ref), ...extra }), h('span', { text }));
  function radios(ref, legend, options) {
    return h('fieldset', { class: 'lu-seg', ref },
      h('legend', { class: 'lu-label', text: legend }),
      h('div', { class: 'lu-seg-track' }, options.map(([value, text, title]) => h('label', { class: 'lu-seg-item', title },
        h('input', { type: 'radio', name: id(ref), value, 'data-ref': `${ref}-${value}` }), h('span', { text })))));
  }

  // ---------------------------------------------------------------- layout
  const group = (ref, title, valueRef, ...children) => h('section', { class: 'lu-group', ref, 'aria-labelledby': id(`h-${ref}`) },
    h('div', { class: 'lu-group-head' }, h('h3', { id: id(`h-${ref}`), text: title }), valueRef ? h('span', { class: 'lu-group-value', ref: valueRef }) : null),
    ...children);
  const thumb = doc.createElementNS ? doc.createElementNS('http://www.w3.org/2000/svg', 'svg') : doc.createElement('svg');
  thumb.setAttribute('class', 'lu-thumb-svg'); thumb.setAttribute('aria-hidden', 'true');
  const root = h('section', { class: 'lens-ui', ref: 'root', 'aria-label': '镜头模拟控制' },
    h('div', { class: 'lu-head' },
      h('button', { type: 'button', class: 'lu-toggle', ref: 'toggle', id: id('toggle'), 'aria-controls': id('body') },
        h('span', { class: 'lu-mark', 'aria-hidden': 'true' }),
        h('span', { class: 'lu-title', text: '镜头' }),
        h('span', { class: 'lu-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'lu-summary', ref: 'summary' }),
        h('span', { class: 'lu-chevron', 'aria-hidden': 'true' }))),
    h('div', { class: 'lu-body', ref: 'body', id: id('body'), role: 'region', 'aria-labelledby': id('toggle') },
      h('div', { class: 'lu-alert', ref: 'fatal', role: 'alert', hidden: true }),
      h('ul', { class: 'lu-errors', ref: 'errors', 'aria-live': 'assertive', 'aria-label': '命令失败' }),

      radios('mode', '画面', [['raster', 'A · 光栅预览', '现有 RGB 光栅画面，不经过镜头'], ['lens', 'B · 镜头追迹', '按镜头处方追迹，场景取几何首交点并实时着色']]),
      h('p', { class: 'lu-hint lu-scene', ref: 'sceneStatus', role: 'status' }),
      h('ul', { class: 'lu-scene-warn', ref: 'sceneWarn', 'aria-live': 'polite', 'aria-label': '场景与光照警告', hidden: true }),

      // Capture bar: the actions used every few seconds stay at the top.
      h('div', { class: 'lu-quick', ref: 'quick', role: 'group', 'aria-label': '常用操作' },
        h('div', { class: 'lu-af' },
          h('button', { type: 'button', class: 'lu-btn lu-primary lu-af-btn', ref: 'afButton', 'aria-keyshortcuts': 'F', 'aria-label': 'AF-S 单次自动对焦（快捷键 F）', 'aria-describedby': `${id('afStatus')} ${id('afMessage')}` }, 'AF-S', h('kbd', { text: 'F' })),
          h('span', { class: 'lu-af-status', ref: 'afStatus', id: id('afStatus'), role: 'status' }),
          h('button', { type: 'button', class: 'lu-btn', ref: 'pauseButton' }),
          h('button', { type: 'button', class: 'lu-icon-btn lu-export', ref: 'exportButton', 'aria-label': '保存当前画面为 PNG', title: '保存图片（PNG）：镜头模式为完整分辨率的累计图像' }, h('span', { class: 'lu-i-download', 'aria-hidden': 'true' }))),
        h('p', { class: 'lu-hint lu-af-message', ref: 'afMessage', id: id('afMessage') }),
        h('div', { class: 'lu-progress-row' },
          h('progress', { ref: 'progress', id: id('progress'), max: 1, value: 0, 'aria-label': '采样进度', 'aria-describedby': `${id('sppText')} ${id('sppHint')}`, title: '每像素实际尝试路径 / 目标；颗粒随 spp 增加而减弱' }),
          h('span', { class: 'lu-spp', ref: 'sppText', id: id('sppText') }))),

      group('focusGroup', '对焦', 'focusValue',
        h('div', { class: 'lu-row lu-slider-row' }, label('focusRange', '距离'),
          h('input', { type: 'range', ref: 'focusRange', id: id('focusRange'), min: 0, max: FOCUS_STEPS.length - 1, step: 1, 'aria-describedby': id('focusHint') }),
          h('span', { class: 'lu-field' },
            h('input', { type: 'number', ref: 'focusInput', id: id('focusInput'), class: 'lu-num', step: 0.01, min: 0, inputmode: 'decimal', 'aria-label': '对焦距离（米）', 'aria-describedby': id('focusHint') }),
            h('span', { class: 'lu-unit', 'aria-hidden': 'true', text: 'm' })),
          h('button', { type: 'button', class: 'lu-btn lu-inf', ref: 'focusInf', 'aria-label': '对焦到无穷远', title: '对焦到无穷远', text: '∞' })),
        // Image distance stays wired up but is hidden here; the lens workbench is where it is inspected.
        h('div', { class: 'lu-row', hidden: true }, label('imageInput', '像距'),
          h('div', { class: 'lu-stepper' },
            h('button', { type: 'button', class: 'lu-nudge', ref: 'imageMinus', 'aria-label': `像距减 ${IMAGE_NUDGE_MM} mm`, text: '−' }),
            h('input', { type: 'number', ref: 'imageInput', id: id('imageInput'), class: 'lu-num lu-num-wide', step: 0.001, inputmode: 'decimal', 'aria-describedby': `${id('imageHint')} ${id('focusHint')}` }),
            h('span', { class: 'lu-unit', 'aria-hidden': 'true', text: 'mm' }),
            h('button', { type: 'button', class: 'lu-nudge', ref: 'imagePlus', 'aria-label': `像距加 ${IMAGE_NUDGE_MM} mm`, text: '+' }))),
        h('p', { class: 'lu-hint', ref: 'imageHint', id: id('imageHint'), hidden: true }),
        hint('focusHint'),
        check('afRelease', '环视松手后自动对焦')),

      group('lensGroup', '镜头与光圈', 'lensValue',
        h('button', { type: 'button', class: 'lu-thumb', ref: 'benchOpen', 'aria-label': '打开镜组工作台：截面、处方编辑与导入（快捷键 L）', title: '镜组工作台（L）' },
          thumb, h('span', { class: 'lu-thumb-caption' }, h('span', { ref: 'thumbCaption', text: '镜组截面' }), h('span', { class: 'lu-thumb-action', text: '编辑 · 导入 ›' }))),
        h('div', { class: 'lu-filter' },
          label('brandSelect', '品牌', { class: 'visually-hidden' }),
          h('select', { ref: 'brandSelect', id: id('brandSelect'), class: 'lu-brand-select', title: '先选品牌，再选镜头' }),
          label('lensFilter', '搜索镜头', { class: 'visually-hidden' }),
          h('input', { type: 'search', ref: 'lensFilter', id: id('lensFilter'), class: 'lu-search', placeholder: '搜索', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': id('lensCount') })),
        h('div', { class: 'lu-row lu-lens-row' },
          label('lensSelect', '镜头', { class: 'visually-hidden' }),
          h('select', { ref: 'lensSelect', id: id('lensSelect'), class: 'lu-lens-select', 'aria-describedby': `${id('lensMeta')} ${id('lensCount')}` }),
          label('configSelect', '配置', { class: 'visually-hidden' }),
          h('select', { ref: 'configSelect', id: id('configSelect'), class: 'lu-config-select', title: '镜头配置', 'aria-describedby': id('lensMeta') })),
        h('p', { class: 'lu-hint lu-meta' }, h('span', { ref: 'lensMeta', id: id('lensMeta') }), h('span', { class: 'lu-count', ref: 'lensCount', id: id('lensCount') })),
        check('availableOnly', '仅列出可用镜头'),
        h('details', { class: 'lu-warn-details', ref: 'warnDetails', hidden: true },
          h('summary', { ref: 'warnSummary' }),
          h('ul', { class: 'lu-warnings', ref: 'warnings', 'aria-label': '镜头数据提示' })),
        h('div', { class: 'lu-row lu-slider-row' }, label('fRange', '光圈'),
          h('input', { type: 'range', ref: 'fRange', id: id('fRange'), min: 0, max: 0, step: 1, 'aria-describedby': id('fHint') }),
          h('span', { class: 'lu-field' },
            h('span', { class: 'lu-unit lu-unit-pre', 'aria-hidden': 'true', text: 'f/' }),
            h('input', { type: 'number', ref: 'fInput', id: id('fInput'), class: 'lu-num', step: 0.1, inputmode: 'decimal', 'aria-label': '光圈 f 值', 'aria-describedby': id('fHint') }))),
        hint('fHint'),
        check('dispersion', '色散（每条路径单一波长）')),

      group('samplingGroup', '采样', 'samplingValue',
        h('div', { class: 'lu-row lu-sampling-row' },
          label('sppSelect', '目标采样数', { class: 'visually-hidden' }),
          h('select', { ref: 'sppSelect', id: id('sppSelect'), title: '目标采样数（每像素尝试路径）' }),
          label('resSelect', '分辨率', { class: 'visually-hidden' }),
          h('select', { ref: 'resSelect', id: id('resSelect'), title: '累积图像尺寸（像素）：宽度取 3 的倍数，固定 3:2 带黑边' }),
          h('button', { type: 'button', class: 'lu-btn', ref: 'resetButton', title: '清空当前累积，按现有参数重新采样', 'aria-label': '重置采样', text: '重置' })),
        h('p', { class: 'lu-hint', ref: 'sppHint', id: id('sppHint') },
          '颗粒来自波长与光圈的蒙特卡罗积分，约按 ', h('span', { class: 'lu-nowrap', text: '1/√spp' }),
          ' 减弱；可选择持续采样并随时暂停。相机分辨率需较多显存（最高约 4.0 GiB），按分块逐步更新。不含传感器噪声，不做降噪。')),

      group('displayGroup', '显示', 'displayValue',
        h('div', { class: 'lu-row lu-slider-row' }, label('evRange', '曝光'),
          h('input', { type: 'range', ref: 'evRange', id: id('evRange'), min: -15, max: 15, step: 1 / 3, 'aria-describedby': id('evHint') }),
          h('output', { ref: 'evOut', for: id('evRange'), class: 'lu-out' }),
          h('button', { type: 'button', class: 'lu-btn lu-nudge-btn', ref: 'evZero', title: '曝光归零', 'aria-label': '显示曝光归零', text: '0' })),
        hint('evHint', '附加显示曝光，不改变光学参数，也不自动归一亮度。'),
        h('div', { class: 'lu-row lu-row-split' },
          check('bloom', 'Bloom'),
          h('div', { class: 'lu-cell' }, label('diagSelect', '视图'),
            h('select', { ref: 'diagSelect', id: id('diagSelect'), 'aria-describedby': id('diagHint') },
              ['beauty', 'scene-error', 'status'].map((value) => h('option', { value, text: DIAGNOSTIC_LABELS[value] })),
              h('optgroup', { label: '几何/法线/材质诊断（重新累计）' },
                GEOMETRY_DIAGNOSTICS.map((value) => h('option', { value, text: `${DIAGNOSTIC_LABELS[value]}（重新累计）` })))))),
        hint('diagHint'),
        radios('output', '输出', [['auto', OUTPUT_LABELS.auto, '显示链路支持时输出 HDR'], ['sdr', OUTPUT_LABELS.sdr, '强制 SDR 色调映射']]),
        hint('outputHint')),

      // Raster preview quality for slower devices; lens tracing is unaffected.
      group('rasterGroup', '光栅画质', 'rasterValue',
        radios('rasterRatio', '渲染分辨率', [['auto', '自动', '随屏幕像素密度，最高 1.5×'], ['1', '1.0×', '每个 CSS 像素一个采样'], ['0.75', '0.75×', '低分辨率，适合较慢的 GPU']]),
        radios('rasterMSAA', 'MSAA 抗锯齿', [['0', '关闭', '单采样，降低光栅渲染开销'], ['4', '4×', '四重多重采样抗锯齿']]),
        h('div', { class: 'lu-row lu-row-split' },
          check('rasterAO', '环境光遮蔽', { title: 'GTAO 屏幕空间环境光遮蔽（含法线/深度预通道）' }),
          check('rasterReflection', '水面反射', { title: '每帧从水面镜像视点再绘制一次场景' })),
        check('rasterAdaptive', '移动时自动降低分辨率', { title: '仅在相机移动且 GPU 来不及时降低像素比例，停止后立即恢复' }),
        hint('rasterHint', '只影响光栅预览与导航流畅度；镜头追迹的分辨率、阴影与反射不受影响。设置保存在本机浏览器。')),

      h('details', { class: 'lu-details' },
        h('summary', { text: '物理范围与局限' }),
        h('ul', { class: 'lu-limits' }, LIMITATIONS.map((text) => h('li', { text }))),
        h('p', { class: 'lu-rate-heading', ref: 'approxHead', hidden: true }),
        h('ul', { class: 'lu-limits', ref: 'approxList', hidden: true }))),
    h('div', { class: 'lu-foot' },
      h('button', { type: 'button', class: 'lu-tool', ref: 'benchToggle', 'aria-pressed': 'false', title: '镜组工作台（L）' }, h('span', { class: 'lu-i-lens', 'aria-hidden': 'true' }), '镜组', h('kbd', { text: 'L' })),
      h('button', { type: 'button', class: 'lu-tool', ref: 'hudToggle', 'aria-pressed': 'false', title: '性能诊断浮窗（P）' }, h('span', { class: 'lu-i-pulse', 'aria-hidden': 'true' }), '诊断', h('kbd', { text: 'P' }))),
    h('div', { class: 'visually-hidden', ref: 'announcer', 'aria-live': 'polite' }));

  // Floating diagnostics: a separate window snapped to a viewport corner.
  const spark = doc.createElementNS ? doc.createElementNS('http://www.w3.org/2000/svg', 'svg') : doc.createElement('svg');
  spark.setAttribute('class', 'lu-spark'); spark.setAttribute('viewBox', '0 0 120 28'); spark.setAttribute('preserveAspectRatio', 'none'); spark.setAttribute('aria-hidden', 'true');
  const hud = h('section', { class: 'lu-hud', ref: 'hud', 'aria-label': '性能诊断', hidden: true, 'data-corner': 'br' },
    h('header', { class: 'lu-hud-head', ref: 'hudHead', title: '拖动到任意角落' },
      h('span', { class: 'lu-hud-grip', 'aria-hidden': 'true' }),
      h('span', { class: 'lu-hud-title', text: '性能诊断' }),
      h('span', { class: 'lu-hud-live', ref: 'hudLive' }),
      h('button', { type: 'button', class: 'lu-icon-btn', ref: 'hudCorner', 'aria-label': '移到下一个角落', title: '换角落' }, h('span', { class: 'lu-i-corner', 'aria-hidden': 'true' })),
      h('button', { type: 'button', class: 'lu-icon-btn', ref: 'hudClose', 'aria-label': '关闭性能诊断', title: '关闭（P）' }, h('span', { class: 'lu-x', 'aria-hidden': 'true' }))),
    h('div', { class: 'lu-hud-body' },
      h('div', { class: 'lu-hud-metrics', ref: 'hudMetrics' }),
      spark,
      h('details', { class: 'lu-hud-section', open: true }, h('summary', { text: '算力估计' }),
        h('div', { class: 'lu-work', ref: 'hudWork' }),
        h('p', { class: 'lu-hint lu-work-note', text: '算法工作率估算，不代表硬件利用率：操作次数乘以手工 FLOP 权重（FMA 计 2），再用当前计数窗口的 GPU 计时估算；不包含整数、分支和纹理访问，未经误差标定。计数保持当前渲染路径，仍有统计开销。' })),
      h('details', { class: 'lu-hud-section', open: true }, h('summary', { text: '光线去向' }), h('div', { class: 'lu-rates', ref: 'rates' })),
      h('details', { class: 'lu-hud-section' }, h('summary', { text: '场景与资源' }),
        h('dl', { class: 'lu-dl', ref: 'diagList' }),
        h('ul', { class: 'lu-warnings', ref: 'lightingWarnings', 'aria-label': '光照资源提示', hidden: true }),
        h('button', { type: 'button', class: 'lu-btn', ref: 'rebuildButton', title: '重新扫描已登记的场景对象，最小更新 BVH/材质（调试用）', text: '重新扫描场景' }))));

  const bench = createLensBench({ h, refs, on, doc, win, id, store, getState: () => state, announce: (t) => announce(t),
    onClose: () => { refs.benchToggle.setAttribute('aria-pressed', 'false'); refs.benchOpen.focus?.(); } });

  // Denominators differ: scene-side rates are per ray that passed the optics, the rest per attempted ray.
  const RATE_GROUPS = [
    ['占尝试光线', [['opticalPassRate', '通过镜头'], ['opticalBlockedRate', '镜筒/光阑遮挡'], ['tirRate', '全内反射'], ['numericalErrorRate', '数值失败'],
      ['hitRate', '场景命中'], ['backgroundRate', '背景'], ['radianceInvalidRate', '辐亮度无效']]],
    ['占通过镜头的光线', [['sceneHitOfPassed', '场景命中'], ['backgroundOfPassed', '背景'], ['unsupportedRate', '未支持材质'],
      ['transparencyLimitRate', '透明层超限'], ['bvhErrorRate', 'BVH 遍历错误'], ['reflectionOutsideRate', '水面反射出参考视野']]],
  ];
  const RATE_ROWS = RATE_GROUPS.flatMap(([, rows]) => rows);
  for (const [heading, rows] of RATE_GROUPS) {
    refs.rates.appendChild(h('p', { class: 'lu-rate-heading', text: heading }));
    for (const [key, text] of rows) {
      refs.rates.appendChild(h('div', { class: 'lu-rate', 'data-rate': key, ref: `rateRow-${key}`, title: `${text}，${heading}` },
        h('span', { class: 'lu-rate-label', text }),
        h('span', { class: 'lu-rate-bar', 'aria-hidden': 'true' }, h('span', { class: 'lu-rate-fill', ref: `rate-${key}` })),
        h('span', { class: 'lu-rate-value', ref: `rateText-${key}` })));
    }
  }

  // ---------------------------------------------------------------- commands
  function announce(text) {
    refs.announcer.textContent = '';
    refs.announcer.textContent = text;
  }

  function run(type, value) {
    if (disposed) return Promise.resolve(false);
    if (pending.has(type)) {
      if (COALESCED.has(type)) queued.set(type, value);
      return Promise.resolve(false);
    }
    if (!isCommandEnabled(type, state, pending)) {
      announce(`${COMMAND_LABELS[type] || type}：当前不可操作`);
      render();
      return Promise.resolve(false);
    }
    pending.add(type);
    commandErrors.delete(type);
    render();
    return Promise.resolve()
      .then(() => store.dispatch(type, value))
      .then(() => { commandErrors.delete(type); return true; }, (error) => {
        commandErrors.set(type, errorMessage(error));
        return false;
      })
      .finally(() => {
        pending.delete(type);
        if (disposed) return;
        if (queued.has(type)) {
          const next = queued.get(type);
          queued.delete(type);
          run(type, next);
        }
        render();
      });
  }

  // ---------------------------------------------------------------- inputs
  /** Do not overwrite what the person is typing or dragging. */
  function editing(el) { return el.getAttribute('data-dirty') === '1'; }
  function setValue(el, value) {
    if (editing(el)) return;
    if (el.value !== value) el.value = value;
  }
  function markDirty(el) { on(el, 'input', () => { el.setAttribute('data-dirty', '1'); fieldErrors.delete(el.getAttribute('data-ref')); }); }
  function clearDirty(el) { el.removeAttribute('data-dirty'); }

  function commitNumber(el, validate, command, transform = (n) => n) {
    markDirty(el);
    on(el, 'change', () => {
      const raw = el.value.trim();
      const value = raw === '' ? NaN : Number(raw);
      const problem = validate(value);
      if (problem) {
        fieldErrors.set(el.getAttribute('data-ref'), problem);
        render();
        return;
      }
      fieldErrors.delete(el.getAttribute('data-ref'));
      clearDirty(el);
      run(command, transform(value));
    });
    on(el, 'blur', () => { clearDirty(el); render(); });
  }

  on(refs.toggle, 'click', () => setOpen(refs.root.getAttribute('data-open') !== 'true', true));
  on(refs.root, 'keydown', (event) => {
    if (event.key !== 'Escape' || refs.root.getAttribute('data-open') !== 'true') return;
    if (event.target === refs.lensFilter && refs.lensFilter.value) return; // search clears itself first
    setOpen(false, true);
    refs.toggle.focus();
  });

  for (const radio of radioInputs('mode')) on(radio, 'change', () => radio.checked && run('setMode', radio.value));
  for (const radio of radioInputs('output')) on(radio, 'change', () => radio.checked && run('setOutput', radio.value));

  on(refs.lensFilter, 'input', () => render());
  on(refs.brandSelect, 'change', () => {
    brandFilter = refs.brandSelect.value || ALL_BRANDS;
    render();
    const count = refs.lensSelect.querySelectorAll('option').filter((o) => o.value).length;
    announce(`${brandFilter === ALL_BRANDS ? '全部品牌' : brandFilter}：${count} 支镜头`);
  });
  on(refs.availableOnly, 'change', () => render());
  on(refs.lensSelect, 'change', () => {
    const next = refs.lensSelect.value;
    if (next && next !== state.lensId) run('selectLens', next);
  });
  on(refs.configSelect, 'change', () => {
    const next = Number(refs.configSelect.value);
    if (Number.isInteger(next) && next !== state.configurationIndex) run('selectConfiguration', next);
  });

  markDirty(refs.fRange);
  on(refs.fRange, 'input', () => {
    const value = fSteps()[Number(refs.fRange.value)];
    refs.fRange.setAttribute('aria-valuetext', formatFNumber(value));
    if (!editing(refs.fInput)) refs.fInput.value = String(value);
  });
  on(refs.fRange, 'change', () => {
    clearDirty(refs.fRange);
    const value = fSteps()[Number(refs.fRange.value)];
    if (Number.isFinite(value)) run('setFNumber', value);
  });
  commitNumber(refs.fInput, (value) => validateFNumber(value, state.limits?.fNumber), 'setFNumber');
  on(refs.dispersion, 'change', () => run('setDispersion', refs.dispersion.checked));

  on(refs.afButton, 'click', () => run('autofocus'));
  on(refs.afRelease, 'change', () => run('setAutoFocusOnRelease', refs.afRelease.checked));
  markDirty(refs.focusRange);
  on(refs.focusRange, 'input', () => {
    const value = FOCUS_STEPS[Number(refs.focusRange.value)];
    refs.focusRange.setAttribute('aria-valuetext', formatFocus(value));
    if (!editing(refs.focusInput)) refs.focusInput.value = value === null ? '' : String(value);
  });
  on(refs.focusRange, 'change', () => {
    clearDirty(refs.focusRange);
    const value = FOCUS_STEPS[Number(refs.focusRange.value)];
    if (value !== undefined) run('setFocusDistance', value);
  });
  commitNumber(refs.focusInput, validateFocus, 'setFocusDistance');
  on(refs.focusInf, 'click', () => run('setFocusDistance', null));
  commitNumber(refs.imageInput, (value) => validateImageDistance(value, state.limits?.imageDistanceMm), 'setImageDistance',
    (value) => Number(value.toFixed(4)));
  const nudge = (sign) => {
    const [min, max] = state.limits?.imageDistanceMm || [-Infinity, Infinity];
    const base = state.optics?.imageDistanceMm;
    if (!Number.isFinite(base)) return;
    const next = Number(Math.min(max, Math.max(min, base + sign * IMAGE_NUDGE_MM)).toFixed(4));
    if (next !== base) run('setImageDistance', next);
  };
  on(refs.imageMinus, 'click', () => nudge(-1));
  on(refs.imagePlus, 'click', () => nudge(1));

  on(refs.sppSelect, 'change', () => run('setTargetSpp', Number(refs.sppSelect.value)));
  on(refs.resSelect, 'change', () => run('setResolution', Number(refs.resSelect.value)));
  on(refs.pauseButton, 'click', () => run('setPaused', !state.sampling?.paused));
  on(refs.resetButton, 'click', () => run('reset'));
  on(refs.rebuildButton, 'click', () => run('rebuildScene'));

  markDirty(refs.evRange);
  on(refs.evRange, 'input', () => {
    const value = Number(refs.evRange.value);
    refs.evOut.textContent = formatEV(value);
    refs.evRange.setAttribute('aria-valuetext', formatEV(value));
  });
  on(refs.evRange, 'change', () => {
    clearDirty(refs.evRange);
    run('setExposureEV', Math.round(Number(refs.evRange.value) * 1000) / 1000);
  });
  on(refs.evZero, 'click', () => run('setExposureEV', 0));
  on(refs.bloom, 'change', () => run('setBloom', refs.bloom.checked));
  for (const radio of radioInputs('rasterRatio')) on(radio, 'change', () => radio.checked && run('setRasterQuality', { pixelRatio: radio.value }));
  for (const radio of radioInputs('rasterMSAA')) on(radio, 'change', () => radio.checked && run('setRasterQuality', { msaa: Number(radio.value) }));
  on(refs.rasterAO, 'change', () => run('setRasterQuality', { ambientOcclusion: refs.rasterAO.checked }));
  on(refs.rasterReflection, 'change', () => run('setRasterQuality', { reflection: refs.rasterReflection.checked }));
  on(refs.rasterAdaptive, 'change', () => run('setRasterQuality', { adaptiveResolution: refs.rasterAdaptive.checked }));
  on(refs.diagSelect, 'change', () => run('setDiagnostic', refs.diagSelect.value));

  on(refs.errors, 'click', (event) => {
    const type = event.target?.getAttribute?.('data-dismiss');
    if (!type) return;
    commandErrors.delete(type);
    render();
  });

  on(doc, 'keydown', (event) => {
    if (!isAutofocusShortcut(event)) return;
    event.preventDefault();
    if (isCommandEnabled('autofocus', state, pending)) run('autofocus');
    else announce(`AF-S 当前不可用：${afUnavailableReason()}`);
  });

  // ---------------------------------------------------------------- picture export
  let exporting = false;
  async function exportPicture() {
    if (exporting || disposed) return;
    exporting = true; commandErrors.delete('exportImage'); render();
    announce('正在导出图片…');
    try {
      const result = await store.dispatch('exportImage');
      if (!result?.blob) throw new Error('没有可导出的图像');
      downloadBlob(result.blob, result.fileName, doc);
      announce(`已保存 ${result.width}×${result.height} PNG${result.kind === 'raster' ? '（光栅预览）' : ''}`);
    } catch (error) { commandErrors.set('exportImage', errorMessage(error)); }
    finally { exporting = false; if (!disposed) render(); }
  }
  on(refs.exportButton, 'click', exportPicture);

  // ---------------------------------------------------------------- workbench + HUD
  const openBench = () => { bench.openBench(); refs.benchToggle.setAttribute('aria-pressed', 'true'); };
  const toggleBench = () => { if (bench.isOpen) bench.close(); else openBench(); };
  on(refs.benchOpen, 'click', openBench);
  on(refs.benchToggle, 'click', toggleBench);

  const CORNERS = ['br', 'bl', 'tl', 'tr'];
  const hudKey = 'lens-ui:hud';
  function readHud() { try { return JSON.parse(win?.localStorage?.getItem(hudKey) ?? 'null'); } catch { return null; } }
  function saveHud() { try { win?.localStorage?.setItem(hudKey, JSON.stringify({ open: !refs.hud.hidden, corner: refs.hud.getAttribute('data-corner') })); } catch { /* storage unavailable */ } }
  function setHud(open, remember = true) {
    refs.hud.hidden = !open;
    refs.hudToggle.setAttribute('aria-pressed', String(open));
    if (open) sppHistory.length = 0;
    render(); // also starts/stops GPU work counting
    if (remember) saveHud();
  }
  const hudSaved = readHud();
  if (CORNERS.includes(hudSaved?.corner)) refs.hud.setAttribute('data-corner', hudSaved.corner);
  on(refs.hudToggle, 'click', () => setHud(refs.hud.hidden));
  on(refs.hudClose, 'click', () => { setHud(false); refs.hudToggle.focus?.(); });
  on(refs.hudCorner, 'click', () => {
    const next = CORNERS[(CORNERS.indexOf(refs.hud.getAttribute('data-corner')) + 1) % CORNERS.length];
    refs.hud.setAttribute('data-corner', next); saveHud();
  });
  // Drag the header anywhere; on release the window snaps to the nearest corner.
  let hudDrag = null;
  on(refs.hudHead, 'pointerdown', (event) => {
    if (event.button !== 0 || event.target?.closest?.('button')) return;
    const rect = refs.hud.getBoundingClientRect?.();
    if (!rect) return;
    hudDrag = { id: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top, w: rect.width, h: rect.height };
    refs.hudHead.setPointerCapture?.(event.pointerId);
    refs.hud.classList.add('lu-hud-dragging');
    event.preventDefault();
  });
  on(refs.hudHead, 'pointermove', (event) => {
    if (!hudDrag || event.pointerId !== hudDrag.id) return;
    refs.hud.style.setProperty('left', `${Math.max(0, event.clientX - hudDrag.dx)}px`);
    refs.hud.style.setProperty('top', `${Math.max(0, event.clientY - hudDrag.dy)}px`);
  });
  const endHudDrag = (event) => {
    if (!hudDrag || event.pointerId !== hudDrag.id) return;
    const cx = event.clientX - hudDrag.dx + hudDrag.w / 2, cy = event.clientY - hudDrag.dy + hudDrag.h / 2;
    const corner = `${cy < (win?.innerHeight ?? 800) / 2 ? 't' : 'b'}${cx < (win?.innerWidth ?? 1200) / 2 ? 'l' : 'r'}`;
    hudDrag = null;
    refs.hud.classList.remove('lu-hud-dragging');
    refs.hud.style.removeProperty?.('left'); refs.hud.style.removeProperty?.('top');
    refs.hud.setAttribute('data-corner', corner); saveHud();
  };
  on(refs.hudHead, 'pointerup', endHudDrag);
  on(refs.hudHead, 'pointercancel', endHudDrag);

  on(doc, 'keydown', (event) => {
    if (isKeyShortcut(event, 'p')) { event.preventDefault(); setHud(refs.hud.hidden); announce(refs.hud.hidden ? '性能诊断已关闭' : '性能诊断已打开'); }
    else if (isKeyShortcut(event, 'l')) { event.preventDefault(); toggleBench(); }
  });

  function radioInputs(ref) { return [...refs[ref].querySelectorAll('input[type="radio"]')]; }
  function fSteps() { return stepsForFNumber(state.limits?.fNumber); }
  function afUnavailableReason() {
    const gates = computeGates(state, pending);
    if (state.status === 'error') return '镜头后端错误';
    if (!gates.ready) return STATUS_LABELS[state.status] || '后端未就绪';
    if (gates.afBusy) return '正在对焦';
    if (gates.lensLoading) return '正在载入镜头';
    return '';
  }

  // Per-viewer convenience only: remembered separately for narrow and wide layouts, and
  // re-applied whenever the viewport crosses the breakpoint (default: open wide, closed narrow).
  const narrowQuery = win?.matchMedia?.('(max-width: 700px)') || null;
  let narrow = Boolean(narrowQuery?.matches);
  const openKey = () => `lens-ui:open:${narrow ? 'narrow' : 'wide'}`;
  function storedOpen() {
    try { const value = win?.localStorage?.getItem(openKey()); return value === 'true' ? true : value === 'false' ? false : null; } catch { return null; }
  }
  const preferredOpen = () => storedOpen() ?? !narrow;
  function contains(ancestor, node) {
    for (let n = node; n; n = n.parentNode) if (n === ancestor) return true;
    return false;
  }
  function setOpen(open, remember = false) {
    if (remember) { try { win?.localStorage?.setItem(openKey(), String(open)); } catch { /* storage unavailable */ } }
    if (!open && contains(refs.body, doc.activeElement)) refs.toggle.focus(); // never strand focus in a hidden body
    refs.root.setAttribute('data-open', String(open));
    refs.toggle.setAttribute('aria-expanded', String(open));
    refs.toggle.setAttribute('aria-label', open ? '收起镜头面板' : '展开镜头面板');
    refs.body.hidden = !open;
  }

  // ---------------------------------------------------------------- render
  function setDisabled(el, disabled) { el.disabled = Boolean(disabled); }

  function setOptions(select, options, selected) {
    select.replaceChildren(...options);
    select.value = String(selected);
  }
  function setSelect(select, value) { if (select.value !== String(value)) select.value = String(value); }

  function renderLensOptions() {
    const lenses = Array.isArray(state.lenses) ? state.lenses : [];
    const query = refs.lensFilter.value;
    const availableOnly = refs.availableOnly.checked;
    const current = lenses.find((l) => l.id === state.lensId);
    // The brand follows the active lens (initially, and when the backend switches lens), unless "all" was chosen.
    if (current && state.lensId !== brandForLensId) {
      brandForLensId = state.lensId;
      if (brandFilter !== ALL_BRANDS) brandFilter = brandOf(current);
    }
    const groups = brandGroups(lenses, availableOnly);
    if (brandFilter && brandFilter !== ALL_BRANDS && !groups.some((g) => g.brand === brandFilter)) brandFilter = null;
    const brand = brandFilter ?? ALL_BRANDS;
    const key = JSON.stringify([lenses.map((l) => [l.id, l.name, l.available, l.reason, l.brand, l.focalLengthMm]), query, availableOnly, state.lensId, brand]);
    if (key === lensOptionsKey) return;
    lensOptionsKey = key;
    const countOf = (g) => (availableOnly ? g.available : g.total);
    const totalShown = availableOnly ? lenses.filter((l) => l.available !== false).length : lenses.length;
    setOptions(refs.brandSelect, [h('option', { value: ALL_BRANDS, text: `全部品牌 · ${totalShown}` }),
      ...groups.map((g) => h('option', { value: g.brand, disabled: countOf(g) === 0, text: `${g.brand} · ${countOf(g)}` }))], brand);
    const shown = filterLenses(lenses, { query, availableOnly, brand });
    const option = (lens) => h('option', { value: lens.id, disabled: lens.available === false, title: lens.reason || false, text: lensOptionLabel(lens) });
    const usable = shown.filter((l) => l.available !== false);
    const unusable = shown.filter((l) => l.available === false);
    let children;
    if (!lenses.length) children = [h('option', { value: '', disabled: true, text: state.status === 'loading' ? '正在读取镜头目录…' : '（无镜头数据）' })];
    else if (!unusable.length) children = usable.map(option);
    else children = [h('optgroup', { label: `可用（${usable.length}）` }, usable.map(option)),
      h('optgroup', { label: `不可用（${unusable.length}）` }, unusable.map(option))];
    // Second layer: when the active lens is not in this brand/search, ask for a choice instead of
    // silently showing another lens as selected. Nothing is dispatched until a lens is picked.
    const activeShown = shown.some((l) => l.id === state.lensId);
    if (lenses.length && !activeShown) {
      const prompt = shown.length ? `选择镜头…（${shown.length}）` : '无匹配镜头'; // brand is already shown just above
      children.unshift(h('option', { value: '', disabled: true, text: prompt }));
    }
    setOptions(refs.lensSelect, children, activeShown ? state.lensId : '');
    const total = lenses.length, available = lenses.filter((l) => l.available !== false).length;
    refs.lensCount.textContent = total ? `可用 ${available}/${total}${shown.length < total ? ` · 列出 ${shown.length}` : ''}` : '';
  }

  function renderConfigOptions() {
    const configs = Array.isArray(state.configurations) ? state.configurations : [];
    const key = JSON.stringify([configs, state.configurationIndex]);
    if (key === configOptionsKey) return;
    configOptionsKey = key;
    const children = configs.length ? configs.map((c) => h('option', {
      value: c.index, disabled: c.available === false, title: c.reason || false,
      text: `${c.title || `配置 ${c.index + 1}`}${c.available === false ? `（不可用${c.reason ? `：${c.reason}` : ''}）` : ''}`,
    })) : [h('option', { value: '', disabled: true, text: '—' })];
    setOptions(refs.configSelect, children, configs.length ? state.configurationIndex : '');
  }

  function renderErrors() {
    const items = [...commandErrors];
    const key = JSON.stringify(items);
    if (key === errorsKey) return;
    errorsKey = key;
    refs.errors.replaceChildren(...items.map(([type, message]) => h('li', { class: 'lu-error' },
      h('span', { text: `${COMMAND_LABELS[type] || type}失败：${message}` }),
      h('button', { type: 'button', class: 'lu-dismiss', 'data-dismiss': type, 'aria-label': `关闭「${COMMAND_LABELS[type] || type}」错误`, text: '×' }))));
    refs.errors.hidden = items.length === 0;
  }

  function renderWarnings() {
    const warnings = Array.isArray(state.warnings) ? state.warnings : [];
    const key = JSON.stringify(warnings);
    if (key === warningsKey) return;
    warningsKey = key;
    refs.warnings.replaceChildren(...warnings.map((text) => h('li', { text })));
    refs.warnDetails.hidden = warnings.length === 0;
    refs.warnSummary.replaceChildren(
      h('span', { class: 'lu-warn-count', text: `数据提示 ${warnings.length} 条` }),
      h('span', { class: 'lu-warn-first', text: warnings[0] || '' }));
  }

  function fieldHint(el, ref, text) {
    const problem = fieldErrors.get(ref);
    el.textContent = problem || text;
    el.classList.toggle('lu-invalid', Boolean(problem));
    const input = refs[ref];
    if (problem) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  function renderDiagnostics(d, sampling) {
    for (const [key] of RATE_ROWS) {
      const rate = d[key];
      const provided = typeof rate === 'number' && Number.isFinite(rate);
      refs[`rateRow-${key}`].hidden = !provided; // shown once the backend provides the field
      const known = provided && d.attemptedSamples > 0;
      refs[`rate-${key}`].style.setProperty('width', known ? `${Math.min(100, Math.max(0, rate * 100))}%` : '0%');
      refs[`rateText-${key}`].textContent = known ? formatRate(rate) : '—';
    }
    const summary = state.scene?.summary;
    const lighting = state.scene?.lighting;
    const lights = lighting?.lights;
    const revisionKeys = ['geometry', 'material', 'lighting', 'camera', 'optics', 'display', 'accumulation'];
    const rows = [
      ['实际 / 目标', `${formatCount(sampling.spp)} / ${sampling.targetSpp===0?'∞':formatCount(sampling.targetSpp)} spp`],
      ['每批', `${formatCount(sampling.batchSpp)} spp`],
      ['尝试路径', formatCount(d.attemptedSamples)],
      ['追迹路径', d.integrationMode==='staged'?'四象限 · 镜头/求交/着色三阶段':'—'],
      ['计算耗时（GPU，单分块）', formatMs(d.computeMs)],
      ['光照刷新（CPU 提交）', `${formatMs(d.lightingRefreshMs)} · ${formatCount(d.lightingRefreshes)} 次`],
      ['计时来源', d.timingSource || '—'],
      ['累积缓冲', d.width && d.height ? `${d.width} × ${d.height}` : '—'],
      ['显存', formatBytes(d.memoryBytes)],
      ['场景实例', summary ? formatCount(summary.instances) : '—'],
      ['基础三角形', summary ? formatCount(summary.uniqueTriangles) : '—'],
      ['BVH 节点 / 深度', summary ? `${formatCount(summary.bvhNodes)} / TLAS ${formatCount(summary.tlasDepth)} · BLAS ≤${formatCount(summary.maxBlasDepth)}` : '—'],
      ['BVH 显存', summary ? formatBytes(summary.gpuBytes) : '—'],
      ['BVH 构建', summary ? `${formatMs(summary.buildWallMs)}${summary.worker ? ' · Worker' : ' · 主线程'}` : '—'],
      ['光源 方向/点/半球', lights ? `${formatCount(lights.directional)} / ${formatCount(lights.point)} / ${formatCount(lights.hemisphere)}` : '—'],
      ['管线编译', formatCount(d.pipelineCompilations)],
      ['随机种子', formatCount(sampling.seed)],
      ['修订 几何/材质/光照/相机/光学/显示/累积', state.revisions ? revisionKeys.map((k) => state.revisions[k] ?? '—').join(' / ') : '—'],
    ];
    const key = JSON.stringify(rows);
    if (refs.diagList.getAttribute('data-key') === key) return;
    refs.diagList.setAttribute('data-key', key);
    refs.diagList.replaceChildren(...rows.flatMap(([term, value]) => [h('dt', { text: term }), h('dd', { text: value })]));
  }

  function renderList(el, items, item) {
    const key = JSON.stringify(items);
    if (el.getAttribute('data-key') === key) return;
    el.setAttribute('data-key', key);
    el.replaceChildren(...items.map(item));
    el.hidden = items.length === 0;
  }

  function renderScene() {
    const model = state.renderModel;
    const scene = describeScene(state.scene);
    refs.sceneStatus.textContent = model?.label ? `B：${model.label} · ${scene.text}` : scene.text;
    if (state.scene?.message) refs.sceneStatus.setAttribute('title', state.scene.message);
    else refs.sceneStatus.removeAttribute('title');
    refs.sceneStatus.setAttribute('data-scene', scene.status);
    refs.sceneStatus.classList.toggle('lu-invalid', scene.status === 'error');
    renderList(refs.sceneWarn, sceneWarnings(state), ({ level, text }) => h('li', { class: level === 'error' ? 'lu-error' : 'lu-warn', 'data-level': level, text }));
    renderList(refs.lightingWarnings, state.scene?.lighting?.warnings || [], (text) => h('li', { text: `光照：${text}` }));
    const approximations = Array.isArray(model?.approximations) ? model.approximations : [];
    refs.approxHead.textContent = model?.label ? `${model.label} 的近似` : '';
    refs.approxHead.hidden = approximations.length === 0;
    renderList(refs.approxList, approximations, (text) => h('li', { text }));
    setDisabled(refs.rebuildButton, !isCommandEnabled('rebuildScene', state, pending) || state.scene?.status === 'building');
  }

  function renderSummaries(optics, sampling, display, focus) {
    refs.focusValue.textContent = focus.known ? focus.text : '未标定';
    refs.lensValue.textContent = [Number.isFinite(optics.focalLengthMm) ? `${Math.abs(optics.focalLengthMm).toFixed(1)} mm` : '', Number.isFinite(optics.fNumber) ? formatFNumber(optics.fNumber) : ''].filter(Boolean).join(' · ');
    refs.samplingValue.textContent = samplingText(sampling);
    refs.displayValue.textContent = formatEV(Number.isFinite(display.exposureEV) ? display.exposureEV : 0);
  }
  let thumbKey = '';
  function renderThumbnail() {
    const p = state.prescription;
    const key = p ? JSON.stringify([p.id, p.configurationTitle, p.sensorZMm, p.stopRadiusMm]) : '';
    if (key === thumbKey) return;
    thumbKey = key;
    if (!p) { thumb.replaceChildren(); refs.thumbCaption.textContent = '镜组截面'; return; }
    const result = layoutFor(p, state.optics?.focalLengthMm);
    if (result.layout) drawLayoutSVG(doc, thumb, result.layout, { compact: true });
    else thumb.replaceChildren();
    refs.thumbCaption.textContent = result.layout ? `${result.layout.elements.length} 片 · ${p.surfaces.length} 面` : '镜组截面';
  }
  // Rolling samples for rates shown in the HUD. With `liveStats` (cheap engine reads, no store
  // update) the HUD refreshes on its own frame loop; otherwise only on published snapshots.
  const sppHistory = [], computeHistory = [];
  const HUD_INTERVAL_MS = 66, RATE_WINDOW_MS = 2000;
  const now = () => (win?.performance ?? globalThis.performance)?.now?.() ?? Date.now();
  // Counting costs a little GPU time, so it runs only while the HUD is open and the backend is ready.
  let workCountingSent = false;
  function syncWorkCounting() {
    const want = !refs.hud.hidden && state.status === 'ready';
    if (want === workCountingSent) return;
    workCountingSent = want;
    Promise.resolve().then(() => store.dispatch('setWorkCounting', want)).catch(() => { workCountingSent = !want; });
  }
  const formatPixels = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(Math.round(v)));
  const groupCount = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
  function renderWork(work) {
    const key = JSON.stringify(work ?? null);
    if (refs.hudWork.getAttribute('data-key') === key) return;
    refs.hudWork.setAttribute('data-key', key);
    if (state.mode !== 'lens') { refs.hudWork.replaceChildren(h('p', { class: 'lu-hint', text: '切换到镜头追迹后开始统计。' })); return; }
    if (work?.status === 'unsupported') { refs.hudWork.replaceChildren(h('p', { class: 'lu-hint', text: '此 GPU 的存储缓冲数量不足以加入计数缓冲；不提供估计。' })); return; }
    if (work?.status === 'compiling') { refs.hudWork.replaceChildren(h('p', { class: 'lu-hint', text: '正在编译计数版积分器（仅首次）…' })); return; }
    if (!work || work.status !== 'ok') { refs.hudWork.replaceChildren(h('p', { class: 'lu-hint', text: '正在统计（约 1 秒）…' })); return; }
    const g = work.gflops;
    const value = g === null ? '—' : g >= 1000 ? `${(g / 1000).toFixed(2)}` : g >= 100 ? g.toFixed(0) : g.toFixed(1);
    const unit = g === null ? '' : g >= 1000 ? 'TFLOP/s' : 'GFLOP/s';
    const workPath=work.integrationMode==='staged'?'三阶段计数 · ':'';
    const timing = workPath + (work.timing === 'gpu' ? `GPU 时间戳 · ${work.timedChunks} 块${Number.isFinite(work.timingCoverage)?` · ${(work.timingCoverage*100).toFixed(0)}% 覆盖，估算`:``}` : work.timing === 'queue' ? `队列完成间隔估算 · ${work.timedChunks} 块` : work.timing === 'wall' ? '无时间戳：墙钟近似，偏低' : '尚无计时');
    const groups = Object.entries(WORK_GROUPS);
    refs.hudWork.replaceChildren(
      h('div', { class: 'lu-work-head' },
        h('span', { class: 'lu-work-value' }, h('span', { class: 'lu-work-approx', text: '≈ ' }), value, unit ? h('small', { text: unit }) : null),
        h('span', { class: 'lu-work-timing', text: timing })),
      h('div', { class: 'lu-work-bar', role: 'img', 'aria-label': groups.map(([k, label]) => `${label} ${(work.share[k] * 100).toFixed(0)}%`).join('，') },
        ...groups.map(([k]) => h('span', { class: `lu-work-seg lu-work-${k}`, style: `flex-grow:${Math.max(0, work.share[k])}` }))),
      h('div', { class: 'lu-work-legend' }, ...groups.map(([k, label]) => h('span', { class: `lu-work-key lu-work-${k}` }, h('i', { 'aria-hidden': 'true' }), `${label} ${(work.share[k] * 100).toFixed(0)}%`))),
      h('dl', { class: 'lu-dl lu-work-dl' },
        ...[['每条路径', `${groupCount(work.flopsPerPath)} FLOP`], ['镜面求交 / 路径', groupCount(work.perPath.lensSurfaces)], ['矢高·法线 / 路径', groupCount(work.perPath.sagEvaluations)],
          ['BVH 包围盒 / 路径', groupCount(work.perPath.boxes)], ['三角形 / 路径', groupCount(work.perPath.triangles)], ['光源 / 着色点', groupCount(work.perPath.lights)]]
          .flatMap(([t, v]) => [h('dt', { text: t }), h('dd', { text: v })])));
  }
  function hudSource(d, sampling) {
    const live = typeof liveStats === 'function' ? liveStats() : null;
    if (live) return live;
    return { mode: state.mode, paused: sampling.paused, finished: sampling.targetSpp > 0 && sampling.spp >= sampling.targetSpp, spp: Number(sampling.spp) || 0, computeMs: d.computeMs,
      lightingRefreshMs: d.lightingRefreshMs, width: d.width, height: d.height, memoryBytes: d.memoryBytes };
  }
  const METRICS = [['spp', '采样速度'], ['rays', '光线吞吐'], ['compute', 'GPU 单块'], ['lighting', '光照刷新'], ['image', '累积图像'], ['memory', '显存']];
  const metricNodes = {};
  refs.hudMetrics.replaceChildren(...METRICS.map(([key, labelText]) => {
    const value = doc.createTextNode(''), unit = h('small', { text: '' }), detail = h('span', { class: 'lu-metric-detail', hidden: true });
    metricNodes[key] = { value, unit, detail };
    return h('div', { class: 'lu-metric', 'data-metric': key }, h('span', { class: 'lu-metric-label', text: labelText }), h('span', { class: 'lu-metric-value' }, value, unit), detail);
  }));
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  function setMetric(key, value, unit = '', detail = '') {
    const node = metricNodes[key];
    setText(node.value, value);
    setText(node.unit, unit);
    node.unit.hidden = !unit;
    setText(node.detail, detail);
    node.detail.hidden = !detail;
  }
  // Render state: input shrinks chunks for responsiveness; idle uses large chunks for throughput.
  function renderState(live, lens) {
    if (!lens) return { key: 'raster', text: '光栅模式' };
    if (live.paused) return { key: 'paused', text: '已暂停' };
    if (live.finished) return { key: 'finished', text: '已完成' };
    if (live.interactive === true) return { key: 'responsive', text: '响应模式' };
    if (live.interactive === false) return { key: 'fast', text: '快速模式' };
    return { key: 'sampling', text: '采样中' };
  }
  let sparkKey = '';
  function renderHudMetrics(live) {
    const t = now(), spp = Number(live.spp) || 0;
    // Accumulation restarted: start the rolling window again.
    if (sppHistory.length && spp < sppHistory.at(-1).spp) sppHistory.length = 0;
    if (!sppHistory.length || t - sppHistory.at(-1).t >= HUD_INTERVAL_MS * 0.75) sppHistory.push({ t, spp });
    while (sppHistory.length > 2 && t - sppHistory[0].t > RATE_WINDOW_MS) sppHistory.shift();
    const first = sppHistory[0], span = (sppHistory.at(-1).t - first.t) / 1000;
    const sppRate = span > 0.4 ? (sppHistory.at(-1).spp - first.spp) / span : null;
    // Every pixel attempts one path per sample, matching the GPU attempted-path counters.
    const pixels = (Number(live.width) || 0) * (Number(live.height) || 0);
    const rayRate = sppRate !== null && pixels > 0 ? sppRate * pixels : null;
    if (Number.isFinite(live.computeMs) && computeHistory.at(-1) !== live.computeMs) { computeHistory.push(live.computeMs); if (computeHistory.length > 60) computeHistory.shift(); }
    const lens = live.mode === 'lens';
    // Two decimals below 1 spp/s so slow renders (e.g. 0.2 spp/s) do not read as zero.
    const rate = (v) => (v === null || !lens ? '—' : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(v < 1 ? 2 : v < 10 ? 1 : 0));
    setMetric('spp', rate(sppRate), lens && sppRate !== null ? 'spp/s' : '');
    setMetric('rays', rate(rayRate), lens && rayRate !== null ? '条/s' : '');
    const chunkPixels = Number(live.chunkPixels), chunkSpp = Number(live.chunkSpp);
    const chunkDetail = lens && chunkPixels > 0 ? `${formatPixels(chunkPixels)} 像素${chunkSpp > 0 ? ` × ${chunkSpp} spp` : ''}` : '';
    setMetric('compute', Number.isFinite(live.computeMs) ? live.computeMs.toFixed(1) : '—', Number.isFinite(live.computeMs) ? 'ms' : '', chunkDetail);
    setMetric('lighting', Number.isFinite(live.lightingRefreshMs) ? live.lightingRefreshMs.toFixed(1) : '—', Number.isFinite(live.lightingRefreshMs) ? 'ms' : '');
    setMetric('image', live.width && live.height ? `${live.width}×${live.height}` : '—');
    setMetric('memory', formatBytes(live.memoryBytes));
    const renderMode = renderState(live, lens);
    setText(refs.hudLive, renderMode.text);
    refs.hudLive.setAttribute('data-state', renderMode.key);
    refs.hud.setAttribute('data-mode', lens ? 'lens' : 'raster');
    const key = computeHistory.join(',');
    if (key === sparkKey) return;
    sparkKey = key;
    const max = Math.max(1e-6, ...computeHistory);
    const points = computeHistory.map((v, i) => `${(i / Math.max(1, computeHistory.length - 1)) * 120},${(28 - (v / max) * 24 - 2).toFixed(2)}`).join(' ');
    const svgEl = (tag, attrs) => { const el = doc.createElementNS ? doc.createElementNS('http://www.w3.org/2000/svg', tag) : doc.createElement(tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v)); return el; };
    spark.replaceChildren(...(computeHistory.length > 1 ? [svgEl('polyline', { points, fill: 'none', 'vector-effect': 'non-scaling-stroke' })] : []));
    spark.setAttribute('data-empty', String(computeHistory.length < 2));
    spark.setAttribute('aria-label', `GPU 单块耗时，最近 ${computeHistory.length} 次`);
  }
  // Live loop: runs only while the HUD is open, reads `liveStats` and touches only changed text.
  // A timer, not requestAnimationFrame: rAF is starved while path tracing saturates the GPU.
  let hudTimer = 0;
  const timers = win?.setTimeout ? win : globalThis;
  function hudTick() {
    hudTimer = 0;
    if (disposed || refs.hud.hidden) return;
    try { renderHudMetrics(hudSource(state.diagnostics || {}, state.sampling || {})); } catch (error) { (win?.console ?? console).error('lens HUD update failed', error); }
    hudTimer = timers.setTimeout(hudTick, HUD_INTERVAL_MS);
  }
  function syncHudLoop() {
    const want = !disposed && !refs.hud.hidden && typeof liveStats === 'function';
    if (want && !hudTimer) hudTimer = timers.setTimeout(hudTick, 0);
    else if (!want && hudTimer) { timers.clearTimeout(hudTimer); hudTimer = 0; }
  }
  function renderHud(d, sampling) {
    syncWorkCounting();
    syncHudLoop();
    if (refs.hud.hidden) return;
    renderWork(d.work);
    if (!hudTimer) renderHudMetrics(hudSource(d, sampling));
  }

  function render() {
    if (disposed) return;
    const optics = state.optics || {};
    const sampling = state.sampling || {};
    const display = state.display || {};
    const af = state.af || {};
    const d = state.diagnostics || {};
    const gates = computeGates(state, pending);
    const enabled = (type) => isCommandEnabled(type, state, pending);

    const view = describeView(state);
    const viewText = display.diagnostic && display.diagnostic !== 'beauty' && state.mode === 'lens'
      ? `诊断视图：${DIAGNOSTIC_LABELS[display.diagnostic] || display.diagnostic}（非成像）` : view.text;
    refs.summary.textContent = viewText;
    refs.root.setAttribute('data-tone', view.tone);
    refs.root.setAttribute('data-status', state.status || 'loading');
    refs.root.setAttribute('aria-busy', String(state.status === 'loading' || pending.size > 0));

    refs.fatal.hidden = !state.error;
    refs.fatal.textContent = state.error
      ? `镜头后端错误：${state.error}${state.status === 'error' ? '。可切换到「A · 光栅近似」，或换镜头/配置尝试恢复。' : ''}` : '';
    renderErrors();

    // Mode A/B
    for (const radio of radioInputs('mode')) {
      radio.checked = radio.value === state.mode;
      setDisabled(radio, !enabled('setMode'));
    }

    // Lens and aperture
    renderLensOptions();
    renderConfigOptions();
    setDisabled(refs.lensFilter, !(state.lenses?.length));
    setDisabled(refs.brandSelect, !(state.lenses?.length));
    setDisabled(refs.availableOnly, !(state.lenses?.length));
    setDisabled(refs.lensSelect, !enabled('selectLens'));
    setDisabled(refs.configSelect, !enabled('selectConfiguration') || !(state.configurations?.length > 1));
    const lens = state.lenses?.find?.((l) => l.id === state.lensId);
    const config = state.configurations?.find?.((c) => c.index === state.configurationIndex);
    const meta = [];
    if (gates.lensLoading) meta.push('正在载入镜头数据…');
    if (Number.isFinite(optics.focalLengthMm)) meta.push(`焦距 ${optics.focalLengthMm.toFixed(1)} mm`);
    if (Array.isArray(optics.sensorMm)) meta.push(`${optics.sensorMm.join('×')} mm`);
    if (lens?.available === false) meta.push(`此镜头不可用：${lens.reason || '原因未提供'}`);
    if (config?.available === false) meta.push(`此配置不可用：${config.reason || '原因未提供'}`);
    refs.lensMeta.textContent = meta.join(' · ');
    refs.lensMeta.classList.toggle('lu-invalid', lens?.available === false || config?.available === false);
    renderWarnings();

    const steps = fSteps();
    const [fMin, fMax] = state.limits?.fNumber || [];
    refs.fRange.max = String(Math.max(0, steps.length - 1));
    const fIndex = nearestStep(steps, optics.fNumber);
    const fApplying = pending.has('setFNumber');
    if (!fApplying) setValue(refs.fRange, String(fIndex));
    if (!editing(refs.fRange)) refs.fRange.setAttribute('aria-valuetext', formatFNumber(optics.fNumber));
    if (Number.isFinite(fMin)) refs.fInput.min = String(fMin);
    if (Number.isFinite(fMax)) refs.fInput.max = String(fMax);
    if (!(fApplying || editing(refs.fInput) || editing(refs.fRange))) setValue(refs.fInput, Number.isFinite(optics.fNumber) ? String(optics.fNumber) : '');
    const fLocked = !enabled('setFNumber');
    setDisabled(refs.fRange, fLocked || steps.length < 2);
    setDisabled(refs.fInput, fLocked);
    fieldHint(refs.fHint, 'fInput', `${Number.isFinite(fMin) ? `${formatFNumber(fMin)} – ${formatFNumber(fMax)}` : '范围未知'} · 只改变光阑，非 T 值${pending.has('setFNumber') ? ' · 应用中…' : ''}`);
    refs.dispersion.checked = Boolean(optics.dispersion);
    setDisabled(refs.dispersion, !enabled('setDispersion'));

    // Focus
    refs.afStatus.textContent = pending.has('autofocus') && af.status !== 'busy' ? AF_LABELS.busy : (AF_LABELS[af.status] || af.status || '');
    refs.afMessage.textContent = af.message || '';
    refs.afMessage.setAttribute('data-af', af.status || 'idle');
    refs.afStatus.setAttribute('data-af', gates.afBusy ? 'busy' : af.status || 'idle');
    setDisabled(refs.afButton, !enabled('autofocus'));
    refs.afButton.setAttribute('aria-busy', String(gates.afBusy));
    refs.afRelease.checked = Boolean(af.autoOnRelease);
    setDisabled(refs.afRelease, !enabled('setAutoFocusOnRelease'));
    // After an image-distance micro-adjust the object distance is not calibrated: show the last request as such.
    const focus = describeFocus(optics);
    const focusM = focus.value;
    const focusApplying = pending.has('setFocusDistance');
    if (!focusApplying) setValue(refs.focusRange, String(nearestStep(FOCUS_STEPS, focusM)));
    if (!editing(refs.focusRange)) refs.focusRange.setAttribute('aria-valuetext', focus.text);
    if (!(focusApplying || editing(refs.focusInput) || editing(refs.focusRange))) {
      setValue(refs.focusInput, focusM === null || !focus.known ? '' : String(Number(focusM.toPrecision(4))));
    }
    refs.focusInput.placeholder = focus.known ? (focusM === null ? '∞' : '') : '未标定';
    refs.focusInf.setAttribute('aria-pressed', String(focus.known && focusM === null));
    refs.focusGroup.setAttribute('data-focus-known', String(focus.known));
    const focusLocked = !enabled('setFocusDistance');
    setDisabled(refs.focusRange, focusLocked);
    setDisabled(refs.focusInput, focusLocked);
    setDisabled(refs.focusInf, focusLocked);
    fieldHint(refs.focusHint, 'focusInput', `${focus.known ? '' : `物距${focus.text}：像距已微调，实际物距未换算 · `}${optics.focusModel || '固定镜组 · 传感器轴向调焦'} · 自${optics.distanceReference || '物方第一面顶点'}起算${pending.has('setFocusDistance') ? ' · 应用中…' : ''}`);
    const [iMin, iMax] = state.limits?.imageDistanceMm || [];
    if (Number.isFinite(iMin)) refs.imageInput.min = String(iMin);
    if (Number.isFinite(iMax)) refs.imageInput.max = String(iMax);
    if (!pending.has('setImageDistance')) setValue(refs.imageInput, Number.isFinite(optics.imageDistanceMm) ? optics.imageDistanceMm.toFixed(3) : '');
    const imageLocked = !enabled('setImageDistance');
    setDisabled(refs.imageInput, imageLocked);
    setDisabled(refs.imageMinus, imageLocked || !(optics.imageDistanceMm > iMin));
    setDisabled(refs.imagePlus, imageLocked || !(optics.imageDistanceMm < iMax));
    fieldHint(refs.imageHint, 'imageInput', `像距＝末面顶点至传感器 · ${Number.isFinite(iMin) ? `${Number(iMin.toFixed(2))}–${Number(iMax.toFixed(2))} mm` : '范围未知'} · 步进 ${IMAGE_NUDGE_MM}${pending.has('setImageDistance') ? ' · 应用中…' : ''}`);
    refs.focusGroup.setAttribute('aria-busy', String(gates.afBusy));
    refs.lensGroup.setAttribute('aria-busy', String(gates.lensLoading));

    // Sampling
    const target = Math.max(0, Number(sampling.targetSpp) || 0);
    const spp = Math.max(0, Number(sampling.spp) || 0);
    refs.progress.max = Math.max(1,target);
    if(target===0)refs.progress.removeAttribute('value');else refs.progress.value = Math.min(spp, target);
    refs.progress.setAttribute('aria-valuetext',samplingText(sampling));
    refs.sppText.textContent = samplingText(sampling);
    const sppValues = [...new Set([...SPP_PRESETS, target])].sort((a, b) => a - b);
    if (refs.sppSelect.getAttribute('data-key') !== String(sppValues)) {
      refs.sppSelect.setAttribute('data-key', String(sppValues));
      refs.sppSelect.replaceChildren(...sppValues.map((v) => h('option', { value: v, text: v===0?'持续采样（不限 spp）':`${v} spp` })));
    }
    setSelect(refs.sppSelect, target);
    setDisabled(refs.sppSelect, !enabled('setTargetSpp'));
    const width = snapResolution(Number(sampling.resolution) || 480);
    const resValues = [...new Set([...RESOLUTION_PRESETS, width])].sort((a, b) => a - b);
    if (refs.resSelect.getAttribute('data-key') !== String(resValues)) {
      refs.resSelect.setAttribute('data-key', String(resValues));
      refs.resSelect.replaceChildren(...resValues.map((v) => h('option', { value: v, text: resolutionLabel(v) })));
    }
    setSelect(refs.resSelect, width);
    setDisabled(refs.resSelect, !enabled('setResolution'));
    refs.pauseButton.textContent = sampling.paused ? '继续采样' : '暂停采样';
    refs.pauseButton.setAttribute('aria-pressed', String(Boolean(sampling.paused)));
    setDisabled(refs.pauseButton, !enabled('setPaused'));
    setDisabled(refs.resetButton, !enabled('reset'));

    // Display
    const ev = Number.isFinite(display.exposureEV) ? display.exposureEV : 0;
    const evApplying = pending.has('setExposureEV');
    if (!evApplying) setValue(refs.evRange, String(ev));
    if (!(evApplying || editing(refs.evRange))) {
      refs.evOut.textContent = formatEV(ev);
      refs.evRange.setAttribute('aria-valuetext', formatEV(ev));
    }
    setDisabled(refs.evRange, !enabled('setExposureEV'));
    setDisabled(refs.evZero, !enabled('setExposureEV') || ev === 0);
    refs.bloom.checked = Boolean(display.bloom);
    setDisabled(refs.bloom, !enabled('setBloom'));
    setSelect(refs.diagSelect, display.diagnostic || 'beauty');
    setDisabled(refs.diagSelect, !enabled('setDiagnostic'));
    refs.diagHint.textContent = display.diagnostic && display.diagnostic !== 'beauty'
      ? `${DIAGNOSTIC_LEGENDS[display.diagnostic] ? `${DIAGNOSTIC_LEGENDS[display.diagnostic]} · ` : ''}不经曝光/Bloom${GEOMETRY_DIAGNOSTICS.includes(display.diagnostic) ? ' · 切换几何类视图会重新累计' : ''}` : '';
    for (const radio of radioInputs('output')) {
      radio.checked = radio.value === (display.output || 'auto');
      setDisabled(radio, !enabled('setOutput'));
    }
    refs.outputHint.textContent = `实际输出：${ACTUAL_OUTPUT_LABELS[display.actualOutput] || display.actualOutput || '待定'}`;

    // Raster quality
    const raster = state.raster || {};
    const rasterEnabled = enabled('setRasterQuality');
    for (const radio of radioInputs('rasterRatio')) {
      radio.checked = radio.value === String(raster.pixelRatio ?? 'auto');
      setDisabled(radio, !rasterEnabled);
    }
    for (const radio of radioInputs('rasterMSAA')) {
      radio.checked = radio.value === String(raster.msaa ?? 4);
      setDisabled(radio, !rasterEnabled);
    }
    for (const [ref, key] of [['rasterAO', 'ambientOcclusion'], ['rasterReflection', 'reflection'], ['rasterAdaptive', 'adaptiveResolution']]) {
      refs[ref].checked = raster[key] ?? RASTER_QUALITY_DEFAULTS[key];
      setDisabled(refs[ref], !rasterEnabled);
    }
    const reduced = [raster.pixelRatio && raster.pixelRatio !== 'auto' ? `${raster.pixelRatio}×` : null, raster.ambientOcclusion === false ? '无 AO' : null,
      raster.reflection === false ? '无反射' : null, raster.msaa === 0 ? '无 MSAA' : null].filter(Boolean);
    refs.rasterValue.textContent = reduced.length ? reduced.join(' · ') : '完整';

    renderScene();
    renderDiagnostics(d, sampling);
    renderSummaries(optics, sampling, display, focus);
    renderThumbnail();
    renderHud(d, sampling);
    setDisabled(refs.exportButton, exporting || !(state.status === 'ready' && (state.mode !== 'lens' || (sampling.spp ?? 0) > 0)));
    refs.exportButton.setAttribute('aria-busy', String(exporting));
    bench.render();

    // Centre AF-S area: the 36×24 sensor is letterboxed about the viewport centre, which is where AF-S
    // evaluates. Shown only when the backend is ready; its look reflects the store's real AF status only.
    refs.reticle.hidden = state.status !== 'ready';
    refs.reticle.setAttribute('data-af', af.status || 'idle');
    refs.reticle.setAttribute('data-mode', state.mode === 'lens' ? 'lens' : 'raster');
  }

  // ---------------------------------------------------------------- mount
  container.appendChild(root);
  container.appendChild(hud);
  container.appendChild(bench.root);
  // Restored without rendering: the first store snapshot renders everything once mounted.
  if (hudSaved?.open) { refs.hud.hidden = false; refs.hudToggle.setAttribute('aria-pressed', 'true'); }
  // Sibling of the page, not inside the panel: the panel's backdrop-filter would make it the containing
  // block for position:fixed and shift the marker off the true viewport centre.
  const reticle = h('div', { class: 'lens-ui-reticle', ref: 'reticle', 'aria-hidden': 'true', hidden: true },
    h('span', { class: 'lu-reticle-frame' }), h('span', { class: 'lu-reticle-dot' }));
  doc.body.appendChild(reticle);
  doc.body?.classList?.add('lens-ui-mounted');
  setOpen(preferredOpen());
  if (narrowQuery) {
    const onBreakpoint = (event) => {
      const next = Boolean(event?.matches ?? narrowQuery.matches);
      if (next === narrow) return;
      narrow = next;
      setOpen(preferredOpen());
    };
    if (typeof narrowQuery.addEventListener === 'function') on(narrowQuery, 'change', onBreakpoint);
    else if (typeof narrowQuery.addListener === 'function') { // older Safari
      narrowQuery.addListener(onBreakpoint);
      cleanups.push(() => narrowQuery.removeListener(onBreakpoint));
    }
  }
  const unsubscribe = store.subscribe((snapshot) => {
    state = snapshot || {};
    // Listeners run inside backend updates: a UI fault must never fail an optics command.
    try { render(); } catch (error) { (win?.console ?? console).error('lens UI render failed', error); }
  });

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      syncHudLoop();
      unsubscribe?.();
      for (const cleanup of cleanups.splice(0)) cleanup();
      if (workCountingSent) Promise.resolve().then(() => store.dispatch('setWorkCounting', false)).catch(() => {});
      root.remove();
      hud.remove();
      bench.dispose();
      bench.root.remove();
      reticle.remove();
      doc.body?.classList?.remove('lens-ui-mounted');
    },
  };
}
