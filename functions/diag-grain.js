// Diagnostic: exercise the "Ruaj Ujerat" grain-preservation feature.
// Verifies grain pieces stack as primary cuts in the same Y-strip.
const Module = require('module');
const origReq = Module.prototype.require;
Module.prototype.require = function(name) {
  if (name === 'firebase-functions/v2/https') {
    return { onCall: (o,fn)=>fn, HttpsError: class extends Error {constructor(c,m){super(m);this.code=c;}} };
  }
  if (name === 'firebase-functions/v2') return { setGlobalOptions: ()=>{} };
  return origReq.apply(this, arguments);
};
const newImpl = require('./index.js');
Module.prototype.require = origReq;
const runOptimizerCore = newImpl._test.runOptimizerCore;

function dumpStrips(p, idx) {
  console.log(`\nPanel ${idx} (${p.mode}-mode, eff=${(p.eff)}%):`);
  if (p.mode !== 'Y') {
    console.log('  (X-mode panel — grain panels are always Y-mode)');
    return;
  }
  for (let i = 0; i < p.strips.length; i++) {
    const st = p.strips[i];
    const pcs = (st.primaryCuts || []).map(c => `${c.qty}×${c.pw}×${c.ph}`).join(', ');
    console.log(`  Strip ${i+1}: stripH=${st.stripH}  primary=[${pcs}]`);
    const offs = Array.isArray(st.offcuts) ? st.offcuts
              : st.offcut ? [{xPw: st.offcut.xPw, uCuts:[{uPh: st.offcut.uPh, uQty: st.offcut.uQty}]}]
              : [];
    for (const oc of offs) {
      const us = oc.uCuts.map(u => `${u.uQty}×${oc.xPw}×${u.uPh}`).join(', ');
      console.log(`           offcut xPw=${oc.xPw}  [${us}]`);
    }
  }
}

async function testCase(label, raw) {
  console.log('='.repeat(72));
  console.log('TEST: ' + label);
  console.log('='.repeat(72));
  const input = {
    panelL: 2800, panelW: 2070, panelT: 18,
    kerf: 4.4, trimX: 15, trimY: 15,
    supplier: 'Test', cutDir: 'auto', raw,
  };
  const r = await runOptimizerCore(input);
  console.log(`Result: ${r.panels.length} panel(s)`);
  for (let i = 0; i < r.panels.length; i++) dumpStrips(r.panels[i], i+1);
  return r;
}

(async () => {
  // Test 1: single grain group, fits in one strip. All 4 must share same Y-band.
  await testCase('Single grain group, 4 pieces of 600×300, fits in one strip', [
    {w:600, h:300, grainLock:true, groupId:1},
    {w:600, h:300, grainLock:true, groupId:1},
    {w:600, h:300, grainLock:true, groupId:1},
    {w:600, h:300, grainLock:true, groupId:1},
  ]);

  // Test 2: grain group + non-grain filler in same strip (mixing rule).
  await testCase('Grain group (2×600×300) + non-grain 800×300 filler', [
    {w:600, h:300, grainLock:true, groupId:1},
    {w:600, h:300, grainLock:true, groupId:1},
    {w:800, h:300},
    {w:800, h:300},
    {w:800, h:300},
  ]);

  // Test 3: spillover — too many grain pieces for one panel.
  // 8 pieces of 1200×400 → 8 × 1204mm width = 9632mm; panel L = 2785 fits 2 per strip.
  // Need 4 strips to hold 8 pieces, total stripH = 4×400 + 3×kerf ≈ 1613mm.
  // Plus trim 15. So 1 panel can hold ~5 strips (panel W = 2055-15=2040).
  // 8 pieces fit in one panel.
  await testCase('Spillover test: 12×1200×400 grain (forces 2 panels)', [
    ...Array.from({length:12}, () => ({w:1200, h:400, grainLock:true, groupId:1})),
  ]);

  // Test 4: two groups of equal h share a strip.
  await testCase('Two groups same h: 3×500×300 g=1 + 3×700×300 g=2 → one strip', [
    {w:500, h:300, grainLock:true, groupId:1},
    {w:500, h:300, grainLock:true, groupId:1},
    {w:500, h:300, grainLock:true, groupId:1},
    {w:700, h:300, grainLock:true, groupId:2},
    {w:700, h:300, grainLock:true, groupId:2},
    {w:700, h:300, grainLock:true, groupId:2},
  ]);

  // Test 5: mixed h grain — smaller h at bottom rule.
  await testCase('Mixed h grain: 2×600×200 g=1 + 2×600×500 g=2 (200 should be bottom strip)', [
    {w:600, h:500, grainLock:true, groupId:2},
    {w:600, h:500, grainLock:true, groupId:2},
    {w:600, h:200, grainLock:true, groupId:1},
    {w:600, h:200, grainLock:true, groupId:1},
  ]);
})().catch(e => { console.error(e.stack); process.exit(1); });
