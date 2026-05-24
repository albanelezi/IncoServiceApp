// Detailed dump of our Kurti panels — strip-by-strip, sub-strip-by-sub-strip,
// uCut-by-uCut — to compare with Cutty's reference panels.
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

const raw = [
  ...Array.from({length:1}, ()=>({w:2922, h:350})),
  ...Array.from({length:2}, ()=>({w:2685, h:530})),
  ...Array.from({length:2}, ()=>({w:2685, h:530})),
  ...Array.from({length:8}, ()=>({w:550,  h:160})),
  ...Array.from({length:1}, ()=>({w:1300, h:195})),
  ...Array.from({length:1}, ()=>({w:1760, h:140})),
  ...Array.from({length:1}, ()=>({w:1760, h:97})),
  ...Array.from({length:2}, ()=>({w:1205, h:140})),
  ...Array.from({length:1}, ()=>({w:2100, h:140})),
  ...Array.from({length:2}, ()=>({w:600,  h:270})),
  ...Array.from({length:2}, ()=>({w:210,  h:215})),
  ...Array.from({length:3}, ()=>({w:600,  h:137})),
  ...Array.from({length:1}, ()=>({w:600,  h:143})),
  ...Array.from({length:1}, ()=>({w:765,  h:194})),
  ...Array.from({length:2}, ()=>({w:575,  h:195})),
  ...Array.from({length:2}, ()=>({w:770,  h:575})),
  ...Array.from({length:2}, ()=>({w:600,  h:770})),
  ...Array.from({length:2}, ()=>({w:710,  h:320})),
  ...Array.from({length:6}, ()=>({w:2692, h:70})),
  ...Array.from({length:2}, ()=>({w:1400, h:356})),
  ...Array.from({length:3}, ()=>({w:377,  h:265})),
  ...Array.from({length:1}, ()=>({w:2692, h:799})),
  ...Array.from({length:1}, ()=>({w:2692, h:950})),
  ...Array.from({length:1}, ()=>({w:2692, h:430})),
  ...Array.from({length:1}, ()=>({w:2692, h:200})),
  ...Array.from({length:2}, ()=>({w:2332, h:400})),
  ...Array.from({length:2}, ()=>({w:2670, h:585})),
  ...Array.from({length:3}, ()=>({w:2517, h:420})),
  ...Array.from({length:1}, ()=>({w:2920, h:560})),
  ...Array.from({length:1}, ()=>({w:1697, h:497})),
];

(async () => {
  const r = await runOptimizerCore({
    panelL: 3660, panelW: 1830, panelT: 18,
    kerf: 4.4, trimX: 15, trimY: 15,
    supplier: 'INCO - Group', cutDir: 'auto',
    raw,
  });
  for (let i = 0; i < r.panels.length; i++) {
    const p = r.panels[i];
    console.log(`\n══════════ Panel ${i+1} (${p.mode}-mode, eff=${p.eff}%, ${p.placedCount} pcs) ══════════`);
    for (let s = 0; s < p.strips.length; s++) {
      const st = p.strips[s];
      if (p.mode === 'Y') {
        const primary = (st.primaryCuts || []).map(c => `${c.qty}×${c.pw}×${c.ph}`).join(' + ');
        console.log(`  Strip ${s+1}: Y=${st.stripH}  primary=[${primary}]`);
        const offs = Array.isArray(st.offcuts) ? st.offcuts
                  : st.offcut ? [{xPw: st.offcut.xPw, uCuts: [{uPh: st.offcut.uPh, uQty: st.offcut.uQty}]}]
                  : [];
        for (let j = 0; j < offs.length; j++) {
          const oc = offs[j];
          const us = oc.uCuts.map(u => `${u.uQty}×${oc.xPw}×${u.uPh}`).join(' + ');
          console.log(`           sub${j+1}: xPw=${oc.xPw}  [${us}]`);
        }
      } else {
        // X-mode
        console.log(`  Strip ${s+1}: X=${st.stripW}  uPh=${st.uPh} uQty=${st.uQty} (one type ${st.typeId})`);
        for (const vb of (st.vBars || [])) {
          console.log(`           vBar: barH=${vb.barH} ${vb.vQty}×${vb.vPw}`);
        }
      }
    }
  }
})().catch(e => { console.error(e.stack); process.exit(1); });
