// Diagnostic: run the stress-test cutlist and dump per-panel breakdown.
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

const input = {
  panelL: 2800, panelW: 2070, panelT: 18,
  kerf: 4.4, trimX: 15, trimY: 15,
  supplier: 'Test', cutDir: 'auto',
  raw: [
    ...Array.from({length:2},  ()=>({w:2698, h:585})),
    ...Array.from({length:4},  ()=>({w:2100, h:565})),
    ...Array.from({length:4},  ()=>({w:1800, h:565})),
    ...Array.from({length:2},  ()=>({w:1700, h:1005})),
    ...Array.from({length:2},  ()=>({w:1405, h:656})),
    ...Array.from({length:4},  ()=>({w:1251, h:1006})),
    ...Array.from({length:2},  ()=>({w:1200, h:901})),
    ...Array.from({length:2},  ()=>({w:1200, h:450})),
    ...Array.from({length:8},  ()=>({w:980,  h:565})),
    ...Array.from({length:4},  ()=>({w:980,  h:537})),
    ...Array.from({length:4},  ()=>({w:901,  h:800})),
    ...Array.from({length:2},  ()=>({w:906,  h:450})),
    ...Array.from({length:6},  ()=>({w:880,  h:458})),
    ...Array.from({length:4},  ()=>({w:780,  h:565})),
    ...Array.from({length:2},  ()=>({w:2577, h:505})),
    ...Array.from({length:6},  ()=>({w:2000, h:200})),
    ...Array.from({length:1},  ()=>({w:1706, h:418})),
    ...Array.from({length:2},  ()=>({w:1200, h:97})),
    ...Array.from({length:4},  ()=>({w:858,  h:101})),
    ...Array.from({length:6},  ()=>({w:906,  h:80})),
    ...Array.from({length:3},  ()=>({w:2000, h:73})),
    ...Array.from({length:8},  ()=>({w:565,  h:565})),
    ...Array.from({length:4},  ()=>({w:480,  h:565})),
    ...Array.from({length:4},  ()=>({w:472,  h:565})),
    ...Array.from({length:7},  ()=>({w:398,  h:450})),
    ...Array.from({length:4},  ()=>({w:398,  h:80})),
    ...Array.from({length:12}, ()=>({w:398,  h:65})),
    ...Array.from({length:12}, ()=>({w:390,  h:121})),
    ...Array.from({length:2},  ()=>({w:350,  h:101})),
    ...Array.from({length:4},  ()=>({w:177,  h:902})),
    ...Array.from({length:2},  ()=>({w:177,  h:394})),
    ...Array.from({length:20}, ()=>({w:100,  h:100})),
  ],
};

// Extract every piece (w,h) from a panel by walking the strip structure.
function piecesFromPanel(panel) {
  const out = [];
  const mode = panel.mode;
  for (const st of (panel.strips || [])) {
    if (mode === 'Y') {
      for (const c of (st.primaryCuts || [])) {
        for (let i = 0; i < c.qty; i++) out.push({ w: c.pw, h: st.stripH });
      }
      const offcuts = Array.isArray(st.offcuts) ? st.offcuts
                    : st.offcut ? [{ xPw: st.offcut.xPw, uCuts: [{ uPh: st.offcut.uPh, uQty: st.offcut.uQty }] }]
                    : [];
      for (const oc of offcuts) {
        for (const u of oc.uCuts) {
          for (let i = 0; i < u.uQty; i++) out.push({ w: oc.xPw, h: u.uPh });
        }
      }
    } else if (mode === 'X') {
      for (let i = 0; i < st.uQty; i++) out.push({ w: st.stripW, h: st.uPh });
      for (const vb of (st.vBars || [])) {
        for (let i = 0; i < vb.vQty; i++) out.push({ w: vb.vPw, h: vb.barH });
      }
    }
  }
  return out;
}

(async () => {
  const totalPieces = input.raw.length;
  const totalArea = input.raw.reduce((s,p)=>s+p.w*p.h, 0);
  const panelArea = input.panelL * input.panelW;
  const lbArea = totalArea / panelArea;

  console.log('='.repeat(72));
  console.log('STRESS-TEST DIAGNOSTIC');
  console.log('='.repeat(72));
  console.log(`Panel:        ${input.panelL} x ${input.panelW} (area ${(panelArea/1e6).toFixed(2)} M mm²)`);
  console.log(`Pieces:       ${totalPieces} pieces, ${new Set(input.raw.map(p=>`${p.w}x${p.h}`)).size} distinct types`);
  console.log(`Total area:   ${(totalArea/1e6).toFixed(2)} M mm²`);
  console.log(`Area-LB:      ${lbArea.toFixed(2)} panels (math floor = ${Math.ceil(lbArea)})`);
  console.log();

  const t0 = Date.now();
  const result = await runOptimizerCore(input);
  const ms = Date.now() - t0;

  const v3Panels = result.panels.length;
  const matAreaUsed = v3Panels * panelArea;
  const v3Eff = (totalArea / matAreaUsed * 100);
  const totalPlaced = result.panels.reduce((s,p)=>s+p.placedCount, 0);

  console.log(`OUTPUT:       ${v3Panels} panels @ ${v3Eff.toFixed(1)}% (${totalPlaced}/${totalPieces} placed) in ${ms}ms`);
  console.log(`Excess:       ${(v3Panels - lbArea).toFixed(2)} panels over LB (${((v3Panels-lbArea)/lbArea*100).toFixed(0)}%)`);
  console.log();

  console.log('PER-PANEL BREAKDOWN:');
  console.log('-'.repeat(72));
  const allPanelInfo = [];
  for (let i = 0; i < result.panels.length; i++) {
    const p = result.panels[i];
    const pieces = piecesFromPanel(p);
    const placedArea = pieces.reduce((s,pl)=>s+pl.w*pl.h, 0);
    const eff = (placedArea / panelArea * 100);
    const stripCount = (p.strips || []).length;
    const types = new Map();
    for (const pl of pieces) {
      const k = `${pl.w}×${pl.h}`;
      types.set(k, (types.get(k)||0) + 1);
    }
    const typeList = [...types.entries()].sort((a,b)=>b[1]-a[1]);
    allPanelInfo.push({ idx: i+1, eff, stripCount, mode: p.mode, count: pieces.length, types: typeList });
    const typeStr = typeList.map(([k,n]) => `${n}×${k}`).join(', ');
    console.log(`Panel ${(i+1).toString().padStart(2)}: ${p.mode}-mode, ${stripCount} strips, ` +
                `${pieces.length} pieces, eff=${eff.toFixed(1)}%`);
    console.log(`           ${typeStr}`);
  }
  console.log();

  // Worst panels (most waste)
  const worst = [...allPanelInfo].sort((a,b)=>a.eff-b.eff).slice(0, 4);
  console.log('WORST 4 PANELS (lowest efficiency = most waste):');
  for (const w of worst) {
    console.log(`  Panel ${w.idx}: ${w.eff.toFixed(1)}% (${w.count} pieces, ${w.types.length} types)`);
  }
  console.log();

  // Panels with single type (often a sign of poor packing)
  const lonely = allPanelInfo.filter(p => p.types.length === 1);
  if (lonely.length) {
    console.log('SINGLE-TYPE PANELS (filled with only one piece kind):');
    for (const l of lonely) {
      console.log(`  Panel ${l.idx}: ${l.count}× ${l.types[0][0]} @ ${l.eff.toFixed(1)}%`);
    }
    console.log();
  }

  // Panels with very few types (potential waste)
  const sparse = allPanelInfo.filter(p => p.types.length === 2 && p.eff < 75);
  if (sparse.length) {
    console.log('LOW-MIX LOW-EFF PANELS (only 2 types, <75%):');
    for (const l of sparse) {
      console.log(`  Panel ${l.idx}: ${l.eff.toFixed(1)}% — ${l.types.map(([k,n])=>`${n}×${k}`).join(', ')}`);
    }
    console.log();
  }
})().catch(e => { console.error(e.stack); process.exit(1); });
