/**
 * Minimal DOM for UI tests: just the subset src/ui/lens-ui-core.js uses
 * (elements, attributes, bubbling events, select/option values, simple selectors).
 */
const BOOLEAN_PROPS = ['hidden', 'disabled'];

class FakeNode {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; this.listeners = new Map(); }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes.at(-1) || null; }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); if (value !== '' && value != null) this.appendChild(this.ownerDocument.createTextNode(String(value))); }
  appendChild(node) {
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  append(...nodes) { for (const node of nodes) this.appendChild(typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node); }
  removeChild(node) { this.childNodes = this.childNodes.filter((n) => n !== node); node.parentNode = null; return node; }
  replaceChildren(...nodes) { for (const node of [...this.childNodes]) this.removeChild(node); this.append(...nodes); }
  remove() { this.parentNode?.removeChild(this); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  listenerCount() { let n = 0; for (const set of this.listeners.values()) n += set.size; return n; }
  dispatchEvent(event) {
    event.target ??= this;
    const bubbles = event.bubbles !== false;
    for (let node = this; node; node = bubbles ? node.parentNode : null) {
      event.currentTarget = node;
      for (const fn of [...(node.listeners.get(event.type) || [])]) fn.call(node, event);
      if (event.propagationStopped) break;
    }
    return !event.defaultPrevented;
  }
  *descendants() { for (const child of this.childNodes) { if (child.nodeType === 1) { yield child; yield* child.descendants(); } } }
  querySelectorAll(selector) { return [...this.descendants()].filter((el) => matches(el, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class FakeText extends FakeNode {
  constructor(doc, text) { super(doc); this.nodeType = 3; this.data = text; }
  get textContent() { return this.data; }
  set textContent(value) { this.data = String(value); }
}

class FakeElement extends FakeNode {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.style = { props: {}, setProperty(k, v) { this.props[k] = v; }, getPropertyValue(k) { return this.props[k] ?? ''; } };
    this._value = undefined;
    this._checked = undefined;
    this._selected = undefined;
    const self = this;
    this.classList = {
      add: (...names) => { const set = self._classes(); names.forEach((n) => set.add(n)); self._setClasses(set); },
      remove: (...names) => { const set = self._classes(); names.forEach((n) => set.delete(n)); self._setClasses(set); },
      toggle: (name, force) => { const set = self._classes(); const on = force ?? !set.has(name); if (on) set.add(name); else set.delete(name); self._setClasses(set); return on; },
      contains: (name) => self._classes().has(name),
    };
  }
  _classes() { return new Set((this.getAttribute('class') || '').split(/\s+/).filter(Boolean)); }
  _setClasses(set) { this.setAttribute('class', [...set].join(' ')); }
  get className() { return this.getAttribute('class') || ''; }
  set className(value) { this.setAttribute('class', value); }
  get id() { return this.getAttribute('id') || ''; }
  get type() { return this.getAttribute('type') || (this.tagName === 'INPUT' ? 'text' : ''); }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return node === this.ownerDocument; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  get dataset() { return Object.fromEntries([...this.attributes].filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase()), v])); }

  get checked() { return this._checked ?? this.hasAttribute('checked'); }
  set checked(value) {
    this._checked = Boolean(value);
    if (value && this.type === 'radio') {
      const name = this.getAttribute('name');
      let top = this;
      while (top.parentNode) top = top.parentNode;
      for (const other of top.querySelectorAll(`input[name="${name}"]`)) if (other !== this) other._checked = false;
    }
  }
  get selected() { return this._selected ?? this.hasAttribute('selected'); }
  set selected(value) { this._selected = Boolean(value); }
  get options() { return this.querySelectorAll('option'); }
  get value() {
    if (this.tagName === 'SELECT') {
      const options = this.options;
      const chosen = options.find((o) => o.selected) || options.find((o) => !o.disabled) || options[0];
      return chosen ? chosen.value : '';
    }
    if (this.tagName === 'OPTION') return this.getAttribute('value') ?? this.textContent;
    return this._value ?? this.getAttribute('value') ?? '';
  }
  set value(value) {
    if (this.tagName === 'SELECT') {
      let found = false;
      for (const o of this.options) { o.selected = !found && o.value === String(value); found ||= o.selected; }
      return;
    }
    this._value = String(value);
  }
  focus() {
    const doc = this.ownerDocument;
    if (doc.activeElement === this) return;
    doc.activeElement?.blur?.();
    doc.activeElement = this;
    this.dispatchEvent(new FakeEvent('focus', { bubbles: false }));
  }
  blur() {
    const doc = this.ownerDocument;
    if (doc.activeElement !== this) return;
    doc.activeElement = doc.body;
    this.dispatchEvent(new FakeEvent('blur', { bubbles: false }));
  }
  click() { if (!this.disabled) this.dispatchEvent(new FakeEvent('click')); }
}
for (const prop of BOOLEAN_PROPS) {
  Object.defineProperty(FakeElement.prototype, prop, {
    get() { return this.hasAttribute(prop); },
    set(value) { if (value) this.setAttribute(prop, ''); else this.removeAttribute(prop); },
  });
}
for (const prop of ['min', 'max', 'step', 'placeholder', 'name']) {
  Object.defineProperty(FakeElement.prototype, prop, {
    get() { return this.getAttribute(prop) ?? ''; },
    set(value) { this.setAttribute(prop, value); },
  });
}

export class FakeEvent {
  constructor(type, init = {}) { this.type = type; Object.assign(this, { bubbles: true, defaultPrevented: false }, init); }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
}

function matches(el, selector) {
  const m = /^([a-z0-9]*)((?:\[[^\]]+\])*)$/i.exec(selector.trim());
  if (!m) throw new Error(`fake DOM: unsupported selector ${selector}`);
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const [, name, , value] of m[2].matchAll(/\[([\w-]+)(="([^"]*)")?\]/g)) {
    if (value === undefined ? !el.hasAttribute(name) : (name === 'type' ? el.type : el.getAttribute(name)) !== value) return false;
  }
  return true;
}

export function createFakeDocument({ narrow = false } = {}) {
  const doc = new FakeNode(null);
  doc.ownerDocument = doc;
  doc.nodeType = 9;
  doc.createElement = (tag) => new FakeElement(doc, tag);
  doc.createTextNode = (text) => new FakeText(doc, String(text));
  const html = doc.createElement('html');
  doc.appendChild(html);
  doc.body = doc.createElement('body');
  html.appendChild(doc.body);
  doc.activeElement = doc.body;
  const viewport = { narrow };
  const queries = [];
  doc.defaultView = {
    matchMedia(query) {
      const listeners = new Set();
      const mql = {
        media: query,
        get matches() { return viewport.narrow && /max-width/.test(query); },
        addEventListener(type, fn) { if (type === 'change') listeners.add(fn); },
        removeEventListener(type, fn) { if (type === 'change') listeners.delete(fn); },
        listenerCount: () => listeners.size,
      };
      mql.fire = () => { for (const fn of [...listeners]) fn({ matches: mql.matches, media: query }); };
      queries.push(mql);
      return mql;
    },
  };
  /** Simulate a live resize across the 700 px breakpoint. */
  doc.setNarrow = (next) => { viewport.narrow = next; for (const mql of queries) mql.fire(); };
  doc.mediaListenerCount = () => queries.reduce((n, mql) => n + mql.listenerCount(), 0);
  return doc;
}

/** Fire the event sequence a person produces for a value edit. */
export function input(el, value) {
  el.focus();
  el.value = value;
  el.dispatchEvent(new FakeEvent('input'));
  el.dispatchEvent(new FakeEvent('change'));
}
export function toggle(el, checked = !el.checked) {
  el.checked = checked;
  el.dispatchEvent(new FakeEvent('change'));
}
export function key(target, keyName, init = {}) {
  const event = new FakeEvent('keydown', { key: keyName, ...init });
  target.dispatchEvent(event);
  return event;
}
