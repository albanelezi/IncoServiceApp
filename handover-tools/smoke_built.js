// Load-time smoke test of the BUILT page: run every inline <script> in a VM
// whose missing globals are absorbing stubs. Catches top-level runtime
// errors (TDZ, bad top-level calls) that a syntax-only minify pass misses.
const fs = require('fs'), vm = require('vm');
const html = fs.readFileSync(process.argv[2], 'utf8');
const scripts = [...html.matchAll(/^\s*<script(?![^>]*\b(?:src|type)=)[^>]*>([\s\S]*?)<\/script>/gim)].map(m => m[1]).filter(s => s.trim());
function stub(name) {
  const f = function () { return stub(name + '()'); };
  return new Proxy(f, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === Symbol.iterator) return function* () {};
      if (k === 'then') return undefined;
      if (k === 'length') return 0;
      if (k in t && k !== 'name') return t[k];
      return stub(name + '.' + String(k));
    },
    set() { return true; },
    apply() { return stub(name + '()'); },
    construct() { return stub('new ' + name); },
  });
}
const errors = [];
const base = {
  console: { log() {}, info() {}, warn() {}, debug() {}, error: (...a) => errors.push('console.error: ' + a.map(String).join(' ')) },
  setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0,
  Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, Map, Set, WeakMap, RegExp, Error, Symbol, Proxy, Reflect,
  parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, Intl, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder,
};
const g = new Proxy(base, {
  get(t, k) { if (k in t) return t[k]; if (typeof k === 'symbol') return undefined; return (t[k] = stub(String(k))); },
  has() { return true; },
});
base.window = g; base.self = g; base.globalThis = g;
const ctx = vm.createContext(g);
scripts.forEach((s, i) => {
  try { vm.runInContext(s, ctx, { filename: 'inline-' + i + '.js' }); }
  catch (e) { errors.push(`script ${i} (${s.length} chars): ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); }
});
const need = ['ptAction', 'ptOpenModal', 'ptSaveForm', 'ptDeleteSession', 'wkAdd', 'wkRename', 'wkToggleActive',
  'renderWorkersList', 'wfApplyStageChange', 'persistOrder', 'deleteOrderById', 'setCfgTab', 'wfStageAction', 'ptStopOrphan', 'ptCloseModal'];
const missing = need.filter(n => { try { return typeof vm.runInContext(n, ctx) !== 'function'; } catch (_) { return true; } });
const ids = ['pt-modal', 'pt-workers-modal', 'cfg-workers-pane', 'cfg-tab-count-workers'].filter(id => !html.includes(`id="${id}"`));
console.log(`scripts run: ${scripts.length}`);
console.log(errors.length ? 'ERRORS:\n  ' + errors.join('\n  ') : 'no load-time errors');
console.log(missing.length ? 'MISSING FUNCTIONS: ' + missing.join(', ') : 'all key functions defined');
console.log(ids.length ? 'MISSING ELEMENTS: ' + ids.join(', ') : 'all key elements present');
process.exit(errors.length || missing.length || ids.length ? 1 : 0);
