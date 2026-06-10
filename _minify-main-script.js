// _minify-main-script.js — read the readable INCO_Furniture_v12.src.html,
// Terser-minify only its main inline <script> block, write the result to
// INCO_Furniture_v12.html (the file Firebase Hosting actually serves).
//
// Workflow:
//   1. ALL EDITS go to INCO_Furniture_v12.src.html.
//   2. Run `node _minify-main-script.js` before deploy.
//   3. `firebase deploy --only hosting` ships the generated .html.
//
// What gets touched:
//   * The main inline <script>…</script> block — between the </div> just
//     after the <body> markup and the optimizer worker bundle at the
//     bottom — is Terser-minified.
//
// What is LEFT ALONE:
//   * External <script src="..."> tags (Firebase SDKs, pdf.js, etc.)
//   * The <script id="inco-optimizer-worker-src"> bundle at the bottom
//     (already Terser-minified then obfuscated by bundle-worker.js)
//
// Terser settings:
//   * --compress passes=2
//   * --mangle (WITHOUT toplevel=true) — keeps top-level function and var
//     names intact, so onclick="goPage(...)" attributes in the rendered
//     HTML strings still resolve at runtime.  Only local-scope identifiers
//     get shortened.
//   * --format comments=false — strips comments.
//
// Console.log calls are PRESERVED.  Future debugging on production is
// worth more than the few kilobytes those calls cost.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const SRC  = path.join(__dirname, 'INCO_Furniture_v12.src.html');
const HTML = path.join(__dirname, 'INCO_Furniture_v12.html');
const SENT = '/*M*/';

if (!fs.existsSync(SRC)) {
  console.error('Source HTML not found:', SRC);
  console.error('  The build pipeline reads the readable source from .src.html');
  console.error('  and writes the minified deployable to .html.');
  process.exit(1);
}
let html = fs.readFileSync(SRC, 'utf8');

// Use anchored markers around the main inline script — the HTML has many
// other <script> tags (Firebase SDKs, the worker bundle).  Anchor on the
// preceding </div> + blank line so we only match THIS one.
const OPEN  = '</div>\n\n<script>\n';
const CLOSE = '\n</script>\n<script id="inco-optimizer-worker-src"';

const openIdx = html.indexOf(OPEN);
if (openIdx < 0) { console.error('Main <script> open marker not found.'); process.exit(1); }
const scriptStart = openIdx + OPEN.length;
const scriptEnd   = html.indexOf(CLOSE, scriptStart);
if (scriptEnd < 0) { console.error('Main <script> close marker not found.'); process.exit(1); }

const before  = html.slice(0, scriptStart);
const code    = html.slice(scriptStart, scriptEnd);
const after   = html.slice(scriptEnd);

if (code.startsWith(SENT)) {
  console.error('Source file already starts with the /*M*/ sentinel — this');
  console.error('looks like a minified file mistakenly committed as .src.html.');
  console.error('Restore the readable source before running this script.');
  process.exit(1);
}

console.log('Original main script:', (code.length / 1024).toFixed(1), 'KB');

// Stream the code to Terser via a temp file (avoids stdin/quoting issues
// on Windows with a 460KB+ payload).
const tmpIn  = path.join(os.tmpdir(), 'inco-main-in.js');
const tmpOut = path.join(os.tmpdir(), 'inco-main-out.js');
fs.writeFileSync(tmpIn, code);
try {
  execFileSync('npx', [
    '--yes', 'terser',
    tmpIn,
    '--compress', 'passes=2',
    '--mangle',
    '--format', 'comments=false',
    '--output', tmpOut,
  ], { stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
} catch (e) {
  console.error('Terser failed:', e.message);
  process.exit(1);
}

const minified = SENT + fs.readFileSync(tmpOut, 'utf8');
fs.unlinkSync(tmpIn);
fs.unlinkSync(tmpOut);

console.log('Minified main script: ', (minified.length / 1024).toFixed(1), 'KB',
            `(${(100 - 100 * minified.length / code.length).toFixed(1)}% smaller)`);

fs.writeFileSync(HTML, before + minified + after);
console.log('Wrote', path.basename(HTML), '—',
            (Buffer.byteLength(before + minified + after) / 1024).toFixed(1), 'KB total');
