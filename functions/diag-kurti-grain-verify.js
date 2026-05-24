// Saw-verifier for Kurti1 grain run.
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
const { simulateSaw } = require('./lib/saw-simulator.js');

function row(w, h, qty, groupId) {
  return Array.from({length: qty}, () => ({ w, h, grainLock: true, groupId }));
}
const raw = [
  ...row(2922, 350, 1, 1), ...row(2685, 530, 2, 2), ...row(2685, 530, 2, 3),
  ...row(550, 160, 8, 4), ...row(1300, 195, 1, 5), ...row(1760, 140, 1, 6),
  ...row(1760, 97, 1, 7), ...row(1205, 140, 2, 8), ...row(2100, 140, 1, 9),
  ...row(600, 270, 2, 10), ...row(210, 215, 2, 11), ...row(600, 137, 3, 12),
  ...row(600, 143, 1, 13), ...row(765, 194, 1, 14), ...row(575, 195, 2, 15),
  ...row(770, 575, 2, 16), ...row(600, 770, 2, 17), ...row(710, 320, 2, 18),
  ...row(2692, 70, 6, 19), ...row(1400, 356, 2, 20), ...row(377, 265, 3, 21),
  ...row(2692, 799, 1, 22), ...row(2692, 950, 1, 23), ...row(2692, 430, 1, 24),
  ...row(2692, 200, 1, 25), ...row(2332, 400, 2, 26), ...row(2670, 585, 2, 27),
  ...row(2517, 420, 3, 28), ...row(2920, 560, 1, 29), ...row(1697, 497, 1, 30),
];

const panelL = 3660, panelW = 1830, kerf = 4.4, trim = 10;
function rectsOverlap(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x ||
           a.y + a.h <= b.y || b.y + b.h <= a.y);
}

(async () => {
  const r = await newImpl._test.runOptimizerCore({
    panelL, panelW, panelT: 16, kerf, trimX: trim, trimY: trim,
    supplier: 'INCO', cutDir: 'auto', raw,
  });

  const expected = new Map();
  for (const p of raw) {
    const k = `${Math.min(p.w,p.h)}×${Math.max(p.w,p.h)}`;
    expected.set(k, (expected.get(k) || 0) + 1);
  }

  const placed = new Map();
  let totalErrors = 0;
  let rotatedGrainCount = 0;

  // To check grain compliance, need a quick lookup: piece dims → was it grain?
  const grainSet = new Set();
  for (const p of raw) {
    if (p.grainLock) grainSet.add(`${p.w}×${p.h}`);  // ordered (W×H) form
  }

  for (let i = 0; i < r.panels.length; i++) {
    const p = r.panels[i];
    const sim = simulateSaw(p.strips, p.mode, panelL, panelW, kerf, trim, trim);
    let panelErrors = 0;
    for (const pc of sim) {
      if (pc.x < 0 || pc.y < 0 || pc.x + pc.w > panelL + 1e-6 || pc.y + pc.h > panelW + 1e-6) {
        console.log(`P${i+1}: OOB ${pc.w}×${pc.h} @ (${pc.x},${pc.y})`);
        panelErrors++;
      }
      // Grain check: a grain piece's W must be along X (= pc.w in saw output).
      // If it appears as pc.w=H, pc.h=W (rotated form), the grain rule was violated.
      const aOrder = `${pc.w}×${pc.h}`;
      const bOrder = `${pc.h}×${pc.w}`;
      if (grainSet.has(bOrder) && !grainSet.has(aOrder)) {
        console.log(`P${i+1}: GRAIN ROTATED ${pc.w}×${pc.h} (should be ${pc.h}×${pc.w})`);
        rotatedGrainCount++;
        panelErrors++;
      }
    }
    for (let a = 0; a < sim.length; a++) {
      for (let b = a + 1; b < sim.length; b++) {
        if (rectsOverlap(sim[a], sim[b])) {
          console.log(`P${i+1}: OVERLAP ${sim[a].w}×${sim[a].h}@(${sim[a].x},${sim[a].y}) vs ${sim[b].w}×${sim[b].h}@(${sim[b].x},${sim[b].y})`);
          panelErrors++;
        }
      }
    }
    for (const pc of sim) {
      const k = `${Math.min(pc.w,pc.h)}×${Math.max(pc.w,pc.h)}`;
      placed.set(k, (placed.get(k) || 0) + 1);
    }
    totalErrors += panelErrors;
    console.log(`Panel ${i+1}: ${sim.length} pcs, ${panelErrors} errors`);
  }

  let mismatch = 0;
  for (const [k, want] of expected) {
    const got = placed.get(k) || 0;
    if (got !== want) { console.log(`MISMATCH ${k}: ${want} expected, ${got} placed`); mismatch++; }
  }
  for (const [k, got] of placed) {
    if (!expected.has(k)) { console.log(`EXTRA ${k}: ${got}`); mismatch++; }
  }
  console.log(`\nTotal: ${r.panels.length} panels, ${totalErrors} errors, ${mismatch} mismatches, ${rotatedGrainCount} grain rotations`);
  if (totalErrors === 0 && mismatch === 0 && rotatedGrainCount === 0) console.log('✓ Saw + grain verifier PASSED');
  process.exit(totalErrors + mismatch + rotatedGrainCount === 0 ? 0 : 1);
})().catch(e => { console.error(e.stack); process.exit(1); });
