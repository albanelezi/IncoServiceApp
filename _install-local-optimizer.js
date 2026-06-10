// _install-local-optimizer.js — wire the bundled Web Worker into the
// readable source HTML (INCO_Furniture_v12.src.html) and replace the
// Firebase callable invocation with a local Worker call.  No optimization
// logic changes — same input, same output, same downstream rendering.
// The Firebase function is left deployed but no longer invoked.
//
// After running this script, run `node _minify-main-script.js` to
// regenerate the deployable .html from the updated .src.html.
//
// Idempotent: re-running strips out the previous worker source + helpers
// before reinstalling.  Call-site swap is detected and skipped if already
// applied.

const fs = require('fs');
const path = require('path');

// Source of truth.  The previous version of this script wrote to
// INCO_Furniture_v12.html directly; that file is now an auto-generated
// minified copy and gets overwritten by _minify-main-script.js.  Editing
// it here would just be discarded on the next minify pass.
const HTML = path.join(__dirname, 'INCO_Furniture_v12.src.html');
// Embed the most protected bundle that exists.  Precedence:
//   .obf.js  — Terser-minified then javascript-obfuscator'd (production)
//   .min.js  — Terser-minified only (fast fallback)
//   .js      — un-minified bundle (fresh checkout / debugging)
const OBF  = path.join(__dirname, 'optimizer-worker.obf.js');
const MIN  = path.join(__dirname, 'optimizer-worker.min.js');
const RAW  = path.join(__dirname, 'optimizer-worker.js');
const WRK  = fs.existsSync(OBF) ? OBF
           : fs.existsSync(MIN) ? MIN
           : RAW;

let html = fs.readFileSync(HTML, 'utf8');
const worker = fs.readFileSync(WRK, 'utf8');
console.log('Embedding worker from:', path.basename(WRK));

// Idempotent: if a previous install left its worker source + helpers in
// place, strip them out first so the fresh bundle takes their slot
// instead of accumulating duplicates.
const oldScriptRe = /\n?<script id="inco-optimizer-worker-src"[\s\S]*?<\/script>\n?/;
if (oldScriptRe.test(html)) {
  html = html.replace(oldScriptRe, '\n');
  console.log('Removed prior <script id="inco-optimizer-worker-src"> block.');
}
const oldHelpersRe = /\/\/ ─── LOCAL OPTIMIZER WORKER[\s\S]*?worker\.postMessage\(input\);\s*\}\);\s*\}\n\n/;
if (oldHelpersRe.test(html)) {
  html = html.replace(oldHelpersRe, '');
  console.log('Removed prior _spawnOptimizerWorker / runOptimizerLocal helpers.');
}
// And the call-site swap is also reversible: the new helper call may
// already be in place from a previous run; if so, re-running below is
// a no-op (the .replace at the bottom won't match — but that's fine,
// we still want to run helper insertion & worker-tag insertion).
const callAlreadySwapped = html.includes('response = await runOptimizerLocal(fnInput);');

// ─── 1. Inject the worker source as a non-executing <script> block ────────
// `type="javascript/worker"` is an unknown MIME type so the browser parses
// the tag but does NOT execute the contents.  The runtime later wraps the
// .textContent in a Blob and spawns a real Worker from it.
const scriptTag =
  '<script id="inco-optimizer-worker-src" type="javascript/worker">\n' +
  worker +
  '\n</script>\n';

const endBodyIdx = html.lastIndexOf('</body>');
if (endBodyIdx < 0) { console.error('No </body> in HTML'); process.exit(1); }
html = html.slice(0, endBodyIdx) + scriptTag + html.slice(endBodyIdx);
console.log('Inserted worker source tag before </body> (' + (worker.length / 1024).toFixed(1) + ' KB).');

// ─── 2. Inject the spawner + runOptimizerLocal helpers above the client's
//        `runOptimizer` function (which is at the comment marker below). ────
const anchor = '// The v3 optimizer (strip-packing algorithm + WinCut .txt generator) used';
if (!html.includes(anchor)) {
  console.error('Anchor comment not found — runOptimizer location unknown.');
  process.exit(1);
}
const helpers =
'// ─── LOCAL OPTIMIZER WORKER ──────────────────────────────────────────\n' +
'// Spin a fresh Web Worker from the embedded #inco-optimizer-worker-src\n' +
'// script.  Workers are stateless, so per-call spawn is fine — and gives\n' +
'// us trivially-correct behavior when "Optimizo të gjitha" launches many\n' +
'// runs in parallel (each block gets its own worker thread).\n' +
'function _spawnOptimizerWorker() {\n' +
'  const src = document.getElementById(\'inco-optimizer-worker-src\');\n' +
'  if (!src) throw new Error(\'Optimizer worker source not found in DOM.\');\n' +
'  const blob = new Blob([src.textContent], { type: \'application/javascript\' });\n' +
'  const url  = URL.createObjectURL(blob);\n' +
'  const w    = new Worker(url);\n' +
'  // Revoke once the worker has loaded its source so the blob doesn\'t\n' +
'  // hang around in memory.  The worker keeps running fine after revoke.\n' +
'  URL.revokeObjectURL(url);\n' +
'  return w;\n' +
'}\n' +
'\n' +
'// Drop-in replacement for `functions.httpsCallable(\'runOptimizer\')(...)`.\n' +
'// Same input contract ({ panelL, panelW, panelT, kerf, trimX, trimY,\n' +
'// supplier, cutDir, raw }) and same output ({ panels: [...] }) so the\n' +
'// downstream rendering / PDF / WinCut code is unchanged.  Errors mirror\n' +
'// the FirebaseError shape (.code, .message) the call-site catch already\n' +
'// branches on, so no downstream changes needed.\n' +
'function runOptimizerLocal(input) {\n' +
'  return new Promise((resolve, reject) => {\n' +
'    let worker;\n' +
'    try { worker = _spawnOptimizerWorker(); }\n' +
'    catch (e) {\n' +
'      const err = new Error(e.message || \'Worker spawn failed\');\n' +
'      err.code = \'internal\';\n' +
'      reject(err); return;\n' +
'    }\n' +
'    worker.onmessage = (ev) => {\n' +
'      const m = ev.data || {};\n' +
'      worker.terminate();\n' +
'      if (m.type === \'result\') {\n' +
'        resolve(m.result);\n' +
'      } else {\n' +
'        const err = new Error(m.message || \'Optimizimi dështoi.\');\n' +
'        err.code = m.code || \'internal\';\n' +
'        reject(err);\n' +
'      }\n' +
'    };\n' +
'    worker.onerror = (ev) => {\n' +
'      worker.terminate();\n' +
'      const err = new Error(ev.message || \'Worker crashed\');\n' +
'      err.code = \'internal\';\n' +
'      reject(err);\n' +
'    };\n' +
'    worker.postMessage(input);\n' +
'  });\n' +
'}\n' +
'\n';

html = html.replace(anchor, helpers + anchor);
console.log('Inserted _spawnOptimizerWorker + runOptimizerLocal helpers above runOptimizer.');

// ─── 3. Swap the Firebase callable for the local worker invocation. ──────
const oldCall =
"      const fnInput = { panelL, panelW, panelT, kerf, trimX, trimY, supplier, cutDir, raw };\n" +
"      const callable = functions.httpsCallable('runOptimizer', { timeout: 540000 });\n" +
"      const result = await callable(fnInput);\n" +
"      response = result.data;";
const newCall =
"      const fnInput = { panelL, panelW, panelT, kerf, trimX, trimY, supplier, cutDir, raw };\n" +
"      // Local in-browser Web Worker (bundle in #inco-optimizer-worker-src).\n" +
"      // Drop-in replacement for the previous functions.httpsCallable call.\n" +
"      // The server-side function (functions/index.js → runOptimizer) is\n" +
"      // left deployed but no longer invoked from the client.\n" +
"      response = await runOptimizerLocal(fnInput);";

if (callAlreadySwapped) {
  console.log('Call site already on runOptimizerLocal — skipping swap.');
} else if (!html.includes(oldCall)) {
  console.error('Old Firebase callable block not found verbatim.  Manual fix required.');
  process.exit(1);
} else {
  html = html.replace(oldCall, newCall);
  console.log('Swapped Firebase callable for runOptimizerLocal at the call site.');
}

fs.writeFileSync(HTML, html);
console.log('Wrote ' + HTML + ' (' + (html.length / 1024).toFixed(1) + ' KB).');
