// Inner-trim safety regression (Erion Gjokeja/125 panel-2 short-cut bug).
// MIN_INNER_TRIM was 5, which let the optimizer place a 443-tall piece in a
// 448-tall sub-strip with a 5mm head-trim (5+443=448, zero slack). The shop
// saw trims ~10mm, so those pieces came out ~5mm short. Fix: MIN_INNER_TRIM
// raised to 10 (matches the saw's real minimum), so no piece is ever placed
// in a sub-strip that needs a sub-10mm trim.
//
// NB: the change is in v2_strip_packer.js, which the baseline copy also
// loads — so an A/B against _baseline_index.js can't isolate it. Instead we
// (a) unit-test the offcut fitter directly (the production file is the proof
// the OLD code produced ru=5) and (b) scan a full optimize for any sub-10
// inner trim.
const Module = require('module');
const stub = require('./lib/_v2_stub');
const origReq = Module.prototype.require;
Module.prototype.require = function (name) {
  if (name === 'firebase-functions/v2/https') return stub.https;
  if (name === 'firebase-functions/v2') return { setGlobalOptions: () => {} };
  return origReq.apply(this, arguments);
};
const newImpl = require('./index.js');
const v2 = require('./lib/v2packer');
Module.prototype.require = origReq;
const sim = require('./lib/saw-simulator');

const MIN_SAFE = 10;
let fail = 0;
const ok = (cond, msg) => { console.log((cond ? '  OK  ' : '  FAIL ') + msg); if (!cond) fail++; };

// ── Unit: the offcut fitter must never trim below MIN_SAFE ────────────
// fitYStripOffcuts(rem, offcutL, stripH, kerf, trimSub) → [{xPw, ru, uCuts}]
const mkRem = (w, h) => [{ id: 1, w, h, rem: 1, total: 1, grainLock: false }];

// (A) 443 in a 448 strip, default trim 10: 443+10=453 > 448 → MUST NOT fit
//     (the exact incident geometry). Old code slipped it in at ru=5.
{
  const rem = mkRem(755, 443);
  const offs = v2.fitYStripOffcuts(rem, 800, 448, 4.4, 10);
  const sub10 = offs.filter(o => (o.ru || 0) < MIN_SAFE);
  ok(sub10.length === 0, `443-in-448: no sub-${MIN_SAFE} trim emitted (got ${offs.map(o=>o.ru).join(',')||'none'})`);
  ok(rem[0].rem === 1, '443-in-448: piece correctly left unplaced (needs a taller strip)');
}
// (B) 438 in a 448 strip: 438+10=448 → fits at exactly the safe 10mm trim.
{
  const rem = mkRem(755, 438);
  const offs = v2.fitYStripOffcuts(rem, 800, 448, 4.4, 10);
  ok(offs.length === 1 && offs[0].ru === 10 && offs[0].uCuts[0].uPh === 438,
     `438-in-448: placed at exactly ru=10 (${offs.length ? offs[0].ru : 'unplaced'})`);
}
// (C) 400 in a 448 strip: comfortable → default trim, still >= safe.
{
  const rem = mkRem(755, 400);
  const offs = v2.fitYStripOffcuts(rem, 800, 448, 4.4, 10);
  ok(offs.length === 1 && offs[0].ru >= MIN_SAFE,
     `400-in-448: placed with trim >= ${MIN_SAFE} (${offs.length ? offs[0].ru : 'unplaced'})`);
}

// ── Integration: full optimize on panel 2's 17-piece set ─────────────
const raw = [];
const add = (w, h, n) => { for (let i = 0; i < n; i++) raw.push({ w, h }); };
add(448, 182, 4); add(700, 403, 2); add(2100, 448, 3);
add(755, 443, 2); add(797, 348, 1); add(797, 443, 2);
add(797, 448, 2); add(466, 443, 1);
const input = { panelL: 3660, panelW: 1830, panelT: 18, kerf: 4.4,
                trimX: 10, trimY: 10, supplier: 'Test', cutDir: 'auto', raw };

(async () => {
  const r = await newImpl._test.runOptimizerCore(input);
  let minRu = Infinity, zeroSlackSub10 = 0;
  for (const p of r.panels) {
    for (const st of p.strips) {
      if (p.mode === 'Y') {
        const offs = Array.isArray(st.offcuts) ? st.offcuts
          : st.offcut ? [{ ru: st.offcut.ru, uCuts: [{ uPh: st.offcut.uPh, uQty: st.offcut.uQty }] }] : [];
        for (const oc of offs) {
          if (typeof oc.ru === 'number') minRu = Math.min(minRu, oc.ru);
          const stackH = (oc.ru || 0) + oc.uCuts.reduce((s, u) => s + u.uQty * u.uPh, 0) +
            Math.max(0, oc.uCuts.reduce((s, u) => s + u.uQty, 0) - 1) * input.kerf;
          if (Math.abs(stackH - st.stripH) < 1 && (oc.ru || 0) < MIN_SAFE) zeroSlackSub10++;
        }
      } else {
        for (const vb of (st.vBars || [])) if (typeof vb.ru === 'number') minRu = Math.min(minRu, vb.ru);
      }
    }
  }
  const placed = r.panels.reduce((s, p) => s + p.placedCount, 0);
  let geom = true;
  for (const p of r.panels) {
    const pieces = sim.simulateSaw(p.strips, p.mode, input.panelL, input.panelW, input.kerf, 10, 10);
    if (!sim.verifyBounds(pieces, input.panelL, input.panelW).ok) geom = false;
    if (!sim.verifyNoOverlap(pieces).ok) geom = false;
  }
  console.log(`\n17-piece optimize: panels=${r.panels.length} placed=${placed}/17 ` +
              `minInnerTrim=${minRu === Infinity ? 'n/a' : minRu} zeroSlackSub10=${zeroSlackSub10}`);
  ok(minRu === Infinity || minRu >= MIN_SAFE, `every inner trim >= ${MIN_SAFE}`);
  ok(zeroSlackSub10 === 0, 'no zero-slack sub-10 cut anywhere');
  ok(placed === 17, `all 17 pieces placed (${placed})`);
  ok(geom, 'geometry valid (bounds + overlap)');

  console.log(fail ? `\n${fail} FAILURE(S)` : '\nPASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(1); });
