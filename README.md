# INCO Furniture — Project Snapshot

## Architecture (v4, May 2026)

The optimizer runs **in-browser** as a Web Worker embedded in
`INCO_Furniture_v12.html`. There is no Cloud Functions round-trip on the
optimizer hot path. Cloud Functions remains as an alternative deployment
target via `functions/index.js`'s `runOptimizer` callable.

The pipeline is **strip-native end-to-end**:

```
raw pieces
    │
    ▼
consolidate (v2_strip_packer.js)         types[]
    │
    ▼
generateCandidates (v2_strip_packer.js)  WinCut-format candidates
    │                                    {mode, strips, eff, ...}
    ├── small/medium input ──► dominanceFilter ──► setCoverBB ──► trim over-cover
    │   (≤8 types, LB ≤ 10)   (algorithm.js)     (algorithm.js)
    │
    └── big input ──────────► greedyPack (panel-by-panel, fastMode)
        (>8 types or LB > 10)
    │
    ▼
rowsX/rowsY + genFileContent (v2_strip_packer.js)  WinCut .txt rows
    │
    ▼
{ panels: [{ strips, mode, rows, content, eff, placedCount }, ...] }
```

Why this design:

* **Candidates are WinCut-native from generation.** No coordinate-level
  packing, no strip extractor, no fallback re-pack. The `strips` field of
  each picked candidate is what the saw consumes — directly.
* **Two strategies, one format.** B&B set-cover for small/medium inputs
  (optimal under candidate set, ≤ a few seconds). Greedy panel-by-panel
  for big inputs (where B&B's branching factor at depth 30+ is
  intractable).
* **`fastMode` skips the exponential `allStripWidthCombos` enumeration**
  for >8 piece types, where the combinatorial explosion (30^maxStrips
  paths) would otherwise hang. `packXGreedy + packYGreedy +
  addSharedDimensionCandidates` produce ~5-10 strong candidates per call,
  enough for greedy to make a good per-panel choice.

## Structure

```
inco-deploy/
├── INCO_Furniture_v12.html        ← The deployed app. Open in a browser.
├── optimizer-worker.js            ← Bundled in-browser worker (also
│                                    embedded in the HTML).
├── bundle-worker.js               ← Build script. Run with `node bundle-worker.js`.
├── firebase.json                  ← Firebase project config (hosting + functions).
├── .firebaserc                    ← Firebase project alias. EDIT THIS — see below.
└── functions/
    ├── index.js                   ← v4 orchestration (B&B + greedy + WinCut output).
    ├── package.json               ← Firebase Functions config (Node 20).
    ├── v2_strip_packer.js         ← Strip-native candidate generator.
    │                                Supports fastMode for big inputs.
    ├── test-equivalence.js        ← 7 parity benchmarks (Tests 1-6 vs Cutty,
    │                                Test 7 = 30-type production stress).
    ├── verify-cuts.js             ← Cut-correctness check for every panel.
    └── lib/
        ├── algorithm.js           ← setCoverBB + dominanceFilter (only).
        ├── v2packer.js            ← Loader shim for v2_strip_packer (strips
        │                            firebase glue at require time).
        ├── _v2_stub.js            ← Firebase mock for local tests.
        └── saw-simulator.js       ← Cut sequence simulator (verify-cuts uses it).
```

## First-time setup

1. Install Node.js (you probably already have it).
2. Install the Firebase CLI:  `npm install -g firebase-tools`
3. Authenticate once:           `firebase login`
4. **Edit `.firebaserc`**: replace `REPLACE_WITH_YOUR_FIREBASE_PROJECT_ID` with your real project ID.
5. Install Functions deps (only needed if you'll deploy functions):
   ```
   cd functions
   npm install
   cd ..
   ```

## Deploy

The optimizer runs **in-browser** (embedded in the HTML), so for the optimizer
itself you don't need Cloud Functions anymore.

* Deploy only the HTML (recommended):  `firebase deploy --only hosting`
* Deploy only functions (legacy):      `firebase deploy --only functions`
* Deploy everything:                   `firebase deploy`

## Run / verify locally (no Firebase needed)

```
cd functions
node test-equivalence.js     # expect: 7/7 pass
node verify-cuts.js          # expect: all panels valid
```

Both tests use a stub (`lib/_v2_stub.js`) to fake the Firebase imports.

## Re-bundle the in-browser worker

If you change anything under `functions/`, regenerate the embedded worker:

```
node bundle-worker.js          # writes optimizer-worker.js
node _embed-worker.js          # if you have it; or paste optimizer-worker.js
                               #   into INCO_Furniture_v12.html's
                               #   <script id="inco-optimizer-worker-src"> block
```

The bundle script verifies that the output contains no `require()`,
`module.exports`, firebase references, or references to deleted modules
(strip-extractor, strip-renderer). Build fails fast if any leak in.

## Status (May 2026 v4 snapshot)

* 7/7 parity benchmarks pass.
* All panels cut-correct under saw simulation.
* Test 7 (30-type production-style 131-piece input): **12 panels in ~4
  seconds**, vs. the prior pipeline's 5-minute hang.
* Test 6 caps at 7 panels (Cutty achieves 6 with patterns the current
  candidate generator doesn't yet emit — multi-strip Y with U* offcut
  and tight RU/RV trims). Acceptable cap; closing this requires
  enriching v2's `packPanelYWithHeightsAll` height-schedule choices.
* Bundle is 75.5 KB (down from 157 KB).
