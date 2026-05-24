// Ermir Kurti 108 / MDF Shqeto Shqeto 25mm — 50 pieces, 21.345 m².
// Panel 2800×2100×25, LB = ⌈21.345 / 5.88⌉ = 4.
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

// From the screenshot, rows 1-24, qty as shown.
const raw = [
  ...Array.from({length:2}, ()=>({w:2157, h:340})),
  ...Array.from({length:2}, ()=>({w:2157, h:332})),
  ...Array.from({length:1}, ()=>({w:247,  h:863})),
  ...Array.from({length:1}, ()=>({w:247,  h:848})),
  ...Array.from({length:4}, ()=>({w:2250, h:477})),
  ...Array.from({length:4}, ()=>({w:832,  h:477})),
  ...Array.from({length:4}, ()=>({w:817,  h:477})),
  ...Array.from({length:4}, ()=>({w:250,  h:477})),
  ...Array.from({length:1}, ()=>({w:832,  h:455})),
  ...Array.from({length:1}, ()=>({w:817,  h:455})),
  ...Array.from({length:4}, ()=>({w:832,  h:450})),
  ...Array.from({length:4}, ()=>({w:817,  h:450})),
  ...Array.from({length:4}, ()=>({w:2600, h:100})),
  ...Array.from({length:1}, ()=>({w:866,  h:100})),
  ...Array.from({length:1}, ()=>({w:851,  h:100})),
  ...Array.from({length:1}, ()=>({w:2232, h:848})),
  ...Array.from({length:1}, ()=>({w:232,  h:848})),
  ...Array.from({length:1}, ()=>({w:2232, h:833})),
  ...Array.from({length:1}, ()=>({w:851,  h:100})),
  ...Array.from({length:4}, ()=>({w:440,  h:140})),
  ...Array.from({length:1}, ()=>({w:784,  h:120})),
  ...Array.from({length:1}, ()=>({w:769,  h:120})),
  ...Array.from({length:1}, ()=>({w:448,  h:800})),
  ...Array.from({length:1}, ()=>({w:448,  h:785})),
];

(async () => {
  const total = raw.length;
  const totalArea = raw.reduce((s,p)=>s+p.w*p.h, 0);
  const panelArea = 2800 * 2100;
  console.log('='.repeat(72));
  console.log('ERMIR KURTI 108 — 50 pieces, 21.34 m²');
  console.log(`Panel 2800×2100 (5.88 m²), LB = ${Math.ceil(totalArea / panelArea)}`);
  console.log('='.repeat(72));
  console.log(`Total pieces: ${total}, total area: ${(totalArea/1e6).toFixed(2)} M mm²`);
  console.log();

  const t0 = Date.now();
  const r = await runOptimizerCore({
    panelL: 2800, panelW: 2100, panelT: 25,
    kerf: 4.4, trimX: 10, trimY: 10,  // Cutty uses 10mm trim
    supplier: 'INCO - Group', cutDir: 'auto', raw,
  });
  const ms = Date.now() - t0;

  const placed = r.panels.reduce((s,p)=>s+p.placedCount, 0);
  const overallEff = totalArea / (r.panels.length * panelArea) * 100;
  console.log(`OUTPUT: ${r.panels.length} panels, ${placed}/${total} placed, eff=${overallEff.toFixed(1)}% in ${ms}ms`);
  console.log();

  for (let i = 0; i < r.panels.length; i++) {
    const p = r.panels[i];
    console.log(`══════════ Panel ${i+1} (${p.mode}-mode, eff=${p.eff}%, ${p.placedCount} pcs) ══════════`);
    for (let s = 0; s < p.strips.length; s++) {
      const st = p.strips[s];
      if (p.mode === 'Y') {
        const primary = (st.primaryCuts || []).map(c => `${c.qty}×${c.pw}×${c.ph}`).join(' + ');
        console.log(`  Strip ${s+1}: Y=${st.stripH}  primary=[${primary}]`);
        const offs = Array.isArray(st.offcuts) ? st.offcuts
                  : st.offcut ? [{xPw: st.offcut.xPw, ru: st.offcut.ru, uCuts: [{uPh: st.offcut.uPh, uQty: st.offcut.uQty}]}]
                  : [];
        for (let j = 0; j < offs.length; j++) {
          const oc = offs[j];
          const us = oc.uCuts.map(u => `${u.uQty}×${oc.xPw}×${u.uPh}`).join(' + ');
          console.log(`           sub${j+1}: xPw=${oc.xPw} ru=${oc.ru}  [${us}]`);
        }
      } else {
        console.log(`  Strip ${s+1}: X=${st.stripW}  uPh=${st.uPh} uQty=${st.uQty}`);
        for (const vb of (st.vBars || [])) {
          console.log(`           vBar: barH=${vb.barH} ${vb.vQty}×${vb.vPw}`);
        }
      }
    }
  }
})().catch(e => { console.error(e.stack); process.exit(1); });
