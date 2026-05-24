// Comprehensive verification: for every panel produced by my pipeline
// across all 6 parity tests + the big 200p input, simulate the saw cuts
// and verify the resulting pieces match the panel's intended consumption.
//
// This is the main safety check before deployment.

const Module = require('module');
const stub = require('./lib/_v2_stub');
const origReq = Module.prototype.require;
Module.prototype.require = function(name) {
  if (name === 'firebase-functions/v2/https') return stub.https;
  if (name === 'firebase-functions/v2') return { setGlobalOptions: () => {} };
  return origReq.apply(this, arguments);
};
const newImpl = require('./index.js');
Module.prototype.require = origReq;

const sim = require('./lib/saw-simulator');
const v2pkg = require('./lib/v2packer');

const inputs = [
  { name: 'Test 1', input: { panelL: 2800, panelW: 1750, panelT: 18, kerf: 4.4, trimX: 15, trimY: 15, supplier: 'Test', cutDir: 'auto',
    raw: [{w:1040,h:422},{w:860,h:422},{w:532,h:422}] } },
  { name: 'Test 2', input: { panelL: 2800, panelW: 2072, panelT: 18, kerf: 4.4, trimX: 15, trimY: 15, supplier: 'Test', cutDir: 'auto',
    raw: Array.from({length:50}, () => ({w:600,h:400})) } },
  { name: 'Test 3', input: { panelL: 2800, panelW: 2070, panelT: 18, kerf: 4.4, trimX: 15, trimY: 15, supplier: 'Test', cutDir: 'auto',
    raw: [
      ...Array.from({length:8},  ()=>({w:800,h:600})),
      ...Array.from({length:12}, ()=>({w:600,h:400})),
      ...Array.from({length:20}, ()=>({w:400,h:300})),
      ...Array.from({length:30}, ()=>({w:300,h:200})),
    ] } },
  { name: 'Test 4', input: { panelL: 2800, panelW: 2070, panelT: 18, kerf: 4.4, trimX: 15, trimY: 15, supplier: 'Test', cutDir: 'auto',
    raw: [
      ...Array.from({length:4},  ()=>({w:2500,h:500})),
      ...Array.from({length:6},  ()=>({w:2500,h:300})),
      ...Array.from({length:20}, ()=>({w:200, h:200})),
    ] } },
  { name: 'Test 5', input: { panelL: 2800, panelW: 1750, panelT: 18, kerf: 4.4, trimX: 15, trimY: 15, supplier: 'Test', cutDir: 'auto',
    raw: [
      ...Array.from({length:24}, ()=>({w:1040, h:422})),
      ...Array.from({length:32}, ()=>({w:860,  h:422})),
      ...Array.from({length:44}, ()=>({w:532,  h:422})),
    ] } },
  { name: 'Test 6', input: { panelL: 3660, panelW: 1830, panelT: 18, kerf: 4.4, trimX: 15, trimY: 15, supplier: 'Test', cutDir: 'auto',
    raw: [
      ...Array.from({length:4},  ()=>({w:1700, h:1005})),
      ...Array.from({length:6},  ()=>({w:1251, h:1006})),
      ...Array.from({length:1},  ()=>({w:1706, h:418})),
      ...Array.from({length:10}, ()=>({w:896,  h:458})),
      ...Array.from({length:20}, ()=>({w:100,  h:100})),
      ...Array.from({length:15}, ()=>({w:991,  h:888})),
      ...Array.from({length:5},  ()=>({w:2000, h:200})),
    ] } },
  { name: 'Big 206p', input: { panelL: 3660, panelW: 1830, panelT: 18, kerf: 4.4, trimX: 10, trimY: 10, supplier: 'Test', cutDir: 'auto',
    raw: [
      ...Array.from({length:40}, ()=>({w:1700, h:1005})),
      ...Array.from({length:16}, ()=>({w:1251, h:1006})),
      ...Array.from({length:10}, ()=>({w:1706, h:418})),
      ...Array.from({length:30}, ()=>({w:896,  h:458})),
      ...Array.from({length:50}, ()=>({w:100,  h:100})),
      ...Array.from({length:45}, ()=>({w:991,  h:888})),
      ...Array.from({length:15}, ()=>({w:2000, h:200})),
    ] } },
];

// For verification we need to know what types are in the panel. The
// `content` string has [Dati] section listing types and counts. Parse it.
function parseDati(content) {
  const lines = content.split('\r\n');
  const datiStart = lines.findIndex(l => l === '[Dati]');
  if (datiStart < 0) return [];
  const numLine = lines[datiStart + 1];
  const num = parseInt(numLine.split('=')[1], 10);
  const types = [];
  for (let i = 0; i < num; i++) {
    const line = lines[datiStart + 2 + i];
    // Format: "N=,,placedOnThisPanel,CuttElab,,xRefs,w.00,h.00,T.00,,0,total"
    const parts = line.split('=')[1].split(',');
    types.push({
      placedOnThisPanel: +parts[2],
      w: parseFloat(parts[6]),
      h: parseFloat(parts[7]),
    });
  }
  return types;
}

(async () => {
  let totalPanels = 0;
  let okPanels = 0;
  let failPanels = 0;
  const failures = [];

  for (const tc of inputs) {
    console.log(`\n=== ${tc.name} ===`);
    const result = await newImpl._test.runOptimizerCore(tc.input);
    const headTrim = Math.max(tc.input.trimX, tc.input.trimY);

    for (let i = 0; i < result.panels.length; i++) {
      totalPanels++;
      const panel = result.panels[i];

      // Simulate the saw on this panel's strips
      const simulated = sim.simulateSaw(
        panel.strips, panel.mode,
        tc.input.panelL, tc.input.panelW,
        tc.input.kerf, headTrim, headTrim
      );

      // Build "intended" pieces from [Dati]: each entry says "count of type w×h"
      const dati = parseDati(panel.content);
      const intended = [];
      for (const t of dati) {
        for (let k = 0; k < t.placedOnThisPanel; k++) {
          intended.push({ w: t.w, h: t.h });
        }
      }

      // Match simulated to intended ignoring typeId (compare by w,h,rotation)
      // Each simulated piece has dimensions (w,h). It matches an intended piece
      // if (sim.w == int.w && sim.h == int.h) OR (sim.w == int.h && sim.h == int.w).
      const intendedRem = intended.map(p => ({ ...p, used: false }));
      let unmatched = 0;
      for (const s of simulated) {
        const idx = intendedRem.findIndex(p =>
          !p.used &&
          ((Math.abs(p.w - s.w) < 0.01 && Math.abs(p.h - s.h) < 0.01) ||
           (Math.abs(p.w - s.h) < 0.01 && Math.abs(p.h - s.w) < 0.01)));
        if (idx >= 0) intendedRem[idx].used = true;
        else unmatched++;
      }
      const intendedUnmatched = intendedRem.filter(p => !p.used).length;

      const bounds = sim.verifyBounds(simulated, tc.input.panelL, tc.input.panelW);
      const overlap = sim.verifyNoOverlap(simulated);
      const countOk = simulated.length === intended.length;
      const matchOk = unmatched === 0 && intendedUnmatched === 0;

      const ok = countOk && matchOk && bounds.ok && overlap.ok;
      if (ok) okPanels++;
      else {
        failPanels++;
        failures.push({
          test: tc.name, panelIdx: i,
          countOk, matchOk, boundsOk: bounds.ok, overlapOk: overlap.ok,
          simCount: simulated.length, intCount: intended.length,
          unmatched, intendedUnmatched,
          boundsViolations: bounds.violations.slice(0, 3),
          overlaps: overlap.overlaps.slice(0, 3),
        });
        console.log(`  P${i+1}: FAIL — sim=${simulated.length} int=${intended.length} unmatched=${unmatched}+${intendedUnmatched} bounds=${bounds.ok} overlap=${overlap.ok}`);
      }
    }
    console.log(`  ${result.panels.length} panels checked`);
  }

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  CUT-CORRECTNESS: ${okPanels}/${totalPanels} panels valid, ${failPanels} failures`);
  console.log(`═══════════════════════════════════════════════════════════════`);

  if (failures.length > 0) {
    console.log('\nFailure details:');
    for (const f of failures.slice(0, 10)) {
      console.log(JSON.stringify(f, null, 2));
    }
  }
  process.exit(failPanels > 0 ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(1); });
