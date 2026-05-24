// Kurti job — geometric verification: every panel's saw output must have
// (1) no overlapping pieces, (2) all coords inside panel - trim, (3) every
// requested piece accounted for exactly once.
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

const panelL = 3660, panelW = 1830, kerf = 4.4, trim = 15;

function rectsOverlap(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x ||
           a.y + a.h <= b.y || b.y + b.h <= a.y);
}

(async () => {
  const r = await newImpl._test.runOptimizerCore({
    panelL, panelW, panelT: 18, kerf, trimX: trim, trimY: trim,
    supplier: 'INCO', cutDir: 'auto', raw,
  });

  const expected = new Map();
  for (const p of raw) {
    const k = `${Math.min(p.w,p.h)}×${Math.max(p.w,p.h)}`;
    expected.set(k, (expected.get(k) || 0) + 1);
  }

  const placed = new Map();
  let totalPieces = 0;
  let totalErrors = 0;

  for (let i = 0; i < r.panels.length; i++) {
    const p = r.panels[i];
    const sim = simulateSaw(p.strips, p.mode, panelL, panelW, kerf, trim, trim);
    totalPieces += sim.length;
    let panelErrors = 0;

    // Bounds check
    for (const pc of sim) {
      if (pc.x < 0 || pc.y < 0 || pc.x + pc.w > panelL || pc.y + pc.h > panelW) {
        console.log(`P${i+1}: piece OUT OF BOUNDS ${pc.w}×${pc.h} @ (${pc.x},${pc.y})`);
        panelErrors++;
      }
    }
    // Overlap check
    for (let a = 0; a < sim.length; a++) {
      for (let b = a + 1; b < sim.length; b++) {
        if (rectsOverlap(sim[a], sim[b])) {
          console.log(`P${i+1}: OVERLAP ${sim[a].w}×${sim[a].h}@(${sim[a].x},${sim[a].y}) vs ${sim[b].w}×${sim[b].h}@(${sim[b].x},${sim[b].y})`);
          panelErrors++;
        }
      }
    }
    // Track placed
    for (const pc of sim) {
      const k = `${Math.min(pc.w,pc.h)}×${Math.max(pc.w,pc.h)}`;
      placed.set(k, (placed.get(k) || 0) + 1);
    }
    totalErrors += panelErrors;
    console.log(`Panel ${i+1}: ${sim.length} pcs, ${panelErrors} errors`);
  }

  // Demand match check
  let mismatch = 0;
  for (const [k, want] of expected) {
    const got = placed.get(k) || 0;
    if (got !== want) {
      console.log(`MISMATCH ${k}: expected ${want}, placed ${got}`);
      mismatch++;
    }
  }
  for (const [k, got] of placed) {
    if (!expected.has(k)) {
      console.log(`EXTRA piece ${k}: placed ${got} but not requested`);
      mismatch++;
    }
  }

  console.log(`\nTotal: ${r.panels.length} panels, ${totalPieces} pieces, ${totalErrors} geometric errors, ${mismatch} demand mismatches`);
  if (totalErrors === 0 && mismatch === 0) {
    console.log('✓ Saw verifier PASSED');
  }
  process.exit(totalErrors + mismatch === 0 ? 0 : 1);
})().catch(e => { console.error(e.stack); process.exit(1); });
