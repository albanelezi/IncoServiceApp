// Smoke-test the classic optimizer (Gilmore-Gomory) on Kurti1 and Kurti2.
// Loads the runClassicOptimizer + helpers from the HTML so we test the
// EXACT code that runs in the browser.
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'INCO_Furniture_v12.html'), 'utf8'
);

function extractFn(name) {
  // Match either `function NAME(...)` or `const NAME = (...)`
  const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`, 'm');
  const m = html.match(re);
  if (!m) throw new Error(`Could not find function ${name}`);
  return m[0];
}

const src = [
  extractFn('knapsack1DClassic'),
  extractFn('optimizePanelClassic'),
  extractFn('optimizeJobClassic'),
  extractFn('writeSawProgramClassic'),
  extractFn('runClassicOptimizer'),
  'module.exports = { runClassicOptimizer };'
].join('\n\n');

const m = new (require('module'))('classic-virt');
m.filename = 'classic-virt';
m._compile(src, 'classic-virt');
const { runClassicOptimizer } = m.exports;

function piece(w, h, qty) {
  return Array.from({length: qty}, () => ({ w, h }));
}

// Kurti1 (60 pieces, panel 3660×1830)
const kurti1Raw = [
  ...piece(2922, 350, 1), ...piece(2685, 530, 4), ...piece(550, 160, 8),
  ...piece(1300, 195, 1), ...piece(1760, 140, 1), ...piece(1760, 97, 1),
  ...piece(1205, 140, 2), ...piece(2100, 140, 1), ...piece(600, 270, 2),
  ...piece(210, 215, 2), ...piece(600, 137, 3), ...piece(600, 143, 1),
  ...piece(765, 194, 1), ...piece(575, 195, 2), ...piece(770, 575, 2),
  ...piece(600, 770, 2), ...piece(710, 320, 2), ...piece(2692, 70, 6),
  ...piece(1400, 356, 2), ...piece(377, 265, 3), ...piece(2692, 799, 1),
  ...piece(2692, 950, 1), ...piece(2692, 430, 1), ...piece(2692, 200, 1),
  ...piece(2332, 400, 2), ...piece(2670, 585, 2), ...piece(2517, 420, 3),
  ...piece(2920, 560, 1), ...piece(1697, 497, 1),
];

// Kurti2 (50 pieces, panel 2800×2100)
const kurti2Raw = [
  ...piece(2157, 340, 2), ...piece(2157, 332, 2), ...piece(247, 863, 1),
  ...piece(247, 848, 1), ...piece(2250, 477, 4), ...piece(832, 477, 4),
  ...piece(817, 477, 4), ...piece(250, 477, 4), ...piece(832, 455, 1),
  ...piece(817, 455, 1), ...piece(832, 450, 4), ...piece(817, 450, 4),
  ...piece(2600, 100, 4), ...piece(866, 100, 1), ...piece(851, 100, 1),
  ...piece(2232, 848, 1), ...piece(232, 848, 1), ...piece(2232, 833, 1),
  ...piece(851, 100, 1), ...piece(440, 140, 4), ...piece(784, 120, 1),
  ...piece(769, 120, 1), ...piece(448, 800, 1), ...piece(448, 785, 1),
];

function runOne(label, panelL, panelW, panelT, kerf, trim, raw) {
  const t0 = Date.now();
  const r = runClassicOptimizer({
    panelL, panelW, panelT, kerf, trimX: trim, trimY: trim,
    supplier: 'INCO - Group', cutDir: 'auto', raw,
  });
  const ms = Date.now() - t0;
  const placed = r.panels.reduce((s, p) => s + p.placedCount, 0);
  const totalArea = raw.reduce((s, p) => s + p.w * p.h, 0);
  const matArea = r.panels.length * panelL * panelW;
  const eff = (totalArea / matArea * 100).toFixed(1);
  console.log(`\n${label}: ${r.panels.length} panels, ${placed}/${raw.length} placed, ${eff}% overall, ${ms}ms`);
  for (let i = 0; i < r.panels.length; i++) {
    const p = r.panels[i];
    console.log(`  Panel ${i+1}: ${p.strips.length} strips, ${p.placedCount} pcs, ${p.eff}%`);
  }
  // Quick sanity: content has the expected sections
  const c0 = r.panels[0]?.content || '';
  const ok = c0.includes('[Intestazione]') && c0.includes('[Righe]') && c0.includes('[Dati]') && c0.includes('[Riferimenti]');
  console.log(`  WinCut content: ${ok ? '✓' : '✗ MALFORMED'}`);
}

runOne('KURTI1 (60 pcs, 3660×1830)', 3660, 1830, 16, 4.4, 10, kurti1Raw);
runOne('KURTI2 (50 pcs, 2800×2100)', 2800, 2100, 25, 4.4, 10, kurti2Raw);
