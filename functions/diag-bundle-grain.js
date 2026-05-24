// Run grain tests against the BUNDLED worker (optimizer-worker.js) rather
// than the live source — verifies the bundle is in sync.
const fs = require('fs');
const path = require('path');

const bundleSrc = fs.readFileSync(
  path.join(__dirname, '..', 'optimizer-worker.js'), 'utf8'
);

// Wrap as a fake-worker module: shim `self`, then expose runOptimizerCore.
const wrapper = `
  const self = { onmessage: null, postMessage: () => {} };
  ${bundleSrc}
  module.exports = { runOptimizerCore };
`;
const m = new (require('module'))('bundle-virt');
m.filename = 'bundle-virt';
m.paths = require('module')._nodeModulePaths(__dirname);
m._compile(wrapper, 'bundle-virt');
const { runOptimizerCore } = m.exports;

async function testCase(label, raw, expectPanels) {
  const input = {
    panelL: 2800, panelW: 2070, panelT: 18,
    kerf: 4.4, trimX: 15, trimY: 15,
    supplier: 'Test', cutDir: 'auto', raw,
  };
  const r = await runOptimizerCore(input);
  const ok = r.panels.length === expectPanels;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${r.panels.length} panel(s), expected ${expectPanels}`);
  return ok;
}

(async () => {
  let pass = 0, total = 0;
  // T1: 4× grain in 1 panel
  total++; if (await testCase('grain single panel', [
    {w:600, h:300, grainLock:true, groupId:1},
    {w:600, h:300, grainLock:true, groupId:1},
    {w:600, h:300, grainLock:true, groupId:1},
    {w:600, h:300, grainLock:true, groupId:1},
  ], 1)) pass++;

  // T2: spillover 12× → 2 panels
  total++; if (await testCase('grain spillover', [
    ...Array.from({length:12}, () => ({w:1200, h:400, grainLock:true, groupId:1})),
  ], 2)) pass++;

  // T3: mixed h grain (smaller-h-at-bottom rule)
  total++; if (await testCase('grain mixed h', [
    {w:600, h:500, grainLock:true, groupId:2},
    {w:600, h:500, grainLock:true, groupId:2},
    {w:600, h:200, grainLock:true, groupId:1},
    {w:600, h:200, grainLock:true, groupId:1},
  ], 1)) pass++;

  // T4: regression — non-grain stress run (improved from 12 to 11 after
  // multi sub-strip + adaptive ru + eff-first scoring).
  total++; if (await testCase('regression: non-grain stress', [
    ...Array.from({length:2},  ()=>({w:2698, h:585})),
    ...Array.from({length:4},  ()=>({w:2100, h:565})),
    ...Array.from({length:4},  ()=>({w:1800, h:565})),
    ...Array.from({length:2},  ()=>({w:1700, h:1005})),
    ...Array.from({length:2},  ()=>({w:1405, h:656})),
    ...Array.from({length:4},  ()=>({w:1251, h:1006})),
    ...Array.from({length:2},  ()=>({w:1200, h:901})),
    ...Array.from({length:2},  ()=>({w:1200, h:450})),
    ...Array.from({length:8},  ()=>({w:980,  h:565})),
    ...Array.from({length:4},  ()=>({w:980,  h:537})),
    ...Array.from({length:4},  ()=>({w:901,  h:800})),
    ...Array.from({length:2},  ()=>({w:906,  h:450})),
    ...Array.from({length:6},  ()=>({w:880,  h:458})),
    ...Array.from({length:4},  ()=>({w:780,  h:565})),
    ...Array.from({length:2},  ()=>({w:2577, h:505})),
    ...Array.from({length:6},  ()=>({w:2000, h:200})),
    ...Array.from({length:1},  ()=>({w:1706, h:418})),
    ...Array.from({length:2},  ()=>({w:1200, h:97})),
    ...Array.from({length:4},  ()=>({w:858,  h:101})),
    ...Array.from({length:6},  ()=>({w:906,  h:80})),
    ...Array.from({length:3},  ()=>({w:2000, h:73})),
    ...Array.from({length:8},  ()=>({w:565,  h:565})),
    ...Array.from({length:4},  ()=>({w:480,  h:565})),
    ...Array.from({length:4},  ()=>({w:472,  h:565})),
    ...Array.from({length:7},  ()=>({w:398,  h:450})),
    ...Array.from({length:4},  ()=>({w:398,  h:80})),
    ...Array.from({length:12}, ()=>({w:398,  h:65})),
    ...Array.from({length:12}, ()=>({w:390,  h:121})),
    ...Array.from({length:2},  ()=>({w:350,  h:101})),
    ...Array.from({length:4},  ()=>({w:177,  h:902})),
    ...Array.from({length:2},  ()=>({w:177,  h:394})),
    ...Array.from({length:20}, ()=>({w:100,  h:100})),
  ], 11)) pass++;

  console.log(`\n${pass}/${total} bundle tests passed`);
  process.exit(pass === total ? 0 : 1);
})().catch(e => { console.error(e.stack); process.exit(1); });
