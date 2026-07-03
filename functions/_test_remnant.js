// Remnant-consolidation A/B test: baseline vs new comparator on the real
// Joti/Kom job (CUTLST00 (1).txt — 26 pieces, 1 panel @ ~54% fill, sprawling
// 2×764-strip layout with scattered waste).
//
// Asserts (both engines): 1 panel, all 26 pieces placed, geometry valid
// (saw-sim bounds + overlap + dims-multiset match vs input).
// Reports: used stacking extent + contiguous remnant band, old vs new.
const Module = require('module');
const stub = require('./lib/_v2_stub');
const origReq = Module.prototype.require;
Module.prototype.require = function (name) {
  if (name === 'firebase-functions/v2/https') return stub.https;
  if (name === 'firebase-functions/v2') return { setGlobalOptions: () => {} };
  return origReq.apply(this, arguments);
};
const baseImpl = require('./_baseline_index.js');
const newImpl  = require('./index.js');
Module.prototype.require = origReq;
const sim = require('./lib/saw-simulator');

const raw = [];
const add = (w, h, n) => { for (let i = 0; i < n; i++) raw.push({ w, h }); };
add(780, 500, 3);
add(679, 364, 1);
add(364, 80,  2);
add(364, 481, 1);
add(364, 65,  2);
add(200, 396, 1);
add(440, 120, 6);
add(316, 100, 3);
add(252, 396, 2);
add(200, 500, 1);
add(764, 80,  2);
add(764, 500, 1);
add(1200, 525, 1);
if (raw.length !== 26) { console.error('BAD FIXTURE: ' + raw.length); process.exit(1); }

const input = {
  panelL: 3660, panelW: 1830, panelT: 18,
  kerf: 4.4, trimX: 10, trimY: 10,
  supplier: 'Test', cutDir: 'auto', raw,
};
const KERF = 4.4, TRIM = 10;

function usedExtent(panel) {
  const s = panel.strips;
  if (!s || !s.length) return 0;
  if (panel.mode === 'Y') return s.reduce((a, st) => a + st.stripH, 0) + (s.length - 1) * KERF;
  return s.reduce((a, st) => a + st.stripW, 0) + (s.length - 1) * KERF;
}

function verify(tag, result) {
  const panels = result.panels;
  const placed = panels.reduce((s, p) => s + p.placedCount, 0);
  let geomOk = true;
  const simPieces = [];
  for (const p of panels) {
    const pieces = sim.simulateSaw(p.strips, p.mode, input.panelL, input.panelW, KERF, TRIM, TRIM);
    simPieces.push(...pieces);
    const b = sim.verifyBounds(pieces, input.panelL, input.panelW);
    const o = sim.verifyNoOverlap(pieces);
    if (!b.ok || !o.ok) { geomOk = false; console.error(`  [${tag}] GEOMETRY FAIL bounds=${b.ok} overlap=${o.ok}`); }
  }
  // Dims multiset match vs input (rotation-agnostic).
  const key = (w, h) => (w <= h ? `${w}x${h}` : `${h}x${w}`);
  const want = new Map();
  for (const p of raw) want.set(key(p.w, p.h), (want.get(key(p.w, p.h)) || 0) + 1);
  for (const p of simPieces) {
    const k = key(Math.round(p.w * 10) / 10, Math.round(p.h * 10) / 10);
    if (!want.has(k) || want.get(k) === 0) { geomOk = false; console.error(`  [${tag}] EXTRA PIECE ${k}`); }
    else want.set(k, want.get(k) - 1);
  }
  for (const [k, v] of want) if (v > 0) { geomOk = false; console.error(`  [${tag}] MISSING ${v}× ${k}`); }

  const ext = panels.map(usedExtent);
  const bands = panels.map((p, i) => {
    const avail = p.mode === 'Y' ? input.panelW - 2 * TRIM : input.panelL - 2 * TRIM;
    const leftover = Math.max(0, avail - ext[i]);
    const other = p.mode === 'Y' ? input.panelL : input.panelW;
    return { mode: p.mode, extent: ext[i], leftover, bandM2: leftover * other / 1e6 };
  });
  console.log(`  [${tag}] panels=${panels.length} placed=${placed}/26 geom=${geomOk ? 'OK' : 'FAIL'}`);
  bands.forEach((b, i) => console.log(
    `  [${tag}] panel ${i + 1}: mode=${b.mode} strips extent=${b.extent.toFixed(1)}mm ` +
    `→ contiguous remnant band ${b.leftover.toFixed(1)}mm (${b.bandM2.toFixed(3)} m²)`));
  return { panels: panels.length, placed, geomOk, band: bands[0] ? bands[0].bandM2 : 0 };
}

(async () => {
  console.log('=== BASELINE ===');
  const rb = verify('base', await baseImpl._test.runOptimizerCore(input));
  console.log('=== NEW ===');
  const rn = verify('new', await newImpl._test.runOptimizerCore(input));

  let fail = 0;
  if (rn.panels > rb.panels) { console.error('REGRESSION: more panels'); fail = 1; }
  if (rn.placed !== 26 || rb.placed !== 26) { console.error('REGRESSION: pieces not placed'); fail = 1; }
  if (!rn.geomOk || !rb.geomOk) { console.error('GEOMETRY FAILURE'); fail = 1; }
  console.log(`\nRemnant band: ${rb.band.toFixed(3)} m² → ${rn.band.toFixed(3)} m² ` +
              `(${rn.band > rb.band ? '+' : ''}${(rn.band - rb.band).toFixed(3)} m²)`);
  if (rn.band < rb.band - 0.001) { console.error('REMNANT REGRESSION'); fail = 1; }
  console.log(fail ? '\nFAIL' : '\nPASS');
  process.exit(fail);
})().catch(e => { console.error(e.stack); process.exit(1); });
