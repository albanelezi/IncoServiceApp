// Baseline v2packer: identical loader to lib/v2packer.js but compiles the
// PRE-CHANGE strip packer (_baseline_v2_strip_packer.js, MIN_INNER_TRIM=5),
// so the fuzz A/B can compare old-trim vs new-trim engines in one process.
const fs = require('fs');
const path = require('path');
const Module = require('module');

const v2Path = path.join(__dirname, '_baseline_v2_strip_packer.js');
let src = fs.readFileSync(v2Path, 'utf8');
src = src
  .replace(/^const \{ onCall.*$/m, '// stripped')
  .replace(/^const \{ setGlobalOptions.*$/m, '// stripped')
  .replace(/setGlobalOptions\([\s\S]*?\}\);/, '// stripped')
  .replace(/exports\.runOptimizer = onCall\([\s\S]*?\}\s*\);/, '// stripped')
  .replace(
    /exports\._test = .*$/m,
    'module.exports = { runOptimizerCore, consolidate, generateCandidates, rolloutFrom, rowsX, rowsY, genFileContent, packXGreedy, packYGreedy, fitYStripOffcuts, buildYCandidate };'
  );
const m = new Module(v2Path);
m.filename = v2Path;
m.paths = Module._nodeModulePaths(path.dirname(v2Path));
m._compile(src, v2Path);
module.exports = m.exports;
