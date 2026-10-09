// Functional test v2 — transactional paint time tracking + safe workflow
// writes. LIVE functions extracted from INCO_Furniture_v12.src.html, run
// against an in-memory Firestore mock that enforces transaction semantics
// (reads before writes, atomic commit, deep-copied snapshots).
const fs = require('fs');
const SRC = require('path').join(__dirname, '..', 'INCO_Furniture_v12.src.html');
const H = fs.readFileSync(SRC, 'utf8');
function extract(a, b) {
  const s = H.indexOf(a); if (s < 0) throw new Error('marker not found: ' + a);
  const e = H.indexOf(b, s); if (e < 0) throw new Error('end marker not found: ' + b);
  return H.slice(s, e);
}
let code =
  extract('const WF_STAGES = [', '// Current view state') +
  extract('function wfApplicableStages(', '// ─── View switching') +
  extract('function pickTier(', '// 4-tier tenie pricing') +
  extract('function calcBlock(b) {', 'function updateCalcCells(') +
  extract('async function persistOrder(', '// Delete an order:') +
  extract('async function deleteOrderById(', '// ═══════════════════════════════════════════════════════════════\n// KOSHI') +
  extract('async function _wfApplyOrderColumnTransition(', '// ── Detail sidebar') +
  extract('async function wfApplyStageChange(', '// ─── View 3: block workspace (PDF + drawing)');
code = code.replace('window._pt = {', 'var _pt = window._pt = {')
           .replace('window._wk = {', 'var _wk = window._wk = {')
           .replace('const _PT_NET_MS     = 20 * 1000;', 'const _PT_NET_MS = 400;');   // fast offline test

// ── Firestore mock ────────────────────────────────────────────────
const store = {};
let autoId = 0;
const SV_TS = { __sv: 'ts' };
const FieldValue = { serverTimestamp: () => SV_TS, arrayUnion: (...els) => ({ __sv: 'union', els }) };
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function resolveVal(v, prev) {
  if (v === SV_TS) return { __server_ts: true };
  if (v && v.__sv === 'union') return (Array.isArray(prev) ? prev : []).concat(clone(v.els));
  return clone(v);
}
function assertSafe(obj, path, inArray) {
  if (obj === undefined) throw new Error('undefined value at ' + path);
  if (obj === SV_TS) return;
  if (Array.isArray(obj)) {
    if (inArray) throw new Error('nested array at ' + path);
    obj.forEach((x, i) => assertSafe(x, path + '[' + i + ']', true));
  } else if (obj && obj.__sv === 'union') {
    obj.els.forEach((x, i) => assertSafe(x, path + '.union[' + i + ']', true));
  } else if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) assertSafe(obj[k], path + '.' + k, false);
  }
}
function applyUpdate(p, upd) {
  if (!store[p]) throw new Error('NOT_FOUND ' + p);
  for (const k of Object.keys(upd)) store[p][k] = resolveVal(upd[k], store[p][k]);
}
function applySet(p, doc) { const out = {}; for (const k of Object.keys(doc)) out[k] = resolveVal(doc[k]); store[p] = out; }
const db = {
  hang: false, txCount: 0,
  collection(coll) {
    const mkRef = id => ({
      _p: coll + '/' + id, id,
      async get() { return { exists: store[coll + '/' + id] !== undefined, id, data: () => clone(store[coll + '/' + id]) }; },
      async update(upd) { assertSafe(upd, coll + '.update'); applyUpdate(coll + '/' + id, upd); },
      async set(doc) { assertSafe(doc, coll + '.set'); applySet(coll + '/' + id, doc); },
    });
    const query = filters => ({
      where(f, op, v) { return query(filters.concat([[f, op, v]])); },
      async get() {
        const docs = Object.keys(store).filter(k => k.startsWith(coll + '/')).filter(k => filters.every(([f, op, v]) => {
          const val = store[k][f];
          if (op === 'in') { if (v.length > 30) throw new Error('in > 30'); return v.includes(val); }
          if (op === '==') return v === null ? val === null : val === v;
          throw new Error('op ' + op);
        })).map(k => ({ id: k.split('/')[1], data: () => clone(store[k]) }));
        return { docs };
      },
    });
    return Object.assign(query([]), {
      doc(id) { return mkRef(id == null ? 'id' + (++autoId) : String(id)); },
      async add(doc) { assertSafe(doc, coll + '.add'); const id = 'id' + (++autoId); applySet(coll + '/' + id, doc); return { id }; },
    });
  },
  async runTransaction(fn) {
    db.txCount++;
    if (db.hang) return new Promise(() => {});
    const writes = []; let wrote = false;
    const tx = {
      async get(ref) {
        if (wrote) throw new Error('TX: read after write');
        return { exists: store[ref._p] !== undefined, id: ref.id, data: () => clone(store[ref._p]) };
      },
      update(ref, upd) { wrote = true; assertSafe(upd, 'tx.update ' + ref._p); writes.push(() => applyUpdate(ref._p, upd)); return tx; },
      set(ref, doc) { wrote = true; assertSafe(doc, 'tx.set ' + ref._p); writes.push(() => applySet(ref._p, doc)); return tx; },
    };
    const r = await fn(tx);
    writes.forEach(w => w());                // atomic commit
    return r;
  },
  batch() {
    const ops = [];
    return {
      set(ref, d) { ops.push(() => applySet(ref._p, d)); },
      delete(ref) { ops.push(() => { delete store[ref._p]; }); },
      async commit() { ops.forEach(o => o()); },
    };
  },
};

// ── DOM / env mocks ───────────────────────────────────────────────
const els = {};
const el = id => (els[id] = els[id] || { id, style: {}, textContent: '', innerHTML: '', value: '', classList: { toggle() {} } });
const toasts = [];
let confirmAnswer = true;
let partner = false;
const calls = { renderDepartments: 0, moveKb: [] };
const env = {
  db,
  firebase: { firestore: { FieldValue } },
  auth: { currentUser: { email: 'tester@inco.al' } },
  window: { _ROLE: { role: 'admin' } },
  document: { getElementById: el, querySelectorAll: () => [] },
  localStorage: (() => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; })(),
  shellToast: (msg, kind) => toasts.push([kind || '', msg]),
  confirm: () => confirmAnswer,
  console: { log() {}, warn() {}, error() {} },
  escHtml: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  loadKlientet: () => [{ id: 'k1', emri: 'Agron Kurti' }],
  blockHasTenie: () => false,
  blockHasM2: b => b.type === 'mdf' || b.type === 'lis',
  PAINT_CFG: { norma_mbuluese: 8, norma_uji: 10 },
  loadKanbanData: () => ({ 309: { col: 'procesim' } }),
  getOrderKbCol: () => 'procesim',
  moveKbOrderTo: (id, col) => calls.moveKb.push([id, col]),
  persistKanbanForOrder: () => {},
  isPartner: () => partner,
  _summaryOfOrder: o => ({ id: o.id }),
  wfRenderOrderDetail: () => {},
  wfRenderBlockSide: () => {},
  wfBackFromBlock: () => {},
  _wfDeptUpdateCounts: () => {},
  _wfGetBlocksForDept: () => [],
  _wfDeptCardHtml: () => '',
  renderDepartments: () => { calls.renderDepartments++; },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
};
env.window._wfState = { view: 'departments', order: null, blockId: null, readOnly: false };
env.window._wfDept = { orders: [], currentTab: 'saw', loadedAt: 1 };
const F = new Function(...Object.keys(env),
  'var _wfState = window._wfState, _wfDept = window._wfDept; let _ORDERS_CACHE = []; let _KANBAN_CACHE = {};\n' +
  'function _wfIsReadOnly() { return !!_wfState.readOnly; }\n' + code + `
  return { wfEnsureBlockWorkflow, wfPaintSubStatus, calcBlock, _ptSnapshot, _ptStepState, _ptActiveStep,
    ptAction, _ptPickToggle, _ptPickDone, _ptLoadForOrders, _ptSessions, _ptLoadOpenAll, _ptOrphansHtml,
    ptOpenModal, ptRenderModal, ptOpenForm, ptSaveForm, ptDeleteSession, ptCloseModal, ptStopOrphan,
    _ptChipsHtml, _ptControlsHtml, _ptTxStart, _ptCloseOpenSessionsForOrder,
    wkAdd, wkRename, wkToggleActive, _wkActive, _ptToLocalInput,
    wfApplyStageChange, _wfApplyOrderColumnTransition, persistOrder, deleteOrderById,
    getPt: () => _pt, getWk: () => _wk, WF_PAINT_SUBSTAGES };`)(...Object.values(env));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  OK  ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? ' :: ' + x : '')); } };
const tick = () => new Promise(r => setTimeout(r, 0));
const sess = () => Object.keys(store).filter(k => k.startsWith('paint_sessions/')).map(k => Object.assign({ id: k.split('/')[1] }, store[k]));
const lastToast = () => (toasts[toasts.length - 1] || ['', ''])[1];
const dbBlock = (id) => store['porosite/309'].blocks.find(b => b.id === id);
const dbSub = (id, step) => dbBlock(id).workflow.paint.substages[step];
async function startWith(key, idx, step, pickIds) {
  const p = F.ptAction(key, idx, step, 'start');
  for (let i = 0; i < 6 && !F.getPt().pick; i++) await tick();
  if (F.getPt().pick) { for (const id of (pickIds || [])) F._ptPickToggle(id, null); F._ptPickDone(true); }
  await p;
}

(async () => {
  const S = F.WF_PAINT_SUBSTAGES;
  console.log('A. migration');
  const mk = (subs, status) => ({ workflow: { paint: { status: status || 'pending', substages: subs } }, rows: [], type: 'mdf' });
  const d = at => ({ status: 'done', doneAt: at });
  let b = mk({ zmerilim: d(1), pateDora1: d(2), pateDora2: { status: 'pending' } }); F.wfEnsureBlockWorkflow(b);
  ok('v1 pateDora1 → shqeto + coat 1 only', b.workflow.paint.substages.lyerjePaste1.status === 'done' && b.workflow.paint.substages.zmerilimPaste1.status === 'pending');
  b = mk({ zmerilim: d(1), pateDora1: d(2), pateDora2: d(3), lyerje: d(4) }, 'pending'); F.wfEnsureBlockWorkflow(b);
  ok('all 6 done ⇒ paint.status synced to done (no stuck card)', b.workflow.paint.status === 'done' && b.workflow.paint.doneAt === 4);

  // ── fixture: order 309 with two sections; dept cache = stale deep copy
  const blockA = { id: 7, name: 'MDF 18', type: 'mdf', cfg: { lung: 2800, larg: 2070, spes: 18 }, kodiBojes: 'RAL 9010',
    rows: [{ id: 1, l: '600', g: '400', s: '4', anen: '2A', lyerje: true }], panels: [] };
  const blockB = { id: 8, name: 'MDF 25', type: 'mdf', cfg: { lung: 2800, larg: 2070, spes: 25 },
    rows: [{ id: 1, l: '500', g: '300', s: '2', anen: '1A', lyerje: true }], panels: [] };
  store['porosite/309'] = { id: 309, fatura: '105', klient_id: 'k1', data: '2026-10-01', blocks: [clone(blockA), clone(blockB)] };
  store['counters/porosite'] = { next: 310 };
  for (const bb of store['porosite/309'].blocks) F.wfEnsureBlockWorkflow(bb);
  const cache = clone(store['porosite/309']);
  env.window._wfDept.orders = [cache];
  env.window._wfDept.currentTab = 'paint';
  const key = '309';

  console.log('B. workers');
  els['wk-new-name'] = { value: ' Arben  Hoxha ' }; const p1 = F.wkAdd(); const p2 = F.wkAdd(); await Promise.all([p1, p2]);
  ok('double-submit guarded → one worker', F.getWk().list.length === 1);
  els['wk-new-name'] = { value: 'Ilir' }; await F.wkAdd();
  const arben = F.getWk().list.find(w => w.name === 'Arben Hoxha'), ilir = F.getWk().list.find(w => w.name === 'Ilir');
  const inp = { value: 'Ilir Dema' }; await F.wkRename(ilir.id, inp);
  ok('rename persisted in place', store['workers/' + ilir.id].name === 'Ilir Dema' && inp.value === 'Ilir Dema');

  console.log('C. start / lock / pause / resume / finish');
  await startWith(key, 0, 'zmerilimShqeto', [arben.id]);
  let ss = sess();
  ok('interval created', ss.length === 1 && ss[0].endMs === null && ss[0].kind === 'interval');
  ok('cheap report fields stored', ss[0].workerIds[0] === arben.id && ss[0].workerCount === 1 && /^\d{4}-\d\d-\d\d$/.test(ss[0].startDay) &&
     typeof ss[0].tzOffsetMin === 'number' && /^dev-/.test(ss[0].deviceId) && ss[0].m2Total > 0);
  ok('lock taken on order doc', dbSub(7, 'zmerilimShqeto').openSessionId === ss[0].id);
  toasts.length = 0; await startWith(key, 0, 'zmerilimShqeto', [arben.id]);
  ok('second start refused', sess().length === 1 && /tashmë në punë/.test(lastToast()));
  toasts.length = 0; await startWith(key, 0, 'lyerjePaste1', [arben.id]);
  ok('locked next step refused', /mëparshëm/.test(lastToast()));
  await F.ptAction(key, 0, 'zmerilimShqeto', 'pause');
  ok('pause closes + releases lock', sess()[0].endMs != null && sess()[0].endSource === 'pause' && !dbSub(7, 'zmerilimShqeto').openSessionId);
  await startWith(key, 0, 'zmerilimShqeto', []);                       // resume — preselected
  ok('resume reuses last workers', sess().length === 2 && sess()[1].workers[0].id === arben.id);
  await F.ptAction(key, 0, 'zmerilimShqeto', 'finish');
  const sub1 = dbSub(7, 'zmerilimShqeto');
  ok('finish: closed + done + lock released', sess()[1].endSource === 'finish' && sub1.status === 'done' && !sub1.openSessionId);
  ok('finish: doneSource/m2AtDone/workMsAtDone/history', sub1.doneSource === 'timer' && sub1.m2AtDone > 0 && sub1.workMsAtDone >= 0 && sub1.history.length === 1);
  ok('in-memory cache synced from server', cache.blocks[0].workflow.paint.substages.zmerilimShqeto.status === 'done');

  console.log('D. concurrency + stale copies');
  // D1 — the critical one: office edits rows while the tablet's cache is stale.
  store['porosite/309'].blocks[0].rows[0].s = '9';                       // office changed qty
  store['porosite/309'].blocks[1].workflow.saw = { status: 'done', doneAt: 5 };   // saw tablet progress
  await startWith(key, 0, 'lyerjePaste1', [ilir.id]);
  await F.ptAction(key, 0, 'lyerjePaste1', 'finish');
  ok('stale tablet does NOT revert office row edit', store['porosite/309'].blocks[0].rows[0].s === '9');
  ok('stale tablet does NOT revert other device\'s stage', store['porosite/309'].blocks[1].workflow.saw.status === 'done');
  // D2 — wfApplyStageChange from the stale cache must not clobber paint state.
  env.window._wfState.order = cache; env.window._wfState.blockId = 1;
  await F.wfApplyStageChange(1, 'board', null, 'done');
  env.window._wfState.order = null;
  ok('other-dept stage change keeps paint flags + rows', dbSub(7, 'lyerjePaste1').status === 'done' && store['porosite/309'].blocks[0].rows[0].s === '9');
  // D3 — device B starts the same step while A's picker is open.
  const pA = F.ptAction(key, 0, 'zmerilimPaste1', 'start');
  for (let i = 0; i < 6 && !F.getPt().pick; i++) await tick();
  const bDoc = await F._ptTxStart(key, 7, 'zmerilimPaste1', { workers: [{ id: arben.id, name: 'Arben Hoxha' }], source: 'button' });
  F._ptPickToggle(ilir.id, null); F._ptPickDone(true); await pA;
  const openNow = sess().filter(s => s.step === 'zmerilimPaste1' && s.endMs == null);
  ok('race: only ONE running interval (B), A refused', openNow.length === 1 && openNow[0].id === bDoc.id && /tashmë në punë/.test(lastToast()));
  // D4 — stale lock (points at a closed interval) is overridden.
  await F.ptAction(key, 0, 'zmerilimPaste1', 'pause');
  dbSub(7, 'zmerilimPaste1').openSessionId = bDoc.id;                    // stale pointer to a closed interval
  await startWith(key, 0, 'zmerilimPaste1', []);
  ok('stale lock ignored → start works', sess().filter(s => s.step === 'zmerilimPaste1' && s.endMs == null).length === 1);
  await F.ptAction(key, 0, 'zmerilimPaste1', 'pause');
  // D5 — section inserted at index 0 elsewhere: actions still hit the right section by id.
  store['porosite/309'].blocks.unshift({ id: 99, name: 'Melamine', type: 'mel', rows: [], cfg: { spes: 18 } });
  await startWith(key, 0, 'zmerilimPaste1', []);
  ok('structural change: write lands on section id 7', dbSub(7, 'zmerilimPaste1').openSessionId && !store['porosite/309'].blocks[0].workflow);
  ok('dept cache marked stale for reload', env.window._wfDept.loadedAt === 0);
  env.window._wfDept.loadedAt = 1;
  await F.ptAction(key, 0, 'zmerilimPaste1', 'pause');
  store['porosite/309'].blocks.shift();

  console.log('E. manual entries');
  // E1 — untouched re-save keeps millisecond precision (no phantom audit).
  const btn = sess().find(s => s.step === 'zmerilimShqeto' && s.source === 'button' && s.endSource === 'finish');
  await F.ptOpenModal(key, 0, 'zmerilimShqeto');
  F.ptOpenForm('zmerilimShqeto', btn.id);
  els['pt-f-start'] = { value: F._ptToLocalInput(btn.startMs) };
  els['pt-f-end'] = { value: F._ptToLocalInput(btn.endMs) };
  els['pt-f-note'] = { value: 'vetëm shënim' };
  await F.ptSaveForm();
  const btnAfter = store['paint_sessions/' + btn.id];
  ok('note-only edit keeps exact start/end ms', btnAfter.startMs === btn.startMs && btnAfter.endMs === btn.endMs);
  ok('audit records only the note', btnAfter.edits.length === 1 && Object.keys(btnAfter.edits[0].changes).join() === 'note');
  // E2 — switching forms never carries the previous form's inputs.
  F.ptOpenForm('zmerilimShqeto', btn.id);
  els['pt-f-start'] = { value: '2020-01-01T08:00' };                  // typed into form A
  const other = sess().find(s => s.step === 'lyerjePaste1');
  F.ptOpenForm('lyerjePaste1', other.id);                             // switch to form B
  const fB = F.getPt().modal.form;
  ok('form switch starts clean (no draft carry-over)', fB.step === 'lyerjePaste1' && fB.draft === null);
  F.getPt().modal.form = null;
  // E3 — a stale form can never reopen an interval closed elsewhere.
  await startWith(key, 0, 'zmerilimPaste1', []);
  const running = sess().find(s => s.step === 'zmerilimPaste1' && s.endMs == null);
  await F.ptOpenModal(key, 0, 'zmerilimPaste1');
  F.ptOpenForm('zmerilimPaste1', running.id);                         // form shows end = '' (running)
  await F._ptCloseOpenSessionsForOrder(key, 'other-device');           // another device stops it
  els['pt-f-start'] = { value: F._ptToLocalInput(running.startMs) };
  els['pt-f-end'] = { value: '' };
  els['pt-f-note'] = { value: 'shënim' };
  await F.ptSaveForm();
  ok('stale form did not reopen the interval', store['paint_sessions/' + running.id].endMs != null,
     JSON.stringify(store['paint_sessions/' + running.id].edits) + ' / ' + lastToast());
  ok('…but its note edit was saved', store['paint_sessions/' + running.id].note === 'shënim');
  ok('lock not re-taken by the stale form', dbSub(7, 'zmerilimPaste1').openSessionId !== running.id ||
     store['paint_sessions/' + running.id].endMs != null);
  // (close-all also left the lock dangling on purpose → stale-lock path heals it)
  // E4 — locked step: existing interval end can be corrected.
  await F.ptAction(key, 0, 'lyerjePaste1', 'revert');                  // blocked: next step has time
  ok('revert blocked when next step has time', /kohë të regjistruar/.test(lastToast()));
  // E5 — overlap + delete releases lock
  await F.ptOpenModal(key, 0, 'zmerilimPaste1');
  F.ptOpenForm('zmerilimPaste1');
  els['pt-f-start'] = { value: F._ptToLocalInput(running.startMs) }; els['pt-f-end'] = { value: F._ptToLocalInput(running.startMs + 60000) };
  els['pt-f-note'] = { value: '' };
  toasts.length = 0; await F.ptSaveForm();
  ok('overlap refused', /Mbivendoset/.test(lastToast()));
  F.getPt().modal.form = null;
  await startWith(key, 0, 'zmerilimPaste1', []);
  const toDel = sess().find(s => s.step === 'zmerilimPaste1' && s.endMs == null);
  await F.ptOpenModal(key, 0, 'zmerilimPaste1');
  await F.ptDeleteSession(toDel.id);
  ok('delete: soft + audited + lock released', store['paint_sessions/' + toDel.id].deleted === true &&
     store['paint_sessions/' + toDel.id].edits.length === 1 && dbSub(7, 'zmerilimPaste1').openSessionId == null,
     JSON.stringify({ id: toDel.id, d: store['paint_sessions/' + toDel.id].deleted, e: (store['paint_sessions/' + toDel.id].edits || []).length,
                      lock: dbSub(7, 'zmerilimPaste1').openSessionId, toast: lastToast() }));
  F.ptCloseModal(true);

  console.log('F. kanban / delete / editor');
  await startWith(key, 0, 'zmerilimPaste1', []);
  await F._wfApplyOrderColumnTransition(309, 'procesim');
  ok('reset move closes timers + clears locks', sess().every(s => s.deleted || s.endMs != null) &&
     S.every(k => !dbSub(7, k).openSessionId));
  // editor save with a stale workflow keeps the server's, newer designs win
  const svDone = JSON.parse(JSON.stringify(store['porosite/309']));
  svDone.blocks[0].workflow.paint.substages.zmerilimShqeto = { status: 'done', doneAt: 1 };
  store['porosite/309'] = svDone;
  const editorOrder = JSON.parse(JSON.stringify(svDone));
  editorOrder.blocks[0].workflow.paint.substages.zmerilimShqeto = { status: 'pending' };       // stale editor copy
  editorOrder.blocks[0].workflow.cnc = { status: 'pending', designs: [{ id: 'd1', updatedAt: 9e12, pages: [] }] };
  editorOrder.blocks[0].rows[0].s = '11';
  await F.persistOrder(editorOrder);
  ok('editor save keeps server step flags', dbSub(7, 'zmerilimShqeto').status === 'done');
  ok('editor save keeps its newer CNC drawing + row edit', dbBlock(7).workflow.cnc.designs[0].updatedAt === 9e12 && dbBlock(7).rows[0].s === '11');
  // delete: no counter rewind, timers closed
  await startWith(key, 0, 'zmerilimShqeto', []).catch(() => {});
  store['porosite/400'] = { id: 400, blocks: [] };
  store['counters/porosite'] = { next: 401 };
  store['paint_sessions/zz'] = { orderKey: '400', blockId: 1, step: 'lyerjeBoje', startMs: Date.now() - 1000, endMs: null, deleted: false };
  await F.deleteOrderById(400);
  ok('delete: id counter NOT rewound', store['counters/porosite'].next === 401);
  ok('delete: running timer of the order closed', store['paint_sessions/zz'].endMs != null && store['paint_sessions/zz'].endSource === 'order-deleted');

  console.log('G. stray-timer banner, read-only, offline, escaping');
  store['paint_sessions/orph'] = { orderKey: '309', blockId: 7, step: 'zmerilimShqeto', stepLabel: 'Zmerilim shqeto', subLabel: '#105-1',
    klientEmri: 'Agron', workers: [{ id: 'w', name: 'O\'Brien "X"' }], startMs: Date.now() - 5000, endMs: null, deleted: false };
  await F._ptLoadOpenAll();
  const banner = F._ptOrphansHtml([]);
  ok('banner lists the stray timer', /#105-1/.test(banner) && /■ Ndalo/.test(banner));
  ok('worker name with quotes escaped in banner', banner.includes('O&#39;Brien &quot;X&quot;') && !banner.includes('"X"'));
  confirmAnswer = true;
  await F.ptStopOrphan('orph');
  ok('stray timer stopped', store['paint_sessions/orph'].endSource === 'stray-stop');
  partner = true; toasts.length = 0;
  await F.ptAction(key, 0, 'zmerilimShqeto', 'start');
  ok('partner cannot drive timers', /vetëm-leximi/.test(lastToast()));
  const ctl = F._ptControlsHtml(cache, 0);
  ok('partner sees no buttons', !/ptAction/.test(ctl));
  partner = false;
  const activeStep = S.find(k => F._ptStepState(cache, 0, k).base === 'pending');
  db.hang = true; toasts.length = 0;
  const t0 = Date.now();
  await F.ptAction(key, 0, activeStep, 'finish');
  db.hang = false;
  ok('offline: fails fast with a message, busy released', Date.now() - t0 < 3000 && /lidhje/.test(lastToast()) && F.getPt().busy === false,
     JSON.stringify({ ms: Date.now() - t0, toasts, busy: F.getPt().busy, sub: dbSub(7, 'zmerilimPaste1') && dbSub(7, 'zmerilimPaste1').status }));
  store['paint_sessions/x"y'] = { orderKey: '309', blockId: 7, step: 'zmerilimShqeto', startMs: 1, endMs: 2, deleted: false, workers: [] };
  await F._ptLoadForOrders(['309']);
  await F.ptOpenModal(key, 0, 'zmerilimShqeto');
  const mb = els['pt-modal-body'].innerHTML;
  ok('crafted id cannot break out of onclick', mb.includes('ptDeleteSession(&quot;x\\&quot;y&quot;)') || mb.includes('ptDeleteSession(&quot;x\\"y&quot;)') === false);
  ok('modal: no undefined/NaN', !/undefined|NaN/.test(mb + els['pt-modal-summary'].innerHTML));
  ok('chips: 6 rendered', (F._ptChipsHtml(cache, 0).match(/class="pt-chip /g) || []).length === 6);
  F.ptCloseModal(true);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES: ' + fail} (${pass} ok)  — transactions: ${db.txCount}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR:', e && e.stack || e); process.exit(1); });
