// CSP-safe bindings for rendered HTML. Action names select fixed, external
// callbacks; arguments are JSON data and are never interpreted as JavaScript.
const UIEvents = (() => {
  const actions = new Map();
  const listeners = new WeakMap();
  const events = ['click', 'change', 'input', 'submit', 'keydown', 'keyup', 'focus', 'blur',
    'mousedown', 'mouseup', 'mouseover', 'mouseout', 'load', 'error', 'dragstart', 'dragover', 'drop', 'dragend', 'toggle'];
  const selector = events.map(type => '[data-ui-' + type + ']').join(',');
  const escapeAttribute = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
  // Legacy numeric handler arguments were parsed as JS literals. Preserve
  // numeric IDs returned as strings by PostgreSQL without evaluating strings.
  function value(input) {
    if (typeof input !== 'string') return input;
    if (input === 'null') return null;
    if (input === 'true') return true;
    if (input === 'false') return false;
    return /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(input) ? Number(input) : input;
  }
  function attrs(type, action, args = []) {
    if (!events.includes(type) || !/^[a-zA-Z0-9._-]+$/.test(action)) throw new Error('Invalid UI binding');
    return 'data-ui-' + type + '="' + action + '" data-ui-' + type + '-args="' + escapeAttribute(JSON.stringify(args)) + '"';
  }
  function bindElement(element) {
    if (!element || typeof element.hasAttribute !== 'function') return;
    let bound = listeners.get(element);
    if (!bound) { bound = new Set(); listeners.set(element, bound); }
    for (const type of events) {
      if (!element.hasAttribute('data-ui-' + type) || bound.has(type)) continue;
      bound.add(type);
      element.addEventListener(type, function (event) {
        const action = actions.get(this.getAttribute('data-ui-' + type));
        if (!action) return;
        let args;
        try { args = JSON.parse(this.getAttribute('data-ui-' + type + '-args') || '[]'); }
        catch (_) { return; }
        if (!Array.isArray(args)) return;
        if (action.call(this, event, args) === false) event.preventDefault();
      });
    }
  }
  function bind(root) {
    bindElement(root);
    if (root && typeof root.querySelectorAll === 'function') root.querySelectorAll(selector).forEach(bindElement);
  }
  function register(entries) {
    for (const [name, callback] of Object.entries(entries)) {
      if (typeof callback !== 'function' || actions.has(name)) throw new Error('Invalid or duplicate UI action');
      actions.set(name, callback);
    }
  }
  if (typeof document !== 'undefined') {
    // Capture installs real target listeners before a synchronous .click() on
    // freshly inserted HTML, without moving handler execution to capture phase.
    for (const type of events) document.addEventListener(type, event => {
      for (const element of event.composedPath()) bindElement(element);
    }, true);
    document.addEventListener('DOMContentLoaded', () => bind(document));
    if (typeof MutationObserver !== 'undefined') new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') bindElement(record.target);
        else for (const node of record.addedNodes) bind(node);
      }
    }).observe(document, { childList: true, subtree: true, attributes: true,
      attributeFilter: events.map(type => 'data-ui-' + type) });
    bind(document);
  }
  return Object.freeze({ attrs, value, register, bind });
})();
if (typeof module !== 'undefined' && module.exports) module.exports = UIEvents;
