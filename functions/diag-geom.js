// Dump exact piece coords + free-rectangle map of every panel.
const Module = require('module');
const origReq = Module.prototype.require;
Module.prototype.require = function(name) {
  if (name === 'firebase-functions/v2/https') return { onCall:(o,fn)=>fn, HttpsError: class extends Error {constructor(c,m){super(m);this.code=c;}} };
  if (name === 'firebase-functions/v2') return { setGlobalOptions:()=>{} };
  return origReq.apply(this, arguments);
};
const newImpl = require('./index.js');
Module.prototype.require = origReq;
const { simulateSaw } = require('./lib/saw-simulator.js');

const input = {
  panelL: 2800, panelW: 2070, panelT: 18,
  kerf: 4.4, trimX: 15, trimY: 15,
  supplier: 'Test', cutDir: 'auto',
  raw: [
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
  ],
};

(async () => {
  const r = await newImpl._test.runOptimizerCore(input);
  const { panelL, panelW, kerf, trimX, trimY } = input;
  const trim = Math.max(trimX, trimY);

  for (let i = 0; i < r.panels.length; i++) {
    const p = r.panels[i];
    const sim = simulateSaw(p.strips, p.mode, panelL, panelW, kerf, trim, trim);
    const placedArea = sim.reduce((s,pl)=>s+pl.w*pl.h, 0);
    const eff = placedArea / (panelL*panelW) * 100;
    console.log(`\n==== Panel ${i+1} (${p.mode}, eff=${eff.toFixed(1)}%) ====`);
    // Sort by x then y
    sim.sort((a,b) => a.x - b.x || a.y - b.y);
    for (const pl of sim) {
      console.log(`  ${pl.w.toString().padStart(5)}×${pl.h.toString().padStart(4)} @ (${pl.x.toFixed(1).padStart(7)}, ${pl.y.toFixed(1).padStart(7)})  end=(${(pl.x+pl.w).toFixed(1)}, ${(pl.y+pl.h).toFixed(1)})`);
    }
    // Compute axis-aligned bounding box of placed pieces
    if (sim.length) {
      const minX = Math.min(...sim.map(p=>p.x));
      const minY = Math.min(...sim.map(p=>p.y));
      const maxX = Math.max(...sim.map(p=>p.x+p.w));
      const maxY = Math.max(...sim.map(p=>p.y+p.h));
      console.log(`  bbox: x=[${minX.toFixed(1)}, ${maxX.toFixed(1)}]  y=[${minY.toFixed(1)}, ${maxY.toFixed(1)}]`);
      console.log(`  panel: 0..${panelL} x 0..${panelW}`);
      console.log(`  empty right strip: ${(panelL - maxX).toFixed(1)}mm wide`);
      console.log(`  empty top strip:   ${(panelW - maxY).toFixed(1)}mm tall`);
    }
  }
})().catch(e => { console.error(e.stack); process.exit(1); });
