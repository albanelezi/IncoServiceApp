// Fuzz A/B for the MIN_INNER_TRIM 5->10 change, isolating exactly that
// constant. Loads the PRE-CHANGE engine (baseline index + baseline v2,
// MIN=5) and the NEW engine (current index + v2, MIN=10) in one process.
//
// Per random job asserts:
//   1. newPanels <= basePanels           (trim raise must not add panels)
//   2. both place every piece
//   3. new geometry valid (bounds + overlap)
//   4. new engine emits NO inner trim < 10 anywhere
// Usage: node _fuzz_trim.js [numJobs] [seed]
const Module = require('module');
const path = require('path');
const stub = require('./lib/_v2_stub');
const origReq = Module.prototype.require;

// Load NEW engine (index.js -> lib/v2packer -> v2_strip_packer.js MIN=10).
Module.prototype.require = function (name) {
  if (name === 'firebase-functions/v2/https') return stub.https;
  if (name === 'firebase-functions/v2') return { setGlobalOptions: () => {} };
  return origReq.apply(this, arguments);
};
const newImpl = require('./index.js');

// Load BASELINE engine: compile _baseline_index_full.js but redirect its
// require('./lib/v2packer') to the baseline packer (MIN=5). Fresh module so
// its internal `require` hits our hook.
const fs = require('fs');
const baseSrc = fs.readFileSync(path.join(__dirname, '_baseline_index_full.js'), 'utf8');
const baseMod = new Module(path.join(__dirname, '_baseline_index_full.js'));
baseMod.filename = path.join(__dirname, '_baseline_index_full.js');
baseMod.paths = Module._nodeModulePaths(__dirname);
baseMod.require = function (name) {
  if (name === 'firebase-functions/v2/https') return stub.https;
  if (name === 'firebase-functions/v2') return { setGlobalOptions: () => {} };
  if (name === './lib/v2packer') return require('./_baseline_v2packer.js');
  return origReq.call(baseMod, name);
};
baseMod._compile(baseSrc, baseMod.filename);
const baseImpl = baseMod.exports;
Module.prototype.require = origReq;

const sim = require('./lib/saw-simulator');

const N = parseInt(process.argv[2] || '30', 10);
const SEED = parseInt(process.argv[3] || '424242', 10);
let _s = SEED >>> 0;
const rnd = () => ((_s = (_s * 1664525 + 1013904223) >>> 0) / 4294967296);
const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

function makeJob(i) {
  const P = [[3660, 1830], [2800, 2070], [2800, 1750]];
  const [panelL, panelW] = P[ri(0, P.length - 1)];
  const trim = [10, 15][ri(0, 1)];
  const nTypes = ri(3, 20);
  const grainJob = rnd() < 0.3;
  const raw = [];
  const maxDim = Math.max(panelL, panelW) - 2 * trim - 10;
  const minP = Math.min(panelL, panelW) - 2 * trim - 10;
  for (let t = 0; t < nTypes; t++) {
    let w = ri(70, Math.min(2400, maxDim));
    let h = ri(65, Math.min(1000, minP));
    if (h > minP) h = minP;
    const grain = grainJob && rnd() < 0.5;
    const qty = ri(1, 6);
    for (let q = 0; q < qty; q++) raw.push(grain ? { w, h, grainLock: true, groupId: t + 1 } : { w, h });
  }
  return { name: `job${i} ${panelL}x${panelW} ${raw.length}p${grainJob ? ' grain' : ''}`,
           input: { panelL, panelW, panelT: 18, kerf: 4.4, trimX: trim, trimY: trim,
                    supplier: 'Fuzz', cutDir: 'auto', raw } };
}

function check(result, input) {
  const placed = result.panels.reduce((s, p) => s + p.placedCount, 0);
  let geom = true, minRu = Infinity;
  const trim = Math.max(input.trimX, input.trimY);
  for (const p of result.panels) {
    const pieces = sim.simulateSaw(p.strips, p.mode, input.panelL, input.panelW, input.kerf, trim, trim);
    if (!sim.verifyBounds(pieces, input.panelL, input.panelW).ok) geom = false;
    if (!sim.verifyNoOverlap(pieces).ok) geom = false;
    for (const st of p.strips) {
      if (p.mode === 'Y') {
        const offs = Array.isArray(st.offcuts) ? st.offcuts : st.offcut ? [{ ru: st.offcut.ru }] : [];
        for (const oc of offs) if (typeof oc.ru === 'number') minRu = Math.min(minRu, oc.ru);
      } else for (const vb of (st.vBars || [])) if (typeof vb.ru === 'number') minRu = Math.min(minRu, vb.ru);
    }
  }
  return { panels: result.panels.length, placed, geom, minRu };
}

(async () => {
  let fail = 0, moreP = 0;
  for (let i = 0; i < N; i++) {
    const { name, input } = makeJob(i);
    const total = input.raw.length;
    let rb, rn;
    try { rb = check(await baseImpl._test.runOptimizerCore(input), input); }
    catch (e) { console.log(`SKIP ${name}: baseline threw ${e.message}`); continue; }
    try { rn = check(await newImpl._test.runOptimizerCore(input), input); }
    catch (e) { console.log(`FAIL ${name}: NEW threw ${e.message}`); fail++; continue; }
    const prob = [];
    if (rn.panels > rb.panels) { prob.push(`panels ${rb.panels}->${rn.panels}`); moreP++; }
    if (rn.placed !== total || rb.placed !== total) prob.push(`placed base=${rb.placed} new=${rn.placed}/${total}`);
    if (!rn.geom) prob.push('new geometry INVALID');
    if (rn.minRu !== Infinity && rn.minRu < 10) prob.push(`new inner trim ${rn.minRu} < 10`);
    if (prob.length) { fail++; console.log(`FAIL ${name}: ${prob.join('; ')}`); }
    else console.log(`ok   ${name}: base=${rb.panels}p new=${rn.panels}p placed=${rn.placed}/${total} minTrim=${rn.minRu === Infinity ? '-' : rn.minRu}`);
  }
  console.log(`\n${N} jobs — failures: ${fail}, jobs where new used MORE panels: ${moreP}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(1); });
