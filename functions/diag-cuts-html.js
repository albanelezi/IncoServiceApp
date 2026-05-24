// Verify cutsY/cutsX produce non-empty cut segments for a real Kurti panel.
// Pulls the functions out of the HTML file via regex extraction so we test
// the EXACT code that ships in INCO_Furniture_v12.html.
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'INCO_Furniture_v12.html'), 'utf8'
);

// Extract cutsY and cutsX function bodies from HTML
function extractFn(name) {
  const re = new RegExp(`function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`, 'm');
  const m = html.match(re);
  if (!m) throw new Error(`Could not find ${name} in HTML`);
  return m[0];
}

// Build an evaluable snippet: the two cuts functions in a sandbox.
const src = extractFn('cutsY') + '\n' + extractFn('cutsX') +
            '\nmodule.exports = { cutsY, cutsX };';
const m = new (require('module'))('cuts-virt');
m.filename = 'cuts-virt';
m._compile(src, 'cuts-virt');
const { cutsY, cutsX } = m.exports;

// Sample Kurti1 P1 strips (Y-mode, 2 strips, 7 pieces — real output from greedy)
const sampleY = [
  { stripH: 950, primaryCuts: [{ typeId: 23, pw: 2692, ph: 950, qty: 1 }],
    offcuts: [
      { xPw: 600, ru: 15, uCuts: [{ typeId: 17, uPh: 770, uQty: 1 }, { typeId: 13, uPh: 143, uQty: 1 }] },
      { xPw: 320, ru: 15, uCuts: [{ typeId: 18, uPh: 710, uQty: 1 }] },
    ]},
  { stripH: 799, primaryCuts: [{ typeId: 22, pw: 2692, ph: 799, qty: 1 }],
    offcuts: [
      { xPw: 600, ru: 15, uCuts: [{ typeId: 17, uPh: 770, uQty: 1 }] },
      { xPw: 320, ru: 15, uCuts: [{ typeId: 18, uPh: 710, uQty: 1 }] },
    ]},
];

const cuts = cutsY(sampleY, 15, 15, 4.4, 3660, 1830);
console.log(`cutsY produced ${cuts.length} cut segments:`);
console.log('First 10:');
for (const c of cuts.slice(0, 10)) {
  if (c.h) console.log(`  h-cut at y=${c.y.toFixed(1)} from x=${c.x1.toFixed(1)} to x=${c.x2.toFixed(1)}`);
  else console.log(`  v-cut at x=${c.x.toFixed(1)} from y=${c.y1.toFixed(1)} to y=${c.y2.toFixed(1)}`);
}

// Quick sanity: every coord should be within [0, panelL] / [0, panelW] roughly.
for (const c of cuts) {
  if (c.h) {
    if (c.y < -1 || c.y > 1831 || c.x1 < 0 || c.x2 > 3661) {
      console.log('OUT OF BOUNDS h-cut:', c);
    }
  } else {
    if (c.x < 0 || c.x > 3661 || c.y1 < -1 || c.y2 > 1831) {
      console.log('OUT OF BOUNDS v-cut:', c);
    }
  }
}
console.log('\n✓ All cuts within panel bounds');

// X-mode sample
const sampleX = [
  { stripW: 2685, typeId: 2, uPh: 530, uQty: 3, ru: 15, vBars: [
    { typeId: 8, barH: 140, vPw: 1205, vQty: 2, ru: 15 }
  ]},
  { stripW: 356, typeId: 19, uPh: 1400, uQty: 1, ru: 15, vBars: [] },
];
const cutsXOut = cutsX(sampleX, 15, 15, 4.4, 3660, 1830);
console.log(`\ncutsX produced ${cutsXOut.length} cut segments`);
