// Helper: embed optimizer-worker.js into INCO_Furniture_v12.html's
// <script id="inco-optimizer-worker-src"> block. Uses an anchored regex
// so the JS comments at lines ~7396, ~7485 (which mention the literal
// tag string in a // comment) don't accidentally match.
//
// Run after `node bundle-worker.js`:
//   node _embed-worker.js
//
// Idempotent. Edits the HTML in place.

const fs = require('fs');

const path = 'INCO_Furniture_v12.html';
const html = fs.readFileSync(path, 'utf8');
const bundle = fs.readFileSync('optimizer-worker.js', 'utf8');

const OPEN = '<script id="inco-optimizer-worker-src" type="javascript/worker">';
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const re = new RegExp(
  '^(' + escapeRe(OPEN) + ')\\n[\\s\\S]*?\\n(<\\/script>)',
  'm'
);

const matches = html.match(re);
if (!matches) {
  console.error('No match for the anchored worker tag block.');
  console.error('Is the <script id="inco-optimizer-worker-src" type="javascript/worker"> tag at column 0?');
  process.exit(1);
}

const out = html.replace(re, matches[1] + '\n' + bundle + '\n' + matches[2]);
fs.writeFileSync(path, out);
console.log(`Embedded optimizer-worker.js (${bundle.length} chars) into ${path}.`);
console.log(`html size: ${html.length} → ${out.length} chars.`);
