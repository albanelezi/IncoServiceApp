// Geometric verifier for Ermir Kurti 108 dataset.
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

const panelL = 2800, panelW = 2100, kerf = 4.4, trim = 10;

function rectsOverlap(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x ||
           a.y + a.h <= b.y || b.y + b.h <= a.y);
}

(async () => {
  const r = await newImpl._test.runOptimizerCore({
    panelL, panelW, panelT: 25, kerf, trimX: trim, trimY: trim,
    supplier: 'INCO', cutDir: 'auto', raw,
  });

  const expected = new Map();
  for (const p of raw) {
    const k = `${Math.min(p.w,p.h)}×${Math.max(p.w,p.h)}`;
    expected.set(k, (expected.get(k) || 0) + 1);
  }

  const placed = new Map();
  let totalErrors = 0;

  for (let i = 0; i < r.panels.length; i++) {
    const p = r.panels[i];
    const sim = simulateSaw(p.strips, p.mode, panelL, panelW, kerf, trim, trim);
    let panelErrors = 0;
    for (const pc of sim) {
      if (pc.x < 0 || pc.y < 0 || pc.x + pc.w > panelL + 1e-6 || pc.y + pc.h > panelW + 1e-6) {
        console.log(`P${i+1}: OOB ${pc.w}×${pc.h} @ (${pc.x},${pc.y})`);
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
  console.log(`\nTotal: ${r.panels.length} panels, ${totalErrors} geom errors, ${mismatch} demand mismatches`);
  if (totalErrors === 0 && mismatch === 0) console.log('✓ Saw verifier PASSED');
  process.exit(totalErrors + mismatch === 0 ? 0 : 1);
})().catch(e => { console.error(e.stack); process.exit(1); });
