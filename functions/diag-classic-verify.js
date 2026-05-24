// Geometric verifier for Klasik + tail-fill: no overlaps, all pieces accounted for.
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'INCO_Furniture_v12.html'), 'utf8');
function extractFn(name) {
  const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`, 'm');
  return html.match(re)[0];
}
const src = [
  extractFn('knapsack1DClassic'),
  extractFn('optimizePanelClassic'),
  extractFn('optimizeJobClassic'),
  extractFn('writeSawProgramClassic'),
  extractFn('runClassicOptimizer'),
  'module.exports = { runClassicOptimizer };'
].join('\n\n');
const m = new (require('module'))('vc-virt');
m.filename = 'vc-virt';
m._compile(src, 'vc-virt');
const { runClassicOptimizer } = m.exports;
const { simulateSaw } = require('./lib/saw-simulator.js');

function rectsOverlap(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x ||
           a.y + a.h <= b.y || b.y + b.h <= a.y);
}

function verify(label, panelL, panelW, kerf, trim, raw) {
  const r = runClassicOptimizer({
    panelL, panelW, panelT: 18, kerf, trimX: trim, trimY: trim,
    supplier: 'Test', cutDir: 'auto', raw,
  });
  const expected = new Map();
  for (const p of raw) {
    const k = `${Math.min(p.w,p.h)}×${Math.max(p.w,p.h)}`;
    expected.set(k, (expected.get(k)||0)+1);
  }
  const placed = new Map();
  let totalErrors = 0;
  for (let i = 0; i < r.panels.length; i++) {
    const p = r.panels[i];
    const sim = simulateSaw(p.strips, p.mode, panelL, panelW, kerf, trim, trim);
    let errs = 0;
    for (const pc of sim) {
      if (pc.x < -1e-3 || pc.y < -1e-3 || pc.x+pc.w > panelL+1e-3 || pc.y+pc.h > panelW+1e-3) {
        console.log(`P${i+1}: OOB ${pc.w}×${pc.h} @ (${pc.x.toFixed(1)},${pc.y.toFixed(1)})`);
        errs++;
      }
    }
    for (let a = 0; a < sim.length; a++) for (let b = a+1; b < sim.length; b++) {
      if (rectsOverlap(sim[a], sim[b])) {
        console.log(`P${i+1}: OVERLAP ${sim[a].w}×${sim[a].h}@(${sim[a].x.toFixed(1)},${sim[a].y.toFixed(1)}) vs ${sim[b].w}×${sim[b].h}@(${sim[b].x.toFixed(1)},${sim[b].y.toFixed(1)})`);
        errs++;
      }
    }
    for (const pc of sim) {
      const k = `${Math.min(pc.w,pc.h)}×${Math.max(pc.w,pc.h)}`;
      placed.set(k, (placed.get(k)||0)+1);
    }
    totalErrors += errs;
  }
  let mismatch = 0;
  for (const [k, want] of expected) {
    const got = placed.get(k) || 0;
    if (got !== want) { console.log(`MISMATCH ${k}: ${want} expected, ${got} placed`); mismatch++; }
  }
  for (const [k, got] of placed) {
    if (!expected.has(k)) { console.log(`EXTRA ${k}: ${got}`); mismatch++; }
  }
  console.log(`${label}: ${r.panels.length} panels, ${totalErrors} geom errors, ${mismatch} mismatches ${totalErrors+mismatch===0?'✓':'✗'}`);
}

// Kurti1
const kurti1 = [];
const k1 = (w, h, qty) => { for (let i = 0; i < qty; i++) kurti1.push({ w, h }); };
k1(2922,350,1); k1(2685,530,4); k1(550,160,8); k1(1300,195,1); k1(1760,140,1);
k1(1760,97,1); k1(1205,140,2); k1(2100,140,1); k1(600,270,2); k1(210,215,2);
k1(600,137,3); k1(600,143,1); k1(765,194,1); k1(575,195,2); k1(770,575,2);
k1(600,770,2); k1(710,320,2); k1(2692,70,6); k1(1400,356,2); k1(377,265,3);
k1(2692,799,1); k1(2692,950,1); k1(2692,430,1); k1(2692,200,1); k1(2332,400,2);
k1(2670,585,2); k1(2517,420,3); k1(2920,560,1); k1(1697,497,1);
verify('Kurti1', 3660, 1830, 4.4, 10, kurti1);

// Kurti2
const kurti2 = [];
const k2 = (w, h, qty) => { for (let i = 0; i < qty; i++) kurti2.push({ w, h }); };
k2(2157,340,2); k2(2157,332,2); k2(247,863,1); k2(247,848,1); k2(2250,477,4);
k2(832,477,4); k2(817,477,4); k2(250,477,4); k2(832,455,1); k2(817,455,1);
k2(832,450,4); k2(817,450,4); k2(2600,100,4); k2(866,100,1); k2(851,100,1);
k2(2232,848,1); k2(232,848,1); k2(2232,833,1); k2(851,100,1); k2(440,140,4);
k2(784,120,1); k2(769,120,1); k2(448,800,1); k2(448,785,1);
verify('Kurti2', 2800, 2100, 4.4, 10, kurti2);
