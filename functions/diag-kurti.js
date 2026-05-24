// Diagnostic for the Ad Kurti 109 / 60-piece MDF Shqeto job.
// Used to compare our output against Cutty's 6-panel reference.
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

// Cutlist from the screenshots — 60 pieces, 31.575 m².
const raw = [
  ...Array.from({length:1}, ()=>({w:2922, h:350})),
  ...Array.from({length:2}, ()=>({w:2685, h:530})),
  ...Array.from({length:2}, ()=>({w:2685, h:530})),  // duplicate row in input
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

const input = {
  panelL: 3660, panelW: 1830, panelT: 18,
  kerf: 4.4, trimX: 15, trimY: 15,
  supplier: 'INCO - Group', cutDir: 'auto',
  raw,
};

(async () => {
  console.log('='.repeat(72));
  console.log('AD KURTI 109 — 60 pieces, 31.575 m², LB=5');
  console.log('CUTTY REFERENCE: 6 panels @ 78.6% avg eff');
  console.log('='.repeat(72));

  const totalArea = raw.reduce((s,p)=>s+p.w*p.h, 0);
  const panelArea = input.panelL * input.panelW;
  const lb = totalArea / panelArea;
  console.log(`Total area: ${(totalArea/1e6).toFixed(2)} M mm² | Panel: ${(panelArea/1e6).toFixed(2)} M mm² | LB=${lb.toFixed(2)}`);

  const t0 = Date.now();
  const r = await runOptimizerCore(input);
  const ms = Date.now() - t0;

  const totalPlaced = r.panels.reduce((s,p)=>s+p.placedCount, 0);
  const matArea = r.panels.length * panelArea;
  const overallEff = totalArea / matArea * 100;

  console.log(`\nOUTPUT: ${r.panels.length} panels, ${totalPlaced}/${raw.length} placed, eff=${overallEff.toFixed(1)}% in ${ms}ms`);
  console.log(`Excess vs LB: ${(r.panels.length - lb).toFixed(2)} panels`);
  console.log();
  for (let i = 0; i < r.panels.length; i++) {
    const p = r.panels[i];
    console.log(`Panel ${(i+1).toString().padStart(2)}: ${p.mode}-mode, ${p.strips.length} strips, ${p.placedCount} pieces, eff=${p.eff}%`);
  }
})().catch(e => { console.error(e.stack); process.exit(1); });
