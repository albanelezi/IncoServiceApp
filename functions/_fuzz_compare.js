// Seeded fuzz: baseline vs new optimizer on random jobs.
// Asserts, per job:
//   1. newPanels <= basePanels          (panel count can only improve)
//   2. both place every piece           (placement parity)
//   3. new output geometry valid        (saw-sim bounds + overlap)
// Usage: node _fuzz_compare.js [numJobs] [seed]
const Module = require('module');
const stub = require('./lib/_v2_stub');
const origReq = Module.prototype.require;
Module.prototype.require = function (name) {
  if (name === 'firebase-functions/v2/https') return stub.https;
  if (name === 'firebase-functions/v2') return { setGlobalOptions: () => {} };
  return origReq.apply(this, arguments);
};
const baseImpl = require('./_baseline_index.js');
const newImpl  = require('./index.js');
Module.prototype.require = origReq;
const sim = require('./lib/saw-simulator');

const N    = parseInt(process.argv[2] || '30', 10);
const SEED = parseInt(process.argv[3] || '20260630', 10);

// Deterministic LCG.
let _s = SEED >>> 0;
const rnd = () => ((_s = (_s * 1664525 + 1013904223) >>> 0) / 4294967296);
const ri  = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

function makeJob(idx) {
  const panels = [[3660, 1830], [2800, 2070], [2800, 1750]];
  const [panelL, panelW] = panels[ri(0, panels.length - 1)];
  const trim = [10, 15][ri(0, 1)];
  const nTypes = ri(3, 22);
  const grainJob = rnd() < 0.3;
  const raw = [];
  const maxDim = Math.max(panelL, panelW) - 2 * trim - 10;
  const minDimPanel = Math.min(panelL, panelW) - 2 * trim - 10;
  for (let t = 0; t < nTypes; t++) {
    let w = ri(70, Math.min(2400, maxDim));
    let h = ri(65, Math.min(1000, minDimPanel));
    if (Math.min(w, h) > minDimPanel) h = minDimPanel;
    const qty = ri(1, 6);
    const grain = grainJob && rnd() < 0.5;
    for (let q = 0; q < qty; q++) {
      raw.push(grain
        ? { w, h, grainLock: true, groupId: t + 1 }
        : { w, h });
    }
  }
  return {
    name: `job${idx} ${panelL}x${panelW} ${raw.length}p/${nTypes}t${grainJob ? ' grain' : ''}`,
    input: { panelL, panelW, panelT: 18, kerf: 4.4, trimX: trim, trimY: trim,
             supplier: 'Fuzz', cutDir: 'auto', raw },
  };
}

function check(result, input) {
  const placed = result.panels.reduce((s, p) => s + p.placedCount, 0);
  let geomOk = true;
  const trim = Math.max(input.trimX, input.trimY);
  for (const p of result.panels) {
    const pieces = sim.simulateSaw(p.strips, p.mode, input.panelL, input.panelW,
                                   input.kerf, trim, trim);
    if (!sim.verifyBounds(pieces, input.panelL, input.panelW).ok) geomOk = false;
    if (!sim.verifyNoOverlap(pieces).ok) geomOk = false;
  }
  return { panels: result.panels.length, placed, geomOk };
}

(async () => {
  let fail = 0, improved = 0;
  for (let i = 0; i < N; i++) {
    const { name, input } = makeJob(i);
    let rb, rn;
    try { rb = check(await baseImpl._test.runOptimizerCore(input), input); }
    catch (e) { console.log(`SKIP ${name}: baseline threw (${e.message})`); continue; }
    try { rn = check(await newImpl._test.runOptimizerCore(input), input); }
    catch (e) { console.log(`FAIL ${name}: NEW threw (${e.message})`); fail++; continue; }

    const problems = [];
    if (rn.panels > rb.panels) problems.push(`panels ${rb.panels}→${rn.panels}`);
    if (rn.placed !== rb.placed) problems.push(`placed ${rb.placed}→${rn.placed} of ${input.raw.length}`);
    if (!rn.geomOk) problems.push('new geometry INVALID');
    if (!rb.geomOk) problems.push('baseline geometry invalid (pre-existing)');
    if (rn.panels < rb.panels) improved++;
    if (problems.length) { fail++; console.log(`FAIL ${name}: ${problems.join('; ')}`); }
    else console.log(`ok   ${name}: base=${rb.panels}p new=${rn.panels}p placed=${rn.placed}/${input.raw.length}`);
  }
  console.log(`\n${N} jobs — failures: ${fail}, panel-count improvements: ${improved}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(1); });
