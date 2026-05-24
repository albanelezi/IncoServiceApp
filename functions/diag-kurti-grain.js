// Kurti 109 / 60-piece job WITH grain on every row.
// Cutty produced 6 panels for this; we produced 9 (now refactored to no-rotate-only).
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

// Same cutlist as diag-kurti.js but with grainLock on every piece.
// Each row is its own group (groupId = row index).
function row(w, h, qty, groupId) {
  return Array.from({length: qty}, () => ({ w, h, grainLock: true, groupId }));
}
const raw = [
  ...row(2922, 350, 1, 1),
  ...row(2685, 530, 2, 2),
  ...row(2685, 530, 2, 3),
  ...row(550,  160, 8, 4),
  ...row(1300, 195, 1, 5),
  ...row(1760, 140, 1, 6),
  ...row(1760, 97,  1, 7),
  ...row(1205, 140, 2, 8),
  ...row(2100, 140, 1, 9),
  ...row(600,  270, 2, 10),
  ...row(210,  215, 2, 11),
  ...row(600,  137, 3, 12),
  ...row(600,  143, 1, 13),
  ...row(765,  194, 1, 14),
  ...row(575,  195, 2, 15),
  ...row(770,  575, 2, 16),
  ...row(600,  770, 2, 17),
  ...row(710,  320, 2, 18),
  ...row(2692, 70,  6, 19),
  ...row(1400, 356, 2, 20),
  ...row(377,  265, 3, 21),
  ...row(2692, 799, 1, 22),
  ...row(2692, 950, 1, 23),
  ...row(2692, 430, 1, 24),
  ...row(2692, 200, 1, 25),
  ...row(2332, 400, 2, 26),
  ...row(2670, 585, 2, 27),
  ...row(2517, 420, 3, 28),
  ...row(2920, 560, 1, 29),
  ...row(1697, 497, 1, 30),
];

(async () => {
  console.log('='.repeat(72));
  console.log('AD KURTI 109 — GRAIN ON ALL — 60 pieces, 31.575 m²');
  console.log('CUTTY: 6 panels  /  WAS (strict grain): 9 panels');
  console.log('='.repeat(72));

  const totalArea = raw.reduce((s,p)=>s+p.w*p.h, 0);
  const panelArea = 3660 * 1830;
  console.log(`LB = ${Math.ceil(totalArea/panelArea)} panels`);

  const t0 = Date.now();
  const r = await runOptimizerCore({
    panelL: 3660, panelW: 1830, panelT: 16,
    kerf: 4.4, trimX: 10, trimY: 10,
    supplier: 'INCO - Group', cutDir: 'auto', raw,
  });
  const ms = Date.now() - t0;

  const placed = r.panels.reduce((s,p)=>s+p.placedCount, 0);
  const overallEff = totalArea / (r.panels.length * panelArea) * 100;
  console.log(`\nOUTPUT: ${r.panels.length} panels, ${placed}/${raw.length} placed, eff=${overallEff.toFixed(1)}% in ${ms}ms\n`);

  for (let i = 0; i < r.panels.length; i++) {
    const p = r.panels[i];
    console.log(`Panel ${i+1}: ${p.mode}-mode, ${p.strips.length} strips, ${p.placedCount} pcs, eff=${p.eff}%`);
  }
})().catch(e => { console.error(e.stack); process.exit(1); });
