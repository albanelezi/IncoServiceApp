// Verify the rotation bonus surfaces rotated layouts on balanced datasets.
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(
  path.join(__dirname, '..', 'INCO_Furniture_v12.html'), 'utf8'
);
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
const m = new (require('module'))('rot-virt');
m.filename = 'rot-virt';
m._compile(src, 'rot-virt');
const { runClassicOptimizer } = m.exports;

const raw = [
  ...Array.from({length:6}, () => ({w: 600, h: 400})),
  ...Array.from({length:4}, () => ({w: 700, h: 300})),
  ...Array.from({length:3}, () => ({w: 500, h: 500})),
];
const r = runClassicOptimizer({
  panelL: 1500, panelW: 1000, panelT: 18,
  kerf: 4.4, trimX: 10, trimY: 10,
  supplier: 'Test', cutDir: 'auto', raw,
});
console.log(`Panels: ${r.panels.length}`);
for (let i = 0; i < r.panels.length; i++) {
  const p = r.panels[i];
  console.log(`P${i+1}: ${p.strips.length} strips, ${p.placedCount} pcs, eff=${p.eff}%`);
  for (const st of p.strips) {
    const desc = st.primaryCuts.map(c => `${c.qty}×${c.pw}×${c.ph}`).join(' + ');
    console.log(`  Y=${st.stripH}: ${desc}`);
  }
}
