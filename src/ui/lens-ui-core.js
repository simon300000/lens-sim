/**
 * Lens panel DOM. The store snapshot is the only source of truth: controls
 * dispatch commands and re-render from the next snapshot; nothing here touches
 * the renderer, the camera or optics math.
 */
import {
  ACTUAL_OUTPUT_LABELS, AF_LABELS, DIAGNOSTIC_LABELS, HIGH_CACHE_MISS, OUTPUT_LABELS, RESOLUTION_PRESETS,
  SPP_PRESETS, STATUS_LABELS, snapResolution, describeFocus, ALL_BRANDS, brandOf, brandGroups, computeGates, describeView, errorMessage, filterLenses, formatBytes, formatCount,
  formatEV, formatFNumber, formatFocus, formatMm, formatMs, formatRate, isAutofocusShortcut, isCommandEnabled,
  lensOptionLabel, nearestStep, resolutionLabel, samplingText, stepsForFNumber, stepsForFocus, validateFNumber,
  validateFocus, validateImageDistance,
} from './lens-ui-format.js';

const COMMAND_LABELS = {
  setMode: '画面模式', selectLens: '选择镜头', selectConfiguration: '镜头配置', setFNumber: '光圈',
  setFocusDistance: '对焦距离', setImageDistance: '像距', autofocus: 'AF-S', setAutoFocusOnRelease: '松手自动对焦',
  setTargetSpp: '目标 spp', setResolution: '分辨率', setPaused: '暂停/继续', reset: '重置采样',
  setDispersion: '色散', setExposureEV: '显示曝光', setBloom: 'Bloom', setDiagnostic: '诊断视图', setOutput: '输出',
};
/** Slider-like commands coalesce to the latest value while one is in flight. */
const COALESCED = new Set(['setFNumber', 'setFocusDistance', 'setImageDistance', 'setExposureEV', 'setTargetSpp',
  'setResolution', 'selectLens', 'selectConfiguration', 'setDiagnostic', 'setOutput', 'setMode']);
const FOCUS_STEPS = stepsForFocus();
const IMAGE_NUDGE_MM = 0.01;

const LIMITATIONS = [
  '镜头：按实际处方逆向折射追迹；每条尝试路径取一个连续波长，失败路径记为零、不补样；XYZ 以 f32 累积。',
  '场景：输入是现有 RGB 线性光栅与单层深度，属屏幕空间近似，并非完整场景路径追踪；RGB→光谱为近似重建。',
  '未模拟：镀膜与透过率（T=1）、鬼影、衍射、传感器噪声。f 值为几何光圈，不是 T 值。',
  '单层深度无法表现被遮挡的前景，前景焦外与遮挡边缘不完整；不是光场。',
  '对焦：固定镜组，整体移动传感器（无内对焦）；距离自物方第一面顶点起算。',
  '水面反射仍为中心视角近似。未知玻璃、DOE、奇次/特殊面的镜头标为不可用。',
];

let instances = 0;

export function createLensUI({ store, container } = {}) {
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
  const root = h('section', { class: 'lens-ui', ref: 'root', 'aria-label': '镜头模拟控制' },
    h('div', { class: 'lu-head' },
      h('button', { type: 'button', class: 'lu-toggle', ref: 'toggle', id: id('toggle'), 'aria-controls': id('body') },
        h('span', { class: 'lu-title', text: '镜头' }),
        h('span', { class: 'lu-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'lu-summary', ref: 'summary' }),
        h('span', { class: 'lu-chevron', 'aria-hidden': 'true' }))),
    h('div', { class: 'lu-body', ref: 'body', id: id('body'), role: 'region', 'aria-labelledby': id('toggle') },
      h('div', { class: 'lu-alert', ref: 'fatal', role: 'alert', hidden: true }),
      h('ul', { class: 'lu-errors', ref: 'errors', 'aria-live': 'assertive', 'aria-label': '命令失败' }),

      radios('mode', '画面', [['raster', 'A · 光栅近似', '现有 RGB 光栅画面，不经过镜头'], ['lens', 'B · 镜头追迹', '按镜头处方追迹并累积']]),

      // Most-used actions stay above the fold: AF-S, pause and the real sample count.
      h('div', { class: 'lu-quick', ref: 'quick', role: 'group', 'aria-label': '常用操作' },
        h('div', { class: 'lu-af' },
          h('button', { type: 'button', class: 'lu-btn lu-primary', ref: 'afButton', 'aria-keyshortcuts': 'F', 'aria-label': 'AF-S 单次自动对焦（快捷键 F）', 'aria-describedby': `${id('afStatus')} ${id('afMessage')}` }, 'AF-S', h('kbd', { text: 'F' })),
          h('span', { class: 'lu-af-status', ref: 'afStatus', id: id('afStatus'), role: 'status' }),
          h('button', { type: 'button', class: 'lu-btn', ref: 'pauseButton' })),
        h('p', { class: 'lu-hint lu-af-message', ref: 'afMessage', id: id('afMessage') }),
        h('div', { class: 'lu-progress-row' },
          h('progress', { ref: 'progress', id: id('progress'), max: 1, value: 0, 'aria-label': '采样进度', 'aria-describedby': `${id('sppText')} ${id('sppHint')}`, title: '每像素实际尝试路径 / 目标；颗粒随 spp 增加而减弱' }),
          h('span', { class: 'lu-spp', ref: 'sppText', id: id('sppText') }))),

      h('section', { class: 'lu-group', ref: 'focusGroup', 'aria-labelledby': id('h-focus') },
        h('h3', { id: id('h-focus'), text: '对焦' }),
        h('div', { class: 'lu-row lu-slider-row' }, label('focusRange', '距离'),
          h('input', { type: 'range', ref: 'focusRange', id: id('focusRange'), min: 0, max: FOCUS_STEPS.length - 1, step: 1, 'aria-describedby': id('focusHint') }),
          h('input', { type: 'number', ref: 'focusInput', id: id('focusInput'), class: 'lu-num', step: 0.01, min: 0, inputmode: 'decimal', 'aria-label': '对焦距离（米）', 'aria-describedby': id('focusHint') }),
          h('span', { class: 'lu-unit', 'aria-hidden': 'true', text: 'm' }),
          h('button', { type: 'button', class: 'lu-btn lu-inf', ref: 'focusInf', 'aria-label': '对焦到无穷远', title: '对焦到无穷远', text: '∞' })),
        h('div', { class: 'lu-row' }, label('imageInput', '像距'),
          h('button', { type: 'button', class: 'lu-btn lu-nudge', ref: 'imageMinus', 'aria-label': `像距减 ${IMAGE_NUDGE_MM} mm`, text: '−' }),
          h('input', { type: 'number', ref: 'imageInput', id: id('imageInput'), class: 'lu-num lu-num-wide', step: 0.001, inputmode: 'decimal', 'aria-describedby': `${id('imageHint')} ${id('focusHint')}` }),
          h('span', { class: 'lu-unit', 'aria-hidden': 'true', text: 'mm' }),
          h('button', { type: 'button', class: 'lu-btn lu-nudge', ref: 'imagePlus', 'aria-label': `像距加 ${IMAGE_NUDGE_MM} mm`, text: '+' })),
        hint('imageHint'),
        hint('focusHint'),
        check('afRelease', '环视松手后自动对焦')),

      h('section', { class: 'lu-group', ref: 'lensGroup', 'aria-labelledby': id('h-lens') },
        h('h3', { id: id('h-lens'), text: '镜头与光圈' }),
        // Two layers: brand first, then a lens of that brand. Search narrows within the chosen brand.
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
          h('span', { class: 'lu-unit', 'aria-hidden': 'true', text: 'f/' }),
          h('input', { type: 'number', ref: 'fInput', id: id('fInput'), class: 'lu-num', step: 0.1, inputmode: 'decimal', 'aria-label': '光圈 f 值', 'aria-describedby': id('fHint') })),
        hint('fHint'),
        check('dispersion', '色散（每条路径单一波长）')),

      h('section', { class: 'lu-group', ref: 'samplingGroup', 'aria-labelledby': id('h-sampling') },
        h('h3', { id: id('h-sampling'), text: '采样' }),
        h('div', { class: 'lu-row lu-sampling-row' },
          label('sppSelect', '目标采样数', { class: 'visually-hidden' }),
          h('select', { ref: 'sppSelect', id: id('sppSelect'), title: '目标采样数（每像素尝试路径）' }),
          label('resSelect', '分辨率', { class: 'visually-hidden' }),
          h('select', { ref: 'resSelect', id: id('resSelect'), title: '累积图像尺寸（像素）：宽度取 3 的倍数，固定 3:2 带黑边' }),
          h('button', { type: 'button', class: 'lu-btn', ref: 'resetButton', title: '清空当前累积，按现有参数重新采样', 'aria-label': '重置采样', text: '重置' })),
        h('p', { class: 'lu-hint', ref: 'sppHint', id: id('sppHint') },
          '颗粒来自波长与光圈的蒙特卡罗积分，约按 ', h('span', { class: 'lu-nowrap', text: '1/√spp' }),
          ' 减弱；提高目标会接着累积。不含传感器噪声，不做降噪。'),
        h('div', { class: 'lu-warn', ref: 'cacheWarn', role: 'status', hidden: true },
          h('span', { ref: 'cacheWarnText' }),
          h('button', { type: 'button', class: 'lu-link', ref: 'cacheWarnView', text: '查看分布' }))),

      h('section', { class: 'lu-group', ref: 'displayGroup', 'aria-labelledby': id('h-display') },
        h('h3', { id: id('h-display'), text: '显示' }),
        h('div', { class: 'lu-row lu-slider-row' }, label('evRange', '曝光'),
          h('input', { type: 'range', ref: 'evRange', id: id('evRange'), min: -6, max: 6, step: 1 / 3, 'aria-describedby': id('evHint') }),
          h('output', { ref: 'evOut', for: id('evRange'), class: 'lu-out' }),
          h('button', { type: 'button', class: 'lu-btn lu-nudge', ref: 'evZero', title: '曝光归零', 'aria-label': '显示曝光归零', text: '0' })),
        hint('evHint', '附加显示曝光，不改变光学参数，也不自动归一亮度。'),
        h('div', { class: 'lu-row lu-row-split' },
          check('bloom', 'Bloom'),
          h('div', { class: 'lu-cell' }, label('diagSelect', '视图'),
            h('select', { ref: 'diagSelect', id: id('diagSelect') },
              Object.entries(DIAGNOSTIC_LABELS).map(([value, text]) => h('option', { value, text }))))),
        radios('output', '输出', [['auto', OUTPUT_LABELS.auto, '显示链路支持时输出 HDR'], ['sdr', OUTPUT_LABELS.sdr, '强制 SDR 色调映射']]),
        hint('outputHint')),

      h('details', { class: 'lu-details', ref: 'diagDetails' },
        h('summary', { text: '技术诊断' }),
        h('div', { class: 'lu-rates', ref: 'rates' }),
        h('dl', { class: 'lu-dl', ref: 'diagList' })),
      h('details', { class: 'lu-details' },
        h('summary', { text: '物理范围与局限' }),
        h('ul', { class: 'lu-limits' }, LIMITATIONS.map((text) => h('li', { text })))),
      h('p', { class: 'lu-foot' }, h('kbd', { text: 'F' }), ' AF-S（不在输入框时）', h('span', { 'aria-hidden': 'true', text: ' · ' }), h('kbd', { text: 'Esc' }), ' 收起面板')),
    h('div', { class: 'visually-hidden', ref: 'announcer', 'aria-live': 'polite' }));

  // Denominators differ: scene-cache misses are per ray that passed the optics, the rest per attempted ray.
  const RATE_GROUPS = [
    ['占尝试光线', [['opticalPassRate', '通过镜头'], ['opticalBlockedRate', '镜筒/光阑遮挡'], ['tirRate', '全内反射'], ['numericalErrorRate', '数值失败']]],
    ['占通过镜头的光线', [['cacheMissRate', '场景缓存未命中']]],
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
  on(refs.cacheWarnView, 'click', () => run('setDiagnostic', 'cache-miss'));

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
    const key = JSON.stringify([lenses.map((l) => [l.id, l.name, l.available, l.reason, l.brand]), query, availableOnly, state.lensId, brand]);
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
      refs[`rateRow-${key}`].hidden = !provided && key === 'opticalPassRate'; // optional backend field
      const known = provided && d.attemptedSamples > 0;
      refs[`rate-${key}`].style.setProperty('width', known ? `${Math.min(100, Math.max(0, rate * 100))}%` : '0%');
      refs[`rateText-${key}`].textContent = known ? formatRate(rate) : '—';
    }
    const rows = [
      ['实际 / 目标', `${formatCount(sampling.spp)} / ${formatCount(sampling.targetSpp)} spp`],
      ['每批', `${formatCount(sampling.batchSpp)} spp`],
      ['尝试路径', formatCount(d.attemptedSamples)],
      ['捕获耗时', formatMs(d.captureMs)],
      ['计算耗时', formatMs(d.computeMs)],
      ['计时来源', d.timingSource || '—'],
      ['累积缓冲', d.width && d.height ? `${d.width} × ${d.height}` : '—'],
      ['显存', formatBytes(d.memoryBytes)],
      ['场景捕获', formatCount(d.captures)],
      ['管线编译', formatCount(d.pipelineCompilations)],
      ['随机种子', formatCount(sampling.seed)],
      ['修订 场景/光学/显示/累积', state.revisions ? ['scene', 'optics', 'display', 'accumulation'].map((k) => state.revisions[k] ?? '—').join(' / ') : '—'],
    ];
    const key = JSON.stringify(rows);
    if (refs.diagList.getAttribute('data-key') === key) return;
    refs.diagList.setAttribute('data-key', key);
    refs.diagList.replaceChildren(...rows.flatMap(([term, value]) => [h('dt', { text: term }), h('dd', { text: value })]));
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
    const target = Math.max(1, Number(sampling.targetSpp) || 1);
    const spp = Math.max(0, Number(sampling.spp) || 0);
    refs.progress.max = target;
    refs.progress.value = Math.min(spp, target);
    refs.sppText.textContent = samplingText(sampling);
    const sppValues = [...new Set([...SPP_PRESETS, target])].sort((a, b) => a - b);
    if (refs.sppSelect.getAttribute('data-key') !== String(sppValues)) {
      refs.sppSelect.setAttribute('data-key', String(sppValues));
      refs.sppSelect.replaceChildren(...sppValues.map((v) => h('option', { value: v, text: `${v} spp` })));
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
    const highMiss = d.attemptedSamples > 0 && d.cacheMissRate >= HIGH_CACHE_MISS;
    refs.cacheWarn.hidden = !highMiss;
    refs.cacheWarnText.textContent = highMiss ? `场景缓存未命中偏高：${formatRate(d.cacheMissRate)}（占通过镜头的光线）` : '';
    refs.cacheWarnView.hidden = display.diagnostic === 'cache-miss';
    setDisabled(refs.cacheWarnView, !enabled('setDiagnostic'));

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
    for (const radio of radioInputs('output')) {
      radio.checked = radio.value === (display.output || 'auto');
      setDisabled(radio, !enabled('setOutput'));
    }
    refs.outputHint.textContent = `实际输出：${ACTUAL_OUTPUT_LABELS[display.actualOutput] || display.actualOutput || '待定'}`;

    renderDiagnostics(d, sampling);

    // Centre AF-S area: the 36×24 sensor is letterboxed about the viewport centre, which is where AF-S
    // evaluates. Shown only when the backend is ready; its look reflects the store's real AF status only.
    refs.reticle.hidden = state.status !== 'ready';
    refs.reticle.setAttribute('data-af', af.status || 'idle');
    refs.reticle.setAttribute('data-mode', state.mode === 'lens' ? 'lens' : 'raster');
  }

  // ---------------------------------------------------------------- mount
  container.appendChild(root);
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
    render();
  });

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      for (const cleanup of cleanups.splice(0)) cleanup();
      root.remove();
      reticle.remove();
      doc.body?.classList?.remove('lens-ui-mounted');
    },
  };
}
