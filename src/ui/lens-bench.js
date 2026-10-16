/**
 * Lens workbench drawer: lens layout (elements + traced bundles), an editable
 * prescription table and .seq/.zmx import, after lens-bench's LDE and Layout panes.
 *
 * Unapplied edits are previewed live (same adapter + static preflight as the build);
 * 「应用到渲染」 loads the edited record as a session-only custom lens through the
 * store's `loadCustomLens` command. Nothing here talks to the renderer directly.
 */
import { computeLensLayout } from './lens-layout.js';
import {
  loadGlassCatalog, importLensFile, recordToDraft, draftToRecord, insertSurface, deleteSurface,
  validateCell, rowType, isCustomLensId,
} from '../optics/lens-workbench.js';
import { adaptLensRecord } from '../optics/prescription.js';
import { preflightLens } from '../optics/capabilities.js';
import { apertureLimits } from '../optics/lens-state.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FIELDS = ['R', 'T', 'mat', 'sd', 'k', 'asph'];
const FIELD_LABELS = { R: '半径 R', T: '厚度 T', mat: '玻璃', sd: '半孔径', k: '圆锥 K', asph: '非球面系数' };
const HISTORY_LIMIT = 80;

/** Pure SVG drawing of a computed layout into `svg` (replaces its children). */
export function drawLayoutSVG(doc, svg, layout, { compact = false, labels = true } = {}) {
  const s = (tag, attrs = {}, ...children) => {
    const el = doc.createElementNS ? doc.createElementNS(SVG_NS, tag) : doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
    for (const c of children) if (c) el.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
    return el;
  };
  const { minZ, maxZ, maxY } = layout.bounds;
  const pad = (maxZ - minZ) * 0.03 + 1;
  const vb = [minZ - pad, -maxY, maxZ - minZ + 2 * pad, 2 * maxY];
  svg.setAttribute('viewBox', vb.map((v) => v.toFixed(3)).join(' '));
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const P = ([z, y]) => `${z.toFixed(3)} ${(-y).toFixed(3)}`;
  const nodes = [];
  nodes.push(s('line', { class: 'lb-axis', x1: vb[0], x2: vb[0] + vb[2], y1: 0, y2: 0, 'vector-effect': 'non-scaling-stroke' }));
  const glass = s('g', { class: 'lb-elements' });
  for (const e of layout.elements) {
    const d = `M${e.front.map(P).join(' L')} L${e.back.slice().reverse().map(P).join(' L')} Z`;
    glass.appendChild(s('path', { d, class: e.cemented ? 'lb-glass lb-cemented' : 'lb-glass', 'vector-effect': 'non-scaling-stroke' },
      s('title', {}, `S${e.first + 1}–S${e.last + 1} ${e.glass || ''}`)));
  }
  nodes.push(glass);
  for (const b of layout.bundles) {
    const g = s('g', { class: `lb-rays lb-field-${Math.min(b.fieldIndex, 4)}` });
    for (const path of b.rays) g.appendChild(s('path', { d: `M${path.map(P).join(' L')}`, 'vector-effect': 'non-scaling-stroke' }));
    nodes.push(g);
  }
  const { z: sz, radius: sr } = layout.stop;
  if (Number.isFinite(sr)) {
    const tip = sr * 1.4 + 0.5;
    nodes.push(s('line', { class: 'lb-stop', x1: sz, x2: sz, y1: -sr, y2: -tip, 'vector-effect': 'non-scaling-stroke' }));
    nodes.push(s('line', { class: 'lb-stop', x1: sz, x2: sz, y1: sr, y2: tip, 'vector-effect': 'non-scaling-stroke' }));
  }
  const h = layout.sensor.halfHeight;
  nodes.push(s('line', { class: 'lb-sensor', x1: layout.sensor.z, x2: layout.sensor.z, y1: -h, y2: h, 'vector-effect': 'non-scaling-stroke' }));
  if (labels && !compact) {
    const fs = (2 * maxY) * 0.04;
    nodes.push(s('text', { class: 'lb-label', x: sz, y: -(sr * 1.4 + 0.5) - fs * 0.5, 'font-size': fs.toFixed(3), 'text-anchor': 'middle' }, '光阑'));
    nodes.push(s('text', { class: 'lb-label', x: layout.sensor.z - fs * 0.4, y: -h - fs * 0.5, 'font-size': fs.toFixed(3), 'text-anchor': 'end' }, '像面'));
  }
  svg.replaceChildren(...nodes);
}

export function layoutFor(prescription, focalLengthMm) {
  try { return { layout: computeLensLayout(prescription, { focalLengthMm }) }; }
  catch (error) { return { error: error.message }; }
}

export function createLensBench({ h, refs, on, doc, win, id, store, getState, announce, onClose }) {
  let record = null, recordKey = '', draft = null, history = [], future = [], dirty = false;
  let selected = 0, preview = null, previewTimer = null, previewToken = 0, busy = '', importWarnings = [], open = false;
  let lastLayoutKey = '', message = { tone: '', text: '' };

  // ---------------------------------------------------------------- DOM
  const svg = doc.createElementNS ? doc.createElementNS(SVG_NS, 'svg') : doc.createElement('svg');
  svg.setAttribute('class', 'lb-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '镜组截面与光线');
  const fileInput = h('input', { type: 'file', accept: '.seq,.zmx,.SEQ,.ZMX,.txt,.len', class: 'visually-hidden', ref: 'benchFile', id: id('benchFile'), tabindex: '-1', 'aria-label': '选择 .seq 或 .zmx 镜头文件' });
  const tool = (ref, text, title, extra = {}) => h('button', { type: 'button', class: 'lu-btn lu-btn-quiet', ref, title, ...extra }, text);
  const root = h('section', { class: 'lens-bench', ref: 'bench', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': id('benchTitle'), hidden: true },
    h('header', { class: 'lb-head' },
      h('div', { class: 'lb-title-block' },
        h('h2', { class: 'lb-title', id: id('benchTitle'), text: '镜组工作台' }),
        h('p', { class: 'lb-subtitle', ref: 'benchSubtitle' })),
      h('div', { class: 'lb-head-actions' },
        fileInput,
        h('button', { type: 'button', class: 'lu-btn', ref: 'benchImport', title: '导入 CODE V .seq 或 Zemax .zmx（也可直接拖入）' }, '导入 .seq / .zmx'),
        h('button', { type: 'button', class: 'lu-icon-btn', ref: 'benchClose', 'aria-label': '关闭镜组工作台', title: '关闭（Esc）' }, h('span', { class: 'lu-x', 'aria-hidden': 'true' })))),
    h('div', { class: 'lb-layout' },
      svg,
      h('div', { class: 'lb-legend', ref: 'benchLegend', 'aria-live': 'polite' }),
      h('div', { class: 'lb-drop', 'aria-hidden': 'true' }, h('span', { text: '松开以导入 .seq / .zmx' }))),
    h('div', { class: 'lb-toolbar', role: 'toolbar', 'aria-label': '处方编辑' },
      h('div', { class: 'lb-tool-group' },
        tool('benchInsert', '插入面', '在所选面之前插入一个空气平面'),
        tool('benchDelete', '删除面', '删除所选面'),
        tool('benchStop', '设为光阑', '把所选面设为孔径光阑')),
      h('div', { class: 'lb-tool-group' },
        tool('benchUndo', '撤销', '撤销（⌘Z）'),
        tool('benchRedo', '重做', '重做（⇧⌘Z）'),
        tool('benchRevert', '恢复初始', '放弃全部未应用的修改')),
      h('div', { class: 'lb-tool-group lb-tool-end' },
        tool('benchExport', '导出', '把当前处方导出为 lens-bench JSON 记录'),
        h('button', { type: 'button', class: 'lu-btn lu-primary', ref: 'benchApply', title: '用编辑后的处方重新成像（仅本页会话）' }, '应用到渲染'))),
    h('p', { class: 'lb-status', ref: 'benchStatus', role: 'status' }),
    h('div', { class: 'lb-meta' },
      h('label', { class: 'lb-field' }, h('span', { text: '名称' }), h('input', { type: 'text', ref: 'benchName', class: 'lb-input', spellcheck: 'false', autocomplete: 'off' })),
      h('label', { class: 'lb-field lb-field-narrow' }, h('span', { ref: 'benchFnoLabel', text: 'F/#' }), h('input', { type: 'text', ref: 'benchFno', class: 'lb-input lb-num', inputmode: 'decimal', autocomplete: 'off' }))),
    h('div', { class: 'lb-table-wrap', ref: 'benchTableWrap' },
      h('table', { class: 'lb-table', 'aria-label': '镜头处方' },
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col', class: 'lb-c-n', text: '面' }), h('th', { scope: 'col', class: 'lb-c-type', text: '类型' }),
          ...FIELDS.map((f) => h('th', { scope: 'col', class: `lb-c-${f}`, text: FIELD_LABELS[f] })))),
        h('tbody', { ref: 'benchRows' }))),
    h('details', { class: 'lu-warn-details lb-warn', ref: 'benchWarnDetails', hidden: true },
      h('summary', { ref: 'benchWarnSummary' }), h('ul', { class: 'lu-warnings', ref: 'benchWarnings' })));

  // ---------------------------------------------------------------- data
  const currentState = () => getState();
  const snapshot = () => structuredClone({ record, draft });
  function pushHistory() {
    history.push(snapshot());
    if (history.length > HISTORY_LIMIT) history.shift();
    future = [];
  }
  function setMessage(tone, text) { message = { tone, text }; renderStatus(); }

  async function ensureRecord(force = false) {
    const s = currentState();
    const key = `${s.lensId}|${s.configurationIndex}`;
    if (!force && (key === recordKey || dirty)) return;
    if (!s.lensId || s.status === 'loading') return;
    recordKey = key;
    let next = null;
    try { next = await store.dispatch('getLensRecord'); } catch { next = null; }
    if (key !== recordKey) return;
    record = next;
    draft = record ? recordToDraft(record, s.configurationIndex ?? 0) : null;
    history = []; future = []; dirty = false; preview = null; selected = Math.min(selected, (draft?.rows.length ?? 1) - 1);
    renderTable(); renderAll();
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, 140);
  }
  async function runPreview() {
    if (!dirty || !draft || !record) { preview = null; renderLayout(); return; }
    const token = ++previewToken;
    const invalid = draft.rows.flatMap((row, i) => FIELDS.map((f) => (validateCell(f, row[f]) ? `S${i + 1} ${FIELD_LABELS[f]}：${validateCell(f, row[f])}` : ''))).filter(Boolean);
    if (invalid.length) { preview = { error: invalid[0] }; renderAll(); return; }
    try {
      const catalog = await loadGlassCatalog();
      if (token !== previewToken) return;
      const rec = draftToRecord(record, draft);
      const lens = adaptLensRecord(rec, catalog, { configurationIndex: draft.configurationIndex });
      const check = preflightLens(lens);
      const limits = apertureLimits(lens);
      const stopRadiusMm = Math.abs(limits.focalLengthMm * limits.pupilMagnification) / (2 * Math.max(limits.minFNumber, currentState().optics?.fNumber ?? limits.minFNumber));
      const p = { ...lens, stopRadiusMm, sensorZMm: lens.sensorZMm, focusDistanceM: lens.objectDistanceMm === null ? null : lens.objectDistanceMm / 1000 };
      preview = { prescription: p, focalLengthMm: limits.focalLengthMm, fNumber: limits.minFNumber, check, ...layoutFor(p, limits.focalLengthMm) };
    } catch (error) { preview = { error: error.message }; }
    if (token === previewToken) renderAll();
  }

  function edit(mutator) {
    if (!draft) return;
    pushHistory();
    mutator();
    dirty = true;
    schedulePreview();
    renderAll();
  }

  // ---------------------------------------------------------------- table
  function cellInput(i, field, row) {
    const overridden = (field === 'T' || field === 'R') && draft.overridden[field].includes(i);
    const hint = field === 'sd' && !row.sd && draft.apertureHints[i] ? String(Number(Number(draft.apertureHints[i]).toFixed(4))) : '';
    const el = h('input', {
      type: 'text', class: `lb-cell lb-cell-${field}${overridden ? ' lb-cfg' : ''}`, value: row[field] ?? '', spellcheck: 'false', autocomplete: 'off',
      'aria-label': `S${i + 1} ${FIELD_LABELS[field]}`, 'data-row': i, 'data-field': field, placeholder: hint || (field === 'mat' ? '空气' : ''),
      title: overridden ? `随配置变化：此值属于「${record?.cfgs?.[draft.configurationIndex]?.title ?? '当前配置'}」` : hint ? `未写通光；${record?.sdAp?.[i] ? '文件通光' : '绘图半径'} ${hint}` : false,
      inputmode: field === 'mat' || field === 'asph' ? false : 'decimal',
    });
    el.value = row[field] ?? '';
    return el;
  }
  function renderTable() {
    const body = refs.benchRows;
    if (!draft) { body.replaceChildren(h('tr', {}, h('td', { colspan: 8, class: 'lb-empty', text: record === null && recordKey ? '此镜头没有可编辑的源处方' : '正在读取处方…' }))); return; }
    const s = currentState();
    const objectText = draft.objectDistanceMm === null || !Number.isFinite(draft.objectDistanceMm) || draft.objectDistanceMm >= 1e7 ? '∞' : `${Number(draft.objectDistanceMm.toFixed(3))}`;
    const rows = [h('tr', { class: 'lb-row lb-fixed' }, h('th', { scope: 'row', class: 'lb-c-n', text: '物面' }), h('td', { class: 'lb-c-type', text: '—' }),
      h('td', { class: 'lb-c-R lb-ro', text: '∞' }), h('td', { class: 'lb-c-T lb-ro', text: objectText, title: '物距（来自所选配置）' }), h('td', { colspan: 4 }))];
    draft.rows.forEach((row, i) => {
      const isStop = i === draft.stopIndex;
      rows.push(h('tr', { class: `lb-row${i === selected ? ' lb-selected' : ''}${isStop ? ' lb-stop-row' : ''}`, 'data-row': i, 'aria-selected': String(i === selected) },
        h('th', { scope: 'row', class: 'lb-c-n' }, h('button', { type: 'button', class: 'lb-select', 'data-select': i, 'aria-label': `选择第 ${i + 1} 面${isStop ? '（光阑）' : ''}` }, isStop ? '光阑' : String(i + 1))),
        h('td', { class: 'lb-c-type', 'data-type': i, text: rowType(row) }),
        ...FIELDS.map((f) => h('td', { class: `lb-c-${f}` }, cellInput(i, f, row)))));
    });
    const gap = s.prescription && s.prescription.id === s.lensId && !dirty ? s.prescription.sensorZMm - s.prescription.lastVertexZMm : null;
    rows.push(h('tr', { class: 'lb-row lb-fixed' }, h('th', { scope: 'row', class: 'lb-c-n', text: '像面' }), h('td', { class: 'lb-c-type', text: '—' }),
      h('td', { class: 'lb-c-R lb-ro', text: '∞' }), h('td', { class: 'lb-c-T lb-ro', text: gap === null ? '—' : gap.toFixed(4), title: '当前像距（末面顶点至传感器，含对焦）' }), h('td', { colspan: 4 })));
    body.replaceChildren(...rows);
  }
  function focusCell(i, field) {
    const el = refs.benchRows.querySelector(`[data-row="${i}"][data-field="${field}"]`);
    el?.focus?.();
  }

  on(refs.benchRows, 'input', (event) => {
    const el = event.target, field = el?.getAttribute?.('data-field');
    if (!field || !draft) return;
    const problem = validateCell(field, el.value);
    if (problem) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
    el.title = problem || '';
  });
  on(refs.benchRows, 'change', (event) => {
    const el = event.target, field = el?.getAttribute?.('data-field');
    if (!field || !draft) return;
    const i = Number(el.getAttribute('data-row'));
    const value = el.value.trim();
    if (draft.rows[i][field] === value) return;
    edit(() => { draft.rows[i][field] = value; });
    const type = refs.benchRows.querySelector(`[data-type="${i}"]`);
    if (type) type.textContent = rowType(draft.rows[i]);
  });
  on(refs.benchRows, 'focusin', (event) => {
    const row = event.target?.getAttribute?.('data-row') ?? event.target?.getAttribute?.('data-select');
    if (row === null || row === undefined) return;
    select(Number(row), false);
  });
  on(refs.benchRows, 'click', (event) => {
    const row = event.target?.getAttribute?.('data-select');
    if (row !== null && row !== undefined) select(Number(row), true);
  });
  on(refs.benchRows, 'keydown', (event) => {
    const el = event.target, field = el?.getAttribute?.('data-field');
    if (!field || !draft) return;
    const i = Number(el.getAttribute('data-row'));
    if (event.key === 'Enter' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { if (event.altKey || event.metaKey) return; }
      event.preventDefault();
      el.dispatchEvent(new (win?.Event ?? Event)('change', { bubbles: true }));
      const next = i + (event.key === 'ArrowUp' || (event.key === 'Enter' && event.shiftKey) ? -1 : 1);
      if (next >= 0 && next < draft.rows.length) focusCell(next, field);
    }
  });
  function select(i, focusRow) {
    if (!draft || i === selected) return;
    selected = Math.max(0, Math.min(draft.rows.length - 1, i));
    for (const tr of refs.benchRows.querySelectorAll('tr[data-row]')) {
      const on_ = Number(tr.getAttribute('data-row')) === selected;
      tr.classList.toggle('lb-selected', on_);
      tr.setAttribute('aria-selected', String(on_));
    }
    if (focusRow) announce(`已选择第 ${selected + 1} 面`);
    renderToolbar();
  }

  // ---------------------------------------------------------------- toolbar
  function structural(fn) {
    try {
      pushHistory();
      const result = fn();
      record = result.record; draft = result.draft;
      dirty = true; schedulePreview(); renderTable(); renderAll();
    } catch (error) { history.pop(); setMessage('error', error.message); }
  }
  on(refs.benchInsert, 'click', () => structural(() => insertSurface(record, draft, selected)));
  on(refs.benchDelete, 'click', () => structural(() => { const r = deleteSurface(record, draft, selected); selected = Math.min(selected, r.draft.rows.length - 1); return r; }));
  on(refs.benchStop, 'click', () => { if (draft && selected !== draft.stopIndex) { edit(() => { draft.stopIndex = selected; }); renderTable(); } });
  function restore(state) { ({ record, draft } = structuredClone(state)); dirty = true; schedulePreview(); renderTable(); renderAll(); }
  function undo() { if (!history.length) return; future.push(snapshot()); restore(history.pop()); }
  function redo() { if (!future.length) return; history.push(snapshot()); restore(future.pop()); }
  on(refs.benchUndo, 'click', undo);
  on(refs.benchRedo, 'click', redo);
  on(refs.benchRevert, 'click', () => { dirty = false; recordKey = ''; preview = null; ensureRecord(true); setMessage('', '已恢复为当前镜头的原始处方'); });
  on(refs.benchName, 'change', () => { if (draft && refs.benchName.value.trim() && refs.benchName.value.trim() !== draft.name) edit(() => { draft.name = refs.benchName.value.trim(); }); });
  on(refs.benchFno, 'change', () => {
    const v = Number(refs.benchFno.value);
    if (!draft) return;
    if (!(v > 0)) { refs.benchFno.setAttribute('aria-invalid', 'true'); return; }
    refs.benchFno.removeAttribute('aria-invalid');
    if (v !== draft.fno) edit(() => { draft.fno = v; });
  });
  on(root, 'keydown', (event) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && String(event.key).toLowerCase() === 'z' && event.target?.tagName !== 'INPUT') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
  });

  async function apply() {
    if (!draft || !record || busy) return;
    const s = currentState();
    const rec = draftToRecord(record, draft);
    if (!isCustomLensId(s.lensId)) {
      rec.id = `${record.id || 'lens'}-edit`;
      if (rec.name === record.name) rec.name = `${record.name}（编辑）`;
    }
    busy = 'apply'; setMessage('busy', '正在预检并载入编辑后的处方…'); renderToolbar();
    try {
      await store.dispatch('loadCustomLens', { record: rec, configurationIndex: draft.configurationIndex });
      dirty = false; preview = null; recordKey = '';
      setMessage('ok', '已应用：当前画面使用编辑后的处方（仅本页会话，不写入链接）');
      announce('编辑后的处方已应用');
      await ensureRecord(true);
    } catch (error) { setMessage('error', `应用失败：${error.message}`); }
    finally { busy = ''; renderToolbar(); }
  }
  on(refs.benchApply, 'click', apply);

  async function importFile(file) {
    if (!file || busy) return;
    busy = 'import'; setMessage('busy', `正在读取 ${file.name}…`); renderToolbar();
    try {
      const [buffer, catalog] = await Promise.all([file.arrayBuffer(), loadGlassCatalog()]);
      const rec = importLensFile(new Uint8Array(buffer), file.name, catalog);
      importWarnings = rec.warn ?? [];
      const result = await store.dispatch('loadCustomLens', { record: rec, configurationIndex: 0 });
      dirty = false; preview = null; recordKey = '';
      setMessage('ok', `已导入 ${file.name}：${rec.sub || ''}${result?.warnings?.length ? ` · ${result.warnings.length} 条提示` : ''}`);
      announce(`已导入 ${rec.name}`);
      await ensureRecord(true);
    } catch (error) { setMessage('error', `导入失败：${error.message}`); }
    finally { busy = ''; fileInput.value = ''; renderToolbar(); renderWarnings(); }
  }
  on(refs.benchImport, 'click', () => fileInput.click());
  on(fileInput, 'change', () => importFile(fileInput.files?.[0]));
  on(root, 'dragover', (event) => { if (event.dataTransfer?.types?.includes?.('Files')) { event.preventDefault(); root.classList.add('lb-dragging'); } });
  on(root, 'dragleave', (event) => { if (event.target === root || !root.contains?.(event.relatedTarget)) root.classList.remove('lb-dragging'); });
  on(root, 'drop', (event) => { event.preventDefault(); root.classList.remove('lb-dragging'); importFile(event.dataTransfer?.files?.[0]); });
  on(refs.benchExport, 'click', () => {
    if (!record || !draft) return;
    const rec = draftToRecord(record, draft);
    const blob = new Blob([JSON.stringify(rec, null, 1)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = doc.createElement('a');
    a.href = url; a.download = `${(rec.id || 'lens').replace(/[^\w.-]+/g, '-')}.json`;
    doc.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });
  on(refs.benchClose, 'click', () => close());

  // ---------------------------------------------------------------- render
  function renderStatus() {
    const s = currentState();
    let tone = message.tone, text = message.text;
    if (!text) {
      if (dirty && preview?.error) { tone = 'error'; text = `未应用的修改无法成像：${preview.error}`; }
      else if (dirty && preview?.check && !preview.check.supported) { tone = 'error'; text = `预检未通过：${preview.check.reason}`; }
      else if (dirty && preview?.check) { tone = 'warn'; text = `未应用 · 预检通过 · f ${Math.abs(preview.focalLengthMm).toFixed(2)} mm · 最大 F/${preview.fNumber.toFixed(2)}`; }
      else if (dirty) { tone = 'warn'; text = '未应用的修改 · 正在预检…'; }
      else if (s.prescription) { tone = ''; text = `与渲染一致 · ${s.prescription.surfaces.length} 面 · ${s.prescription.configurationTitle ?? ''}`; }
    }
    refs.benchStatus.textContent = text;
    refs.benchStatus.setAttribute('data-tone', tone || 'idle');
  }
  function renderToolbar() {
    const s = currentState();
    const ready = s.status === 'ready' || s.status === 'error';
    refs.benchInsert.disabled = !draft || Boolean(busy);
    refs.benchDelete.disabled = !draft || draft.rows.length <= 1 || selected === draft.stopIndex || Boolean(busy);
    refs.benchStop.disabled = !draft || selected === draft.stopIndex || Boolean(busy);
    refs.benchUndo.disabled = !history.length || Boolean(busy);
    refs.benchRedo.disabled = !future.length || Boolean(busy);
    refs.benchRevert.disabled = !dirty || Boolean(busy);
    refs.benchExport.disabled = !draft;
    refs.benchApply.disabled = !dirty || !ready || Boolean(busy) || Boolean(preview?.error) || preview?.check?.supported === false;
    refs.benchApply.setAttribute('aria-busy', String(busy === 'apply'));
    refs.benchImport.disabled = !ready || Boolean(busy);
    refs.benchImport.setAttribute('aria-busy', String(busy === 'import'));
  }
  function renderWarnings() {
    const s = currentState();
    const list = [...importWarnings];
    refs.benchWarnings.replaceChildren(...list.map((t) => h('li', { text: t })));
    refs.benchWarnDetails.hidden = list.length === 0;
    refs.benchWarnSummary.textContent = `导入提示 ${list.length} 条`;
    void s;
  }
  function renderLayout() {
    if (!open) return;
    const s = currentState();
    let source = null;
    if (dirty && preview?.layout) source = { layout: preview.layout, focal: preview.focalLengthMm, key: `preview:${previewToken}` };
    else if (!dirty && s.prescription) {
      const key = JSON.stringify([s.prescription.id, s.prescription.configurationTitle, s.prescription.sensorZMm, s.prescription.stopRadiusMm, s.prescription.surfaces.map((x) => x.zMm)]);
      if (key === lastLayoutKey) return;
      const result = layoutFor(s.prescription, s.optics?.focalLengthMm);
      source = result.layout ? { layout: result.layout, focal: s.optics?.focalLengthMm, key } : { error: result.error, key };
    }
    if (!source) return;
    lastLayoutKey = source.key;
    if (source.error) { svg.replaceChildren(); refs.benchLegend.textContent = `无法绘制：${source.error}`; return; }
    drawLayoutSVG(doc, svg, source.layout);
    const L = source.layout;
    const items = L.bundles.map((b) => h('span', { class: `lb-legend-item lb-field-${Math.min(b.fieldIndex, 4)}` },
      h('i', { 'aria-hidden': 'true' }), `${b.fieldDeg.toFixed(1)}°`,
      h('em', { text: b.pupil ? ` [${b.pupil[0].toFixed(2)}, ${b.pupil[1].toFixed(2)}]` : ' 全渐晕' })));
    refs.benchLegend.replaceChildren(...items,
      h('span', { class: 'lb-legend-note', text: `${L.elements.length} 片 · 总长 ${L.totalTrackMm.toFixed(1)} mm${Number.isFinite(source.focal) ? ` · f ${Math.abs(source.focal).toFixed(1)} mm` : ''} · 方括号 = 未渐晕的子午瞳区间 · d 线` }));
  }
  function renderAll() {
    if (!open) return;
    const s = currentState();
    const lens = s.lenses?.find?.((l) => l.id === s.lensId);
    refs.benchSubtitle.textContent = `${lens?.name ?? s.prescription?.name ?? '—'}${s.configurations?.length > 1 ? ` · ${s.configurations.find((c) => c.index === s.configurationIndex)?.title ?? ''}` : ''}${isCustomLensId(s.lensId) ? ' · 导入/编辑' : ''}`;
    if (draft) {
      if (doc.activeElement !== refs.benchName) refs.benchName.value = draft.name;
      if (doc.activeElement !== refs.benchFno) refs.benchFno.value = draft.fno ?? '';
      refs.benchFnoLabel.textContent = draft.apmode === 'epd' ? '入瞳 Ø' : draft.apmode === 'stop' ? '光阑半径' : 'F/#';
    }
    refs.benchName.disabled = !draft; refs.benchFno.disabled = !draft;
    root.setAttribute('data-dirty', String(dirty));
    renderLayout(); renderStatus(); renderToolbar(); renderWarnings();
  }

  function openBench() {
    if (open) return;
    open = true; root.hidden = false; lastLayoutKey = '';
    ensureRecord(); renderTable(); renderAll();
    refs.benchClose.focus?.();
  }
  function close() {
    if (!open) return;
    open = false; root.hidden = true;
    onClose?.();
  }
  return {
    root,
    get isOpen() { return open; },
    get dirty() { return dirty; },
    openBench,
    close,
    toggle() { if (open) close(); else openBench(); },
    render() {
      if (!open) return;
      const s = currentState();
      if (`${s.lensId}|${s.configurationIndex}` !== recordKey && !dirty) { message = { tone: '', text: '' }; ensureRecord(); }
      renderAll();
    },
    dispose() { clearTimeout(previewTimer); previewToken++; },
  };
}
