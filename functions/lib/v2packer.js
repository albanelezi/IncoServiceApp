// Loads v2_strip_packer.js with its firebase glue stripped, and re-exports
// the strip-packing helpers used by the new pipeline. The `runOptimizerCore`
// in v2 is no longer the entry point — it remains exported for legacy/local
// debugging only.
//
// Helpers we need: consolidate, generateCandidates, rowsX, rowsY,
// genFileContent.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const v2Path = path.join(__dirname, '..', 'v2_strip_packer.js');
let src = fs.readFileSync(v2Path, 'utf8');

src = src
  .replace(/^const \{ onCall.*$/m, '// stripped')
  .replace(/^const \{ setGlobalOptions.*$/m, '// stripped')
  .replace(/setGlobalOptions\([\s\S]*?\}\);/, '// stripped')
  .replace(/exports\.runOptimizer = onCall\([\s\S]*?\}\s*\);/, '// stripped')
  .replace(
    /exports\._test = .*$/m,
    'module.exports = { runOptimizerCore, consolidate, generateCandidates, rolloutFrom, rowsX, rowsY, genFileContent, packXGreedy, packYGreedy, fitYStripOffcuts };'
  );

const m = new Module(v2Path);
m.filename = v2Path;
m.paths = Module._nodeModulePaths(path.dirname(v2Path));
m._compile(src, v2Path);

module.exports = m.exports;
