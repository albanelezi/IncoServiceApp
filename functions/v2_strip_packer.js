// ═══════════════════════════════════════════════════════════════════════
// INCO Furniture — Server-Side Optimizer v2 (multi-strategy)
// ═══════════════════════════════════════════════════════════════════════
//
// SAME I/O CONTRACT AS v1:
//   input  = { panelL, panelW, panelT, kerf, trimX, trimY,
//              supplier, cutDir, raw: [{w,h}, ...] }
//   output = { panels: [{ strips, mode, rows, content, eff, placedCount }] }
//
// The client (visX, visY, drawCanvas, runOptimizer wrapper) and the WinCut
// .txt format are UNCHANGED. Only the algorithm changed.
//
// What's new vs v1:
//   1. Best-of-many candidate layouts per panel. v1 ran one greedy pass;
//      v2 runs ~30+ different strategies and picks the densest.
//   2. Mixed strip-width planning. v1's packX is greedy by remaining-space;
//      v2 enumerates strip-width combinations to find better packings (e.g.
//      "3×600 + 2×400" vs "4×600+leftover" — fixes test 2).
//   3. Cross-panel scheme reuse. After packing a panel, if the same layout
//      can be applied again to remaining pieces, it's tried first (fixes
//      test 5's reuse pattern).
//
// All output structure (strips[], rows[]) matches v1's shape so visX/visY
// keep working without a client change.
// ═══════════════════════════════════════════════════════════════════════

// Minimum trim allowed inside a strip's sub-strip (RU/RV). The panel-edge
// trim (RX/RY) is the user-set value (typically 15 mm). Inside a strip the
// saw can run a tighter trim — Cutty drops to 1.5-5 mm on dense panels —
// because the sub-strip is already separated from the panel edge. We use
// 5 mm as a conservative minimum that's well above the saw operator's safe
// floor (2.4 mm per the original spec). The default RU stays at trimSub
// (= panel-edge trim) and only drops to MIN_INNER_TRIM when a piece would
// otherwise not fit, mirroring Cutty's "default + dynamic shrink" behavior.
const MIN_INNER_TRIM = 5;

// Return the orientation pairs to try for a piece. Grain-locked pieces are
// pinned to W-along-X (the first dimension always), per the "Ruaj Ujerat"
// rule that the wood pattern direction must be preserved. Non-grain pieces
// try both orientations so the packer can rotate to fit.
//
// This single helper replaces the open-coded `[[t.w, t.h], [t.h, t.w]]`
// pattern across every packer/fitter, so grain compliance is uniform.
function orientations(t) {
  if (t.grainLock) return [[t.w, t.h]];
  return [[t.w, t.h], [t.h, t.w]];
}

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');

setGlobalOptions({
  region:         'europe-west1',
  memory:         '512MiB',           // bumped from 256: candidate search is ram-light but safer
  // 540s matches the client httpsCallable timeout (INCO_Furniture_v12.html:
  // `functions.httpsCallable('runOptimizer', { timeout: 540000 })`). Previously
  // the function hard-killed at 60s while the client still waited up to 540s,
  // so any material whose distinct-dim count pushed it past 60s would silently
  // fail with deadline-exceeded — even though the algorithm could have finished
  // a few seconds later. Raising the function ceiling does NOT change algorithm
  // behavior (no quality regression): the optimizer runs the same candidate
  // search / rollout regardless of the timeout; the timeout only governs when
  // the runtime hard-kills the process.
  timeoutSeconds: 540,
  maxInstances:   10,
  // Keep one container warm so the FIRST optimize call after an idle period
  // doesn't pay the 5-10s Node cold-start tax. Additional parallel calls (up
  // to maxInstances=10) still spin up on demand. Algorithm/output unaffected.
  minInstances:   1,
});

// ─────────────────────────────────────────────────────────────────────
// Utilities (verbatim from v1 — kept identical for safety)
// ─────────────────────────────────────────────────────────────────────
function consolidate(raw){
  const t=[];
  for(const p of raw){
    const grain = !!p.grainLock;
    const grp = grain ? (p.groupId ?? 0) : null;
    const align = (grain && p.alignGroup) ? p.alignGroup : null;
    let e;
    if (grain) {
      // Grain-locked: orientation is fixed (W stays on X axis), no rotation
      // merge. Different grain groups OR different alignGroup tags are
      // different types even if dimensions match (so the optimizer can
      // route them into separate aligned columns).
      e = t.find(x => x.grainLock && x.groupId === grp &&
                        x.alignGroup === align &&
                        x.w === p.w && x.h === p.h);
    } else {
      e = t.find(x => !x.grainLock &&
                       ((x.w === p.w && x.h === p.h) || (x.w === p.h && x.h === p.w)));
    }
    if (e) { e.rem++; e.total++; }
    else t.push({
      w: p.w, h: p.h, rem: 1, total: 1, id: t.length + 1,
      grainLock: grain, groupId: grp,
      alignGroup: align,
    });
  }
  return t;
}
function cp(a){return a.map(t=>({...t}));}

// ─────────────────────────────────────────────────────────────────────
// LOW-LEVEL STRIP PACKERS
// ─────────────────────────────────────────────────────────────────────
//
// A "strip" is a horizontal or vertical band cut across the panel. v2 keeps
// the same data shape v1 used (so rowsX / rowsY / vis output is unchanged)
// but adds a strip-width-set planner on top.
//
// Y-strip = horizontal band of height stripH, sliced with X-cuts to extract
//           pieces lined up along its length.
// X-strip = vertical band of width stripW, sliced with U-cuts (and optional
//           V-bars in leftover height).
//
// The fundamental fitter: given a strip of given width, fit as many pieces
// as possible into a single column inside it.
// ─────────────────────────────────────────────────────────────────────

// Pack pieces into a vertical column inside a strip of given (stripW, stripH).
// Returns { typeId, pw, ph, qty } or null. Uses both orientations.
//
// IMPORTANT: when the saw cuts an X-strip of width `stripW` and then makes
// U-cuts to extract pieces, every piece extracted has width == stripW
// (it spans the full strip). So we can only place pieces whose width along
// the strip axis matches `stripW`. Allowing `pw < stripW` would silently
// produce wrong pieces — the saw would cut `stripW × ph`, not `pw × ph`.
function fitColumn(rem, stripW, stripH, kerf) {
  let best = null;
  for (const t of rem.filter(r => r.rem > 0)) {
    for (const [pw, ph] of orientations(t)) {
      // Require strict width match (within 0.5mm tolerance for floating point)
      if (Math.abs(pw - stripW) > 0.5) continue;
      if (ph > stripH) continue;
      const qty = Math.min(Math.floor((stripH + kerf) / (ph + kerf)), t.rem);
      if (qty <= 0) continue;
      const score = qty * pw * ph;
      if (!best || score > best.score) {
        best = { typeId: t.id, pw, ph, qty, score };
      }
    }
  }
  return best;
}

// Find the best multi-piece fill for a strip of given length×height.
// Pieces from different types can share the strip, lined up along its length.
// Uses bounded DFS with aggressive pruning to keep cost manageable.
//
// Strategy: at each step, try each candidate type at its MAX-qty fit only.
// Don't enumerate smaller qty values — those only help if they expose new
// type opportunities that wouldn't otherwise fit, which is rare. Cap depth
// at 4 (any cabinet panel ever needs ≤ 4 distinct piece groups per strip).
//
// rem        — pieces array (won't be mutated)
// stripL     — available length (along strip axis)
// stripH     — strip height
// kerf       — saw kerf
// Returns { cuts: [{typeId,pw,ph,qty}, ...], placed, area }  or null
function bestStripFill(rem, stripL, stripH, kerf, maxGroups = 4) {
  // Build list of (type × orientation) candidates that fit in this strip.
  //
  // IMPORTANT: a Y-strip cut at height `stripH` produces pieces of EXACTLY
  // `stripH` height when X-cuts are made inside it. A piece with `ph < stripH`
  // would be silently mis-sized: the saw would cut a `pw × stripH` rectangle,
  // not `pw × ph`. So we require `ph == stripH` (within tolerance) for any
  // piece that goes in the primary strip fill.
  //
  // (Pieces with `ph < stripH` can fit in offcut/V-bar spaces — those are
  // sub-cuts inside an already-separated strip, and get a third pass with
  // their own RV head trim. That handling is separate from primary fill.)
  //
  // GRAIN DEDUP: when "Ruaj Ujerat" is on, every PDF row is a separate type
  // with rem=1.  The DFS below picks ONE type per "group" and at maxGroups=4
  // can only fit 4 distinct types per strip.  For grain inputs this caps a
  // strip's primary at 4 pieces, even when 7+ small same-dim pieces would
  // fit — directly costing the 3rd panel on the 43-piece test job.  Fix:
  // bucket types by (pw, ph) for the DFS so identical-dim grain rows share
  // a virtual slot, then expand the picked qty back to individual rows
  // (qty=1 each) when emitting `cuts`.  Non-grain types collapse on rotation
  // pairs as before — same bucket key handles both orientations of a single
  // type and shared-dim across multiple types uniformly.
  const buckets = new Map();
  for (const t of rem.filter(r => r.rem > 0)) {
    // Dedup: square non-grain types return [[X, X], [X, X]] from orientations(),
    // and other types could theoretically share keys across rotations if rotation
    // happens to match stripH on both axes — counting them twice would inflate
    // bucket.available and let the DFS pick more than t.rem of one type.
    const seenKeys = new Set();
    for (const [pw, ph] of orientations(t)) {
      if (Math.abs(ph - stripH) > 0.5) continue;
      if (pw > stripL) continue;
      const key = `${pw}|${ph}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      let b = buckets.get(key);
      if (!b) { b = { pw, ph, available: 0, sources: [] }; buckets.set(key, b); }
      b.available += t.rem;
      // sources is ordered (insertion order = type id order).  Expansion
      // below pulls qty entries from sources in this same order so the
      // first grain type seen consumes first, deterministically.
      b.sources.push({ typeId: t.id, rem: t.rem });
    }
  }
  if (buckets.size === 0) return null;
  // Use a single representative per bucket as the DFS candidate.
  const candTypes = [...buckets.values()];
  candTypes.sort((a, b) => b.pw * b.ph - a.pw * a.ph);

  const used = new Map();      // bucket-key → qty consumed in current path
  let bestFill = null;         // stored as virtual cuts (one per bucket key)

  function dfs(remainL, depth, currentCuts, currentArea, currentPlaced) {
    if (currentCuts.length > 0) {
      if (!bestFill ||
          currentPlaced > bestFill.placed ||
          (currentPlaced === bestFill.placed && currentArea > bestFill.area)) {
        bestFill = {
          cuts: currentCuts.map(c => ({ ...c })),
          placed: currentPlaced,
          area: currentArea,
        };
      }
    }
    if (depth >= maxGroups || remainL <= 0) return;
    for (const c of candTypes) {
      if (c.pw > remainL) continue;
      const key = `${c.pw}|${c.ph}`;
      const consumed = used.get(key) || 0;
      const available = c.available - consumed;
      if (available <= 0) continue;
      const maxQty = Math.min(
        Math.floor((remainL + kerf) / (c.pw + kerf)),
        available
      );
      if (maxQty <= 0) continue;
      const qty = maxQty;
      const actualUsed = qty * c.pw + (qty - 1) * kerf;
      const newRemain = remainL - actualUsed - kerf;
      used.set(key, consumed + qty);
      // Push a BUCKET cut, not a per-typeId one — we'll expand below.
      currentCuts.push({ bucketKey: key, pw: c.pw, ph: c.ph, qty });
      const groupArea = qty * c.pw * c.ph;
      dfs(newRemain, depth + 1, currentCuts, currentArea + groupArea, currentPlaced + qty);
      currentCuts.pop();
      used.set(key, consumed);
    }
  }
  dfs(stripL, 0, [], 0, 0);
  if (!bestFill) return null;

  // Expand bucket cuts back to per-typeId cuts.  For each bucket cut with
  // qty=N, draw N from the bucket's sources list (in insertion order),
  // emitting one cut per source consumed.  Downstream code subtracts
  // `cut.qty` from `rem.find(r => r.id === cut.typeId)`, so emitting
  // qty=N for one type or N×qty=1 for distinct types is equivalent —
  // we use whichever keeps the rem map correct.
  const expandedCuts = [];
  for (const bc of bestFill.cuts) {
    const bucket = buckets.get(bc.bucketKey);
    if (!bucket) continue;
    let remaining = bc.qty;
    for (const s of bucket.sources) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, s.rem);
      if (take <= 0) continue;
      expandedCuts.push({ typeId: s.typeId, pw: bc.pw, ph: bc.ph, qty: take });
      remaining -= take;
    }
  }
  return {
    cuts: expandedCuts,
    placed: bestFill.placed,
    area: bestFill.area,
  };
}

// V-bar packer — fill leftover vertical space inside an X-strip with cross-cuts.
// Identical semantics to v1's fillVBars, included for compatibility with
// the rowsX renderer.
//
// Note on margins:
//   - The horizontal margin used to bound the V-bar pieces along the strip's
//     width is `trimSub`, not the panel-edge trim. V-bars sit inside an
//     already-separated strip, so the saw operator has confirmed that 2.4mm
//     is the safe minimum here (vs 15mm at the panel's leading edge).
function fillVBars(rem, stripW, uUsed, availW, kerf, trimSub) {
  const vBars = []; let sv = 20;
  while (uUsed < availW && rem.some(t => t.rem > 0) && sv-- > 0) {
    const remainH = availW - uUsed;
    let bestV = null, bvs = -1;
    for (const t of rem.filter(r => r.rem > 0)) {
      // For grain pieces, W is pinned to X axis, so vPw must equal t.w
      // (W along the strip's X direction) and barH = t.h. Non-grain pieces
      // try both orientations.
      const orients = t.grainLock ? [[t.h, t.w]] : [[t.h, t.w], [t.w, t.h]];
      for (const [barH, vPw] of orients) {
        if (barH > remainH) continue;
        const vQty = Math.min(Math.floor((stripW - trimSub) / (vPw + kerf)), t.rem);
        if (vQty <= 0) continue;
        // Score: qty first (more pieces = denser), then placed AREA
        // (vQty × vPw × barH). Area beats the old "+ barH" tiebreak so two
        // orientations of the same piece prefer the one with the SMALLER
        // barH (same area, more height left in the column for the next
        // vBar). Concretely, this is what lets one 1986-wide X-column
        // absorb all 6 leftover pieces in tail-panel scenarios instead of
        // spilling a piece into a second column.
        const score = vQty * 100000 + vQty * vPw * barH;
        if (score > bvs) {
          bvs = score;
          bestV = { typeId: t.id, barH, vPw, vQty, ru: trimSub };
        }
      }
    }
    if (!bestV) break;
    rem.find(r => r.id === bestV.typeId).rem -= bestV.vQty;
    vBars.push(bestV);
    uUsed += bestV.barH + kerf;
  }
  return vBars;
}

// ─────────────────────────────────────────────────────────────────────
// STRIP-WIDTH SET ENUMERATOR
// ─────────────────────────────────────────────────────────────────────
//
// Given remaining pieces and a panel-length budget, enumerate combinations
// of strip widths (drawn from piece dimensions) that fit. For each
// combination, simulate packing and return the best one by piece count
// then efficiency.
//
// Why this exists: v1 was greedy left-to-right ("place biggest, then next
// biggest, etc."), which loses on inputs like test 2 where 3×600+2×400
// fits 21 pieces but 4×600+nothing only fits 20.
//
// Bounded search: piece types are typically 2-4 distinct dimensions, so
// strip-width candidates are small. We cap at depth 6 (more than 6 strips
// per panel is rare in cabinetry).
// ─────────────────────────────────────────────────────────────────────

function candidateStripWidths(types) {
  // Every piece edge is a candidate strip width.
  const s = new Set();
  for (const t of types) {
    if (t.rem > 0) {
      s.add(t.w); s.add(t.h);
    }
  }
  return [...s].sort((a, b) => b - a);
}

// Try to pack a single panel in X-mode using a specific sequence of strip widths.
// Returns { strips, score, eff, placedCount, finalRem } or null if invalid.
//
// Margin model:
//   trimX = panel-edge X-axis trim (RX in output) — leading edge of the panel.
//   trimSub = in-strip leading-edge margin (RU in output) — within an
//             already-separated strip. Saw operator confirmed this can be
//             smaller than the panel-edge trim. Defaults to 2.4mm.
//   In X-mode, the panel's Y-edge is not directly trimmed (no RY) — the strip
//   spans the full panelW. The first U-cut sits at trimSub from the strip's
//   bottom edge.
function packPanelXWithWidths(types, widths, panelL, panelW, kerf, trimX, trimSub, disableVBars) {
  const availL = panelL - 2 * trimX;  // X-budget: left RX + right edge (both trimX)
  // Strip Y-budget: pieces stack from (panelBot + trimX + RU) upward and must
  // leave a top-edge trim of `trimX` (no row enforces it in the WinCut format,
  // so the packer must keep pieces inside the usable region).  Earlier code
  // only subtracted trimSub (the per-strip RU), letting pieces overflow into
  // the top trim margin — visible as orange pieces flush with the panel top.
  const availW = panelW - trimSub - trimX;
  const rem = cp(types);
  const strips = [];
  let xUsed = 0;

  for (let i = 0; i < widths.length; i++) {
    const w = widths[i];
    if (xUsed > 0) xUsed += kerf;          // kerf BETWEEN strips
    if (xUsed + w > availL) return null;    // doesn't fit
    // Fit primary column in this strip — placeable height is availW (= panelW - trimSub),
    // pieces stack starting from offset trimSub.
    const col = fitColumn(rem, w, availW, kerf);
    if (!col || col.qty <= 0) return null;
    rem.find(r => r.id === col.typeId).rem -= col.qty;
    // Total Y position used: leading RU + n×piece + (n-1)×kerf, but our fitColumn
    // returns qty already constrained by `availW`, so uUsed measured from the bottom is:
    const uUsed = trimSub + col.qty * (col.ph + kerf);
    // V-bars fill the residual vertical space.  The cap is `availW` so the
    // top edge of the last v-bar lands AT MOST at the top trim line — never
    // past it.  Earlier this passed `panelW`, which let pieces sit flush with
    // the actual panel edge (no top trim) and in some cases even appeared to
    // overflow because of accumulated kerf rounding — the trim region was
    // being eaten by the optimizer.
    const vBars = disableVBars ? [] : fillVBars(rem, w, uUsed, availW, kerf, trimSub);
    strips.push({
      typeId: col.typeId, stripW: w, uPh: col.ph,
      uQty: col.qty, ru: trimSub, vBars,
    });
    xUsed += w;
  }

  const placedCount = strips.reduce(
    (s, st) => s + st.uQty + st.vBars.reduce((a, b) => a + b.vQty, 0), 0);
  const placedArea = strips.reduce((sum, st) => {
    const baseArea = st.uQty * st.stripW * st.uPh;
    const vbarArea = st.vBars.reduce((a, b) => a + b.vQty * b.vPw * b.barH, 0);
    return sum + baseArea + vbarArea;
  }, 0);
  const eff = placedArea / (panelL * panelW);
  return {
    mode: 'X', strips, placedCount, eff,
    score: placedCount * 1000 + Math.round(eff * 1000),
    finalRem: rem,
  };
}

// Y-mode packer — same idea but builds Y-strips first, then X-cuts within.
// Returns an array of candidate panel layouts (different lead-type strategies)
// rather than a single one, so the caller can try multiple seeds.

// Returns ALL viable Y-mode panels for a given strip-height schedule, varying
// which piece type leads each strip.
//
// Margin model:
//   trimEdge — panel-edge Y-axis trim (RY). The first Y-strip starts at this offset.
//   trimSub  — in-strip leading X-margin (RX, per-strip). The first piece in each
//              strip starts at this offset from the strip's leading edge.
// Build a single Y-mode candidate. `reducedFlags[i]=true` forces strip i's
// primary to a single piece of the best-area type matching the strip height,
// which leaves more X-leftover for a cross-type offcut. This matches Cutty's
// pattern of trading primary fill for offcut placement of a scarce type
// (e.g., test6.005 strip 2: 1× 896×458 primary + 2× 2000×200 in offcut).
function buildYCandidate(types, heights, panelL, panelW, kerf, trimEdge, trimSub, firstLead, reducedFlags, multiOffcut) {
  // X-budget for primary cuts: reserve the per-strip leading RX (trimSub,
  // explicit row) AND the panel's RIGHT edge (trimEdge, no row exists so the
  // packer must enforce it).  Previously only trimSub was subtracted, which
  // let primary cuts run flush to the right panel edge (0 mm right trim).
  const availL = panelL - trimSub - trimEdge;
  // Subtract trimEdge twice: once for the RY at the panel bottom (the explicit
  // saw row), once for the top edge (no row exists, so the packer enforces it
  // by limiting how much vertical space strips can occupy).
  const availW = panelW - 2 * trimEdge;
  const rem = cp(types);
  const strips = [];
  let yUsed = 0;

  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    if (yUsed > 0) yUsed += kerf;
    if (yUsed + h > availW) return null;

    let fill;
    if (reducedFlags[i]) {
      // Force primary = 1 piece of the best-area type with ph matching h.
      const candTypes = [];
      for (const t of rem.filter(r => r.rem > 0)) {
        for (const [pw, ph] of orientations(t)) {
          if (Math.abs(ph - h) > 0.5) continue;
          if (pw > availL) continue;
          candTypes.push({ typeId: t.id, pw, ph, area: pw * ph });
        }
      }
      if (candTypes.length === 0) return null;
      candTypes.sort((a, b) => b.area - a.area);
      const sel = candTypes[0];
      fill = {
        cuts: [{ typeId: sel.typeId, pw: sel.pw, ph: sel.ph, qty: 1 }],
        placed: 1,
        area: sel.area,
      };
    } else if (i === 0 && firstLead) {
      fill = bestStripFillWithLead(rem, availL, h, kerf, firstLead);
    } else {
      fill = bestStripFill(rem, availL, h, kerf);
    }
    if (!fill || fill.cuts.length === 0) return null;
    for (const c of fill.cuts) rem.find(r => r.id === c.typeId).rem -= c.qty;

    const xUsedByPrimary = fill.cuts.reduce((s, c) => s + c.qty * c.pw, 0)
                         + (fill.cuts.reduce((s, c) => s + c.qty, 0) - 1) * kerf;
    const offcutL = availL - xUsedByPrimary - kerf;
    // multiOffcut=true → fit multiple sub-strips greedily (denser per panel).
    // multiOffcut=false → fit at most one sub-strip (legacy, less greedy).
    // Both variants are emitted upstream so B&B can pick the right one.
    let offcuts;
    if (multiOffcut) {
      offcuts = fitYStripOffcuts(rem, offcutL, h, kerf, trimSub);
    } else {
      const single = fitYStripOffcut(rem, offcutL, h, kerf, trimSub);
      offcuts = single ? [{
        xPw: single.xPw, ru: single.ru,
        uCuts: [{ typeId: single.typeId, uPh: single.uPh, uQty: single.uQty }],
      }] : [];
    }
    const offcutPlaced = offcuts.reduce(
      (s, oc) => s + oc.uCuts.reduce((a, u) => a + u.uQty, 0), 0);
    const placedTotal = fill.placed + offcutPlaced;
    strips.push({ stripH: h, primaryCuts: fill.cuts, offcuts, placed: placedTotal });
    yUsed += h;
  }

  const placedCount = strips.reduce((s, st) => s + st.placed, 0);
  const placedArea = strips.reduce((sum, st) => {
    const primary = st.primaryCuts.reduce((a, c) => a + c.qty * c.pw * c.ph, 0);
    const off = (st.offcuts || []).reduce(
      (a, oc) => a + oc.uCuts.reduce(
        (b, u) => b + u.uQty * oc.xPw * u.uPh, 0), 0);
    return sum + primary + off;
  }, 0);
  const eff = placedArea / (panelL * panelW);
  return {
    mode: 'Y', strips, placedCount, eff,
    score: placedCount * 1000 + Math.round(eff * 1000),
    finalRem: rem,
  };
}

function packPanelYWithHeightsAll(types, heights, panelL, panelW, kerf, trimEdge, trimSub, allowMultiOffcut) {
  // Reserve left RX (trimSub) + right panel edge (trimEdge, no row).
  const availL = panelL - trimSub - trimEdge;
  // 2 × trimEdge: bottom RY explicit + top edge implicit (no row, enforced here).
  const availW = panelW - 2 * trimEdge;
  const heightSum = heights.reduce((s, h) => s + h, 0)
                  + (heights.length - 1) * kerf;
  if (heightSum > availW) return [];

  const out = [];
  const firstLeads = leadCandidatesForHeight(types, heights[0], availL, kerf);
  const N = heights.length;

  // When allowMultiOffcut: emit BOTH single-sub-strip and multi-sub-strip
  // variants per height combo (B&B picks the right one). When false:
  // single-offcut only — keeps greedy-mode candidate sets uncorrupted by
  // densely-packed-but-globally-bad multi-offcut picks.
  const offcutModes = allowMultiOffcut ? [false, true] : [false];

  // BISECT: trying without the all-reduced variant first.
  for (const lead of firstLeads) {
    for (const multiOffcut of offcutModes) {
      // Default fill (max-density per strip).
      const def = buildYCandidate(types, heights, panelL, panelW, kerf, trimEdge, trimSub,
                                   lead, new Array(N).fill(false), multiOffcut);
      if (def) out.push(def);

      // Reduced-primary variants: for each strip, force primary qty=1 there.
      // This frees X-leftover for a scarce-type offcut.
      for (let i = 0; i < N; i++) {
        const flags = new Array(N).fill(false);
        flags[i] = true;
        const variant = buildYCandidate(types, heights, panelL, panelW, kerf, trimEdge, trimSub,
                                         lead, flags, multiOffcut);
        if (variant) out.push(variant);
      }

      // For 2+ strip combos, also try ALL strips reduced (Cutty C6 pattern).
      if (N >= 2) {
        const allReduced = buildYCandidate(types, heights, panelL, panelW, kerf, trimEdge, trimSub,
                                            lead, new Array(N).fill(true), multiOffcut);
        if (allReduced) out.push(allReduced);
      }
    }
  }

  return out;
}

// Try to fit ONE sub-strip in a Y-strip's leftover X-space (the original
// single-offcut behavior). Returns null or {typeId, xPw, uPh, uQty, ru}.
// Mutates `rem`.
function fitYStripOffcut(rem, offcutL, stripH, kerf, trimSub) {
  if (offcutL <= 0) return null;
  let best = null;
  for (const ot of rem.filter(r => r.rem > 0)) {
    for (const [xPw, uPh] of orientations(ot)) {
      if (xPw > offcutL) continue;
      for (const ru of [trimSub, MIN_INNER_TRIM]) {
        if (ru > trimSub) continue;
        if (uPh + ru > stripH) continue;
        const availY = stripH - ru;
        const maxU = Math.floor((availY + kerf) / (uPh + kerf));
        const uQty = Math.min(maxU, ot.rem);
        if (uQty < 1) continue;
        const score = uQty * xPw * uPh;
        if (!best || score > best.score) {
          best = { typeId: ot.id, xPw, uPh, uQty, ru, score };
        }
        break;
      }
    }
  }
  if (!best) return null;
  rem.find(r => r.id === best.typeId).rem -= best.uQty;
  return { typeId: best.typeId, xPw: best.xPw, uPh: best.uPh, uQty: best.uQty, ru: best.ru };
}

// Greedily fit MULTIPLE sub-strips into a Y-strip's leftover X-space.
// Returns an array of offcut sub-regions in the new schema:
//   [{ xPw, ru, uCuts: [{typeId, uPh, uQty}, ...] }, ...]
// Each sub-strip has its own xPw width and one or more U-cut groups (each
// group = one piece type stacked uQty times). Multiple sub-strips fit
// side-by-side along the strip's leftover X axis.
//
// This matches Cutty's multi-sub-strip U* pattern (e.g. test6 file 003 Y=480
// strip: offcut sub-strip 398-wide for 1× 398×450, then sub-strip 65-wide
// for 1× 398×65). v2 previously emitted only ONE sub-strip per offcut,
// leaving the rest of the X-leftover empty.
//
// Mutates `rem`.
function fitYStripOffcuts(rem, offcutL, stripH, kerf, trimSub) {
  const out = [];
  let remainingL = offcutL;
  // Cap iterations as a safety measure — in practice 1-4 sub-strips fit.
  let safety = 8;
  while (remainingL > 0 && safety-- > 0) {
    // (a) Pick the best PRIMARY uCut group for a fresh sub-strip — the type
    //     whose (xPw × uPh × uQty) is largest among all that fit. Uses
    //     adaptive ru: default trimSub, falling to MIN_INNER_TRIM if needed
    //     to land a piece (matches Cutty's "default + dynamic shrink").
    let best = null;
    for (const ot of rem.filter(r => r.rem > 0)) {
      for (const [xPw, uPh] of orientations(ot)) {
        if (xPw > remainingL) continue;
        for (const ru of [trimSub, MIN_INNER_TRIM]) {
          if (ru > trimSub) continue;
          if (uPh + ru > stripH) continue;
          const availY = stripH - ru;
          const maxU = Math.floor((availY + kerf) / (uPh + kerf));
          const uQty = Math.min(maxU, ot.rem);
          if (uQty < 1) continue;
          const score = uQty * xPw * uPh;
          if (!best || score > best.score) {
            best = { typeId: ot.id, xPw, uPh, uQty, ru, score };
          }
          break;  // first fitting ru wins (default tried first)
        }
      }
    }
    if (!best) break;
    rem.find(r => r.id === best.typeId).rem -= best.uQty;
    const uCuts = [{ typeId: best.typeId, uPh: best.uPh, uQty: best.uQty }];

    // (b) STACK additional uCut groups inside THIS sub-strip. Each new group
    //     must have one of its dimensions == best.xPw (so it spans the
    //     sub-strip width); its other dimension stacks along Y. We keep
    //     adding while there's height left and a same-width type exists.
    //     This is what makes Cutty-style "X=575 zone with U=770 + U=195(2)
    //     + U=600+V=270(2)" patterns achievable in our schema.
    let yUsed = best.ru + best.uQty * best.uPh + (best.uQty - 1) * kerf;
    let stackSafety = 8;
    while (stackSafety-- > 0) {
      const remH = stripH - yUsed - kerf;  // need a kerf separator between groups
      if (remH < 1) break;
      let bestStack = null;
      for (const ot of rem.filter(r => r.rem > 0)) {
        for (const [pw, ph] of orientations(ot)) {
          if (Math.abs(pw - best.xPw) > 0.5) continue;  // must match sub-strip width
          if (ph > remH) continue;
          const maxQ = Math.floor((remH + kerf) / (ph + kerf));
          const q = Math.min(maxQ, ot.rem);
          if (q < 1) continue;
          const sc = q * pw * ph;
          if (!bestStack || sc > bestStack.score) {
            bestStack = { typeId: ot.id, uPh: ph, uQty: q, score: sc };
          }
        }
      }
      if (!bestStack) break;
      rem.find(r => r.id === bestStack.typeId).rem -= bestStack.uQty;
      uCuts.push({ typeId: bestStack.typeId, uPh: bestStack.uPh, uQty: bestStack.uQty });
      yUsed += kerf + bestStack.uQty * bestStack.uPh + (bestStack.uQty - 1) * kerf;
    }

    out.push({ xPw: best.xPw, ru: best.ru, uCuts });
    remainingL -= best.xPw + kerf;
  }
  return out;
}

// Get a small set of "lead" piece options for a strip of given height.
// Each lead is a (type, orientation, qty) that, if placed first in the strip,
// would dictate which other pieces fit alongside.
function leadCandidatesForHeight(types, stripH, stripL, kerf) {
  const out = [];
  const seen = new Set();
  for (const t of types.filter(r => r.rem > 0)) {
    for (const [pw, ph] of orientations(t)) {
      // Strict height match: a Y-strip cut at stripH produces pieces of
      // EXACTLY stripH height. Allowing ph < stripH would silently mis-cut.
      if (Math.abs(ph - stripH) > 0.5) continue;
      if (pw > stripL) continue;
      const maxQty = Math.min(
        Math.floor((stripL + kerf) / (pw + kerf)), t.rem
      );
      // Add lead options for qty = 1 and qty = maxQty (and a middle value if useful)
      const qtys = new Set([1, maxQty]);
      if (maxQty >= 3) qtys.add(Math.floor(maxQty / 2));
      for (const q of qtys) {
        if (q < 1 || q > maxQty) continue;
        const key = `${t.id}|${pw}|${ph}|${q}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ typeId: t.id, pw, ph, qty: q });
      }
    }
  }
  // Plus a "no forced lead" option (use default DFS)
  out.push(null);
  return out;
}

// Like bestStripFill but with a fixed first cut group (the lead).
// Then the DFS picks the rest of the fill.
function bestStripFillWithLead(rem, stripL, stripH, kerf, lead) {
  // Apply the lead first; verify available.
  const t = rem.find(r => r.id === lead.typeId);
  if (!t || t.rem < lead.qty) return null;
  const leadActualUsed = lead.qty * lead.pw + (lead.qty - 1) * kerf;
  if (leadActualUsed > stripL) return null;
  // Reduce rem temporarily for the DFS that fills the rest
  const tempRem = cp(rem);
  tempRem.find(r => r.id === lead.typeId).rem -= lead.qty;
  const remainL = stripL - leadActualUsed - kerf;
  const tail = bestStripFill(tempRem, remainL > 0 ? remainL : 0, stripH, kerf);
  // Combine lead + tail
  const cuts = [{ typeId: lead.typeId, pw: lead.pw, ph: lead.ph, qty: lead.qty }];
  if (tail && tail.cuts.length > 0) cuts.push(...tail.cuts);
  const placed = cuts.reduce((s, c) => s + c.qty, 0);
  const area = cuts.reduce((s, c) => s + c.qty * c.pw * c.ph, 0);
  return { cuts, placed, area };
}

// Enumerate strip-width combinations. Returns an array of all viable layouts.
// For Y-mode this includes multiple lead-type variations per height schedule.
// Cap at 6 strips per panel.
function allStripWidthCombos(types, panelL, panelW, kerf, trimEdge, trimSub, mode, disableVBars, allowMultiOffcut) {
  // The "budget" axis for the strip count is the panel-edge axis.  In
  // X-mode strips are placed side-by-side along X, so the X budget must
  // reserve BOTH the left RX (explicit row) and the right panel edge (no
  // row) — `panelL - 2*trimEdge` — otherwise X-mode strips run flush to
  // the right edge with no trim.  Y-mode mirrors this on the Y axis.
  const availL = panelL - 2 * trimEdge;
  const availW = panelW - 2 * trimEdge;
  const cands = candidateStripWidths(types);
  if (cands.length === 0) return [];

  const allResults = [];
  const maxStrips = 6;
  const budget = mode === 'X' ? availL : availW;

  // De-dup signatures so we don't keep equivalent combos
  const seenSigs = new Set();

  function recur(combo, used, depth) {
    if (combo.length > 0) {
      if (mode === 'X') {
        const result = packPanelXWithWidths(types, combo, panelL, panelW, kerf, trimEdge, trimSub, disableVBars);
        if (result) {
          const sig = `X|${result.placedCount}|${result.eff.toFixed(4)}`;
          if (!seenSigs.has(sig)) { seenSigs.add(sig); allResults.push(result); }
        }
      } else {
        const results = packPanelYWithHeightsAll(types, combo, panelL, panelW, kerf, trimEdge, trimSub, allowMultiOffcut);
        for (const r of results) {
          const sig = `Y|${r.placedCount}|${r.eff.toFixed(4)}|${r.strips.map(s=>s.primaryCuts[0]?.typeId).join(',')}`;
          if (!seenSigs.has(sig)) { seenSigs.add(sig); allResults.push(r); }
        }
      }
    }
    if (depth >= maxStrips) return;
    for (const w of cands) {
      const newUsed = used + w + (combo.length > 0 ? kerf : 0);
      if (newUsed > budget) continue;
      combo.push(w);
      recur(combo, newUsed, depth + 1);
      combo.pop();
    }
  }
  recur([], 0, 0);
  return allResults;
}

// ─────────────────────────────────────────────────────────────────────
// V1-COMPATIBLE GREEDY PACKERS (kept as fallback strategies)
// ─────────────────────────────────────────────────────────────────────
//
// These reproduce v1's behavior exactly. They become candidates in v2's
// best-of-many search rather than the only option.
// ─────────────────────────────────────────────────────────────────────

function dominantPiece(rem, sp){
  const c = rem.filter(t => t.rem > 0).sort((a, b) => (b.w * b.h) - (a.w * a.h));
  for (const t of c) {
    // Natural orientation (pw=t.w, ph=t.h).  Always allowed.
    if (t.h <= sp) return { piece: t, stripH: t.h, pw: t.w, ph: t.h };
    // Rotated orientation (pw=t.h, ph=t.w).  Only valid for NON grain-locked
    // pieces — rotating a grain piece would flip the wood-grain direction,
    // which is exactly what the "Ruaj Ujerat" rule forbids.  Without this
    // guard, packYGreedy could place a grain-locked 127×597 piece as 597×127
    // in a short strip, silently violating grain even though the rest of the
    // packer chain honors `orientations(t)`.
    if (!t.grainLock && t.w <= sp) return { piece: t, stripH: t.w, pw: t.h, ph: t.w };
  }
  return null;
}

function packYGreedy(types, availL, availW, kerf, trimSub) {
  const rem = cp(types);
  const strips = [];
  let yUsed = 0;
  while (rem.some(t => t.rem > 0)) {
    const space = availW - yUsed;
    if (space <= 0) break;
    const dom = dominantPiece(rem, space);
    if (!dom) break;
    const { piece: t, stripH, pw, ph } = dom;
    const qty = Math.min(Math.floor(availL / (pw + kerf)), t.rem);
    if (qty <= 0) break;
    let xUsed = qty * (pw + kerf);
    t.rem -= qty;
    let placed = qty;

    // Multi sub-strip offcut: keep emitting offcut sub-strips along the
    // remaining X-axis until either no more types fit or the X-tail is too
    // small. Each sub-strip is a vertical slice of the strip — width xPw,
    // height stripH — packed greedily with one or more uCut groups (the
    // multi-uCut inner loop below).
    //
    // This is THE key change that lets us match Cutty's "Y=799 strip with
    // X=2692 primary + X=600 (one 600×770 piece) + X=320 (one 710×320 piece)"
    // pattern. Without this loop, only the X=600 sub-strip would be emitted
    // and the 320 mm X-tail would be wasted.
    const offcuts = [];
    let outerSafety = 8;
    while (outerSafety-- > 0) {
      const offcutL = availL - xUsed;
      if (offcutL <= 0 || !rem.some(r => r.rem > 0)) break;
      let best = null, bs = 0;
      const sub = trimSub || 0;
      // Adaptive RU: default to `sub` but shrink to MIN_INNER_TRIM when a
      // piece would otherwise not fit. Mirrors Cutty's behavior of using
      // small interior trims when needed to land a tight piece.
      for (const ot of rem.filter(r => r.rem > 0)) {
        for (const [xPw, uPh] of orientations(ot)) {
          if (xPw > offcutL) continue;
          for (const ru of [sub, MIN_INNER_TRIM]) {
            if (ru > sub) continue;  // never enlarge ru above caller's trim
            if (uPh + ru > stripH) continue;
            const availY = stripH - ru;
            const maxU = Math.floor((availY + kerf) / (uPh + kerf));
            const uQty = Math.min(maxU, ot.rem);
            if (uQty < 1) continue;
            // Score by area placed (uQty × xPw × uPh).
            const sc = uQty * xPw * uPh;
            // Prefer larger ru when both fit (cleaner-looking cut, matches
            // operator habit). Only fall to MIN_INNER_TRIM when default fails.
            if (sc > bs) { bs = sc; best = { ...ot, xPw, uPh, uQty, ru }; }
            break;  // first ru that fits wins (default tried first)
          }
        }
      }
      if (!best) break;
      const ot = rem.find(r => r.id === best.id);
      const uCuts = [{ typeId: best.id, uPh: best.uPh, uQty: best.uQty }];
      ot.rem -= best.uQty;
      placed += best.uQty;
      // Multi-uCut fill: stack additional same-xPw types above the primary
      // uCut group to consume leftover sub-strip height. Uses best.ru (which
      // may be adaptive) so the math here matches the actual placement.
      let usedH = best.ru + best.uQty * best.uPh + (best.uQty - 1) * kerf;
      let stackSafety = 8;
      while (stackSafety-- > 0) {
        const remH = stripH - usedH - kerf;
        if (remH <= 0) break;
        let extra = null, extraScore = 0;
        for (const xt of rem.filter(r => r.rem > 0)) {
          for (const [xw, xh] of orientations(xt)) {
            if (Math.abs(xw - best.xPw) > 0.5) continue;
            if (xh > remH) continue;
            const maxQ = Math.floor((remH + kerf) / (xh + kerf));
            const q = Math.min(maxQ, xt.rem);
            if (q < 1) continue;
            const sc = q * xw * xh;
            if (sc > extraScore) { extraScore = sc; extra = { id: xt.id, uPh: xh, uQty: q }; }
          }
        }
        if (!extra) break;
        uCuts.push({ typeId: extra.id, uPh: extra.uPh, uQty: extra.uQty });
        rem.find(r => r.id === extra.id).rem -= extra.uQty;
        placed += extra.uQty;
        usedH += kerf + extra.uQty * extra.uPh + (extra.uQty - 1) * kerf;
      }
      offcuts.push({ xPw: best.xPw, ru: best.ru, uCuts });
      xUsed += best.xPw + kerf;
    }
    strips.push({ stripH, primaryCuts: [{ typeId: t.id, pw, ph, qty }], offcuts, placed });
    yUsed += stripH + kerf;
  }
  return { strips, finalRem: rem, score: strips.reduce((s, st) => s + st.placed, 0) };
}

function packXGreedy(types, availL, availW, kerf, trimEdge, trimSub) {
  const rem = cp(types);
  const strips = [];
  let xUsed = 0;
  while (rem.some(t => t.rem > 0)) {
    if (xUsed >= availL) break;
    const spaceX = availL - xUsed;
    const cands = rem.filter(t => t.rem > 0).sort((a, b) => (b.w * b.h) - (a.w * a.h));
    let best = null, bestScore = -1;
    for (const t of cands) {
      for (const [sw, uPh] of orientations(t)) {
        if (sw > spaceX || uPh > availW) continue;
        const uQty = Math.min(Math.floor(availW / (uPh + kerf)), t.rem);
        if (uQty <= 0) continue;
        const score = t.w * t.h;
        if (score > bestScore) {
          bestScore = score;
          best = { typeId: t.id, stripW: sw, uPh, uQty, ru: trimSub };
        }
      }
    }
    if (!best) break;
    rem.find(r => r.id === best.typeId).rem -= best.uQty;
    const uUsed = trimSub + best.uQty * (best.uPh + kerf);
    // V-bars fill up to `availW` (= caller's panelW - trimSub - trimEdge,
    // i.e. the strip-relative space that respects BOTH the leading ru AND
    // the top trim).  Previously this passed `availW + trimSub`, which let
    // the last v-bar land flush with the panel edge — bypassing the top
    // trim and producing pieces visibly overflowing into the trim region
    // on the saved 2D preview.
    const vBars = fillVBars(rem, best.stripW, uUsed, availW, kerf, trimSub);
    strips.push({ ...best, vBars });
    xUsed += best.stripW + kerf;
  }
  const placedCount = strips.reduce(
    (s, st) => s + st.uQty + st.vBars.reduce((a, b) => a + b.vQty, 0), 0);
  return { strips, finalRem: rem, score: placedCount };
}

// ─────────────────────────────────────────────────────────────────────
// PER-PANEL CANDIDATE GENERATOR
// ─────────────────────────────────────────────────────────────────────
//
// Generate many candidate layouts for a single panel, score each, return
// the best. The richness of this list determines how good v2 is.
//
// Score = placedCount × 1000 + roundEff(eff × 1000).
// Higher pieces always wins; ties broken by efficiency.
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
// ROW RENDERERS — UNCHANGED FROM v1
// (must produce identical output to keep WinCut .txt format consistent)
// ─────────────────────────────────────────────────────────────────────

// Render Y-mode strips to WinCut row format.
//
// Args:
//   strips    — array of Y-mode strips
//   inStripX  — in-strip X-margin (RX per strip, the post-RY in-strip leading
//               margin). Default usage: trimSub.
//   panelEdgeY — panel Y-edge trim (RY, once per panel). Default usage: trimEdge.
// Normalize a Y strip's offcuts to the canonical array form
//   [{ xPw, ru, uCuts: [{typeId, uPh, uQty}, ...] }, ...]
// Accepts: new offcuts array, legacy single offcut, or nothing.
function normalizeYOffcuts(st) {
  if (Array.isArray(st.offcuts)) return st.offcuts;
  if (st.offcut) return [{
    xPw: st.offcut.xPw, ru: st.offcut.ru,
    uCuts: [{ typeId: st.offcut.typeId, uPh: st.offcut.uPh, uQty: st.offcut.uQty }],
  }];
  return [];
}

function rowsY(strips, inStripX, panelEdgeY) {
  const rows = [{ type: 'RY', val: panelEdgeY, qty: 1, tid: null }];
  for (const st of strips) {
    let primaryCuts = st.primaryCuts || [];
    let offcuts = normalizeYOffcuts(st);
    let stripH = st.stripH;

    // DEGENERATE-STRIP GUARD.  Floating-point trim/kerf drift can make the
    // packer emit phantom strips with NO primary AND NO offcuts (e.g.
    // `Y,5.926672` — a 5.9 mm tall strip holding nothing).  Emitting
    // `Y → RX` with no cut after it is exactly the WinCut "missing cut
    // after rifilo" error.  These strips carry no pieces, so skip them
    // entirely — the few mm of material is absorbed at the cut line.
    if (primaryCuts.length === 0 &&
        (!offcuts || offcuts.length === 0)) {
      continue;
    }

    // WINCUT VALIDITY GUARD.  A Y-strip in the WinCut grammar MUST have at
    // least one primary X cut before the `U*` offcut marker.  Some strips
    // come out of the packer with primaryCuts=[] and only offcuts (e.g.
    // when the strip height drifted a few mm above the piece height from
    // accumulated trim, so no piece is "full strip height").  Emitting
    // those as `Y → RX → U* → …` produces the WinCut error
    // "Manca un'istruzione di taglio o asteriscata dopo il rifilo".
    //
    // Fix: when there is no primary, promote single-piece offcut columns
    // to real primary X cuts and shrink the strip to the piece height.
    // Every offcut in the failing layouts is exactly one piece (one uCut
    // group, uQty≥1) — those ARE full-height columns once the spurious
    // few-mm trim drift is removed, so this is geometry-correct and tighter
    // (less waste), not just a band-aid.
    if (primaryCuts.length === 0 && offcuts.length > 0) {
      // Only piece-bearing offcuts are promotable.  Empty X-gap spacers
      // (uCuts: []) are positioning padding (manual-editor permissive
      // emitter) — accessing their uCuts[0] crashed with "Cannot read
      // properties of undefined (reading 'typeId')".  Filter them out.
      const pieceOffcuts = offcuts.filter(oc => oc.uCuts && oc.uCuts.length > 0);
      if (pieceOffcuts.length === 0) {
        // Carries no pieces (only spacers) → phantom strip. Skip.
        continue;
      }
      const allSinglePiece = pieceOffcuts.every(oc => oc.uCuts.length === 1);
      if (allSinglePiece) {
        stripH = Math.max(...pieceOffcuts.map(oc => oc.uCuts[0].uPh));
        primaryCuts = pieceOffcuts.map(oc => ({
          typeId: oc.uCuts[0].typeId,
          pw: oc.xPw,
          qty: oc.uCuts[0].uQty,
        }));
        offcuts = [];
      } else {
        const first = pieceOffcuts[0];
        const firstH = first.uCuts.reduce(
          (s, u) => s + u.uQty * u.uPh, 0) + (first.ru || 0);
        stripH = Math.max(firstH, st.stripH);
        primaryCuts = [{
          typeId: first.uCuts[0].typeId, pw: first.xPw, qty: 1,
        }];
        const idx = offcuts.indexOf(first);
        offcuts = offcuts.slice(idx + 1).filter(oc => oc.uCuts && oc.uCuts.length > 0);
      }
    }

    rows.push({ type: 'Y', val: stripH, qty: 1, tid: null });
    rows.push({ type: 'RX', val: inStripX, qty: 1, tid: null });
    for (const c of primaryCuts)
      rows.push({ type: 'X', val: c.pw, qty: c.qty, tid: c.typeId });
    // Only emit piece-bearing offcuts.  Empty X-gap spacers (uCuts: [])
    // would emit `X RU` with no `U` — an offcut column with no cut, which
    // WinCut rejects.  KEEP IN SYNC with _meRowsY().
    const pieceOcs = offcuts.filter(oc => oc.uCuts && oc.uCuts.length > 0);
    if (pieceOcs.length > 0) {
      rows.push({ type: 'U*', val: 0, qty: 0, tid: null });
      for (const oc of pieceOcs) {
        rows.push({ type: 'X', val: oc.xPw, qty: 1, tid: null });
        rows.push({ type: 'RU', val: oc.ru, qty: 1, tid: null });
        for (const u of oc.uCuts) {
          rows.push({ type: 'U', val: u.uPh, qty: u.uQty, tid: u.typeId });
        }
      }
    }
  }
  return rows;
}

// Render X-mode strips to WinCut row format.
//
// Args:
//   strips     — array of X-mode strips (each has its own .ru = trimSub
//                already set during packing, and per-vBar .ru also = trimSub)
//   panelEdgeX — panel X-edge trim (RX, once per panel). Default usage: trimEdge.
//   _unused    — reserved for symmetry with rowsY signature; not used by rowsX
//                (because per-strip RU/RV come from the strip objects themselves).
function rowsX(strips, panelEdgeX, _unused) {
  const rows = [{ type: 'RX', val: panelEdgeX, qty: 1, tid: null }];
  let i = 0;
  while (i < strips.length) {
    let st = strips[i];
    let stripW = st.stripW;
    let uPh = st.uPh, uQty = st.uQty, uTid = st.typeId;
    let vBars = (st.vBars || []).filter(vb => !(vb.typeId == null && vb.vQty === 0));

    // DEGENERATE-STRIP GUARD (X-mode mirror of rowsY's).  A strip with no
    // primary U pieces AND no real vBars is a phantom from float drift —
    // emitting `X → RU` with nothing after is the WinCut "missing cut
    // after rifilo" error.  Skip it.
    if ((!uQty || uQty === 0) && vBars.length === 0) { i++; continue; }

    // WINCUT VALIDITY GUARD (X-mode mirror).  An X-strip MUST have ≥1
    // primary U before the `V*` vBar marker.  When the packer makes a
    // primary-less strip (strip width drifted a few mm wider than the
    // pieces so none is "full strip width"), promote the first single-
    // piece vBar to the primary U and shrink stripW to that piece's
    // width.  Geometry-correct and tighter, mirrors the rowsY fix.
    if ((!uQty || uQty === 0) && vBars.length > 0) {
      const first = vBars[0];
      if (first.vQty === 1) {
        uPh = first.barH; uQty = 1; uTid = first.typeId;
        stripW = first.vPw;
        vBars = vBars.slice(1);
      } else {
        // First vBar is a multi-piece row — promote it as the primary U
        // anyway (uPh=barH, qty=vQty) so the file stays WinCut-valid;
        // the final validator will catch any residual geometry issue.
        uPh = first.barH; uQty = first.vQty; uTid = first.typeId;
        vBars = vBars.slice(1);
      }
    }

    let batchQty = 1;
    if (vBars.length === 0) {
      while (i + batchQty < strips.length) {
        const next = strips[i + batchQty];
        const nextVBars = (next.vBars || []).filter(vb => !(vb.typeId == null && vb.vQty === 0));
        if (next.stripW === stripW && next.uPh === uPh &&
            next.typeId === uTid && nextVBars.length === 0 &&
            (next.uQty || 0) === uQty && uQty > 0) batchQty++;
        else break;
      }
    }
    rows.push({ type: 'X', val: stripW, qty: batchQty, tid: null });
    rows.push({ type: 'RU', val: st.ru, qty: 1, tid: null });
    rows.push({ type: 'U', val: uPh, qty: uQty, tid: uTid });
    // V*,0 is emitted ONCE after the primary U to mark "primary U cuts done,
    // vBars begin". Subsequent vBars do NOT need their own V* separator —
    // the U row of the next vBar is itself the boundary. Real Cutty output
    // matches this convention (see CUTLST_KD-001 panel 4: rows 4-14 have
    // exactly one V*,0 between primary U and vBars, none between vBars).
    //
    // The earlier "V*,0 before every vBar" pattern caused WinCut's visualizer
    // to render the scrap region of the LAST vBar (when vPw < stripW) as if
    // it were part of the piece — confusing the saw operator who saw a
    // yellow shading where there should have been white waste.
    if (vBars.length > 0) {
      rows.push({ type: 'V*', val: 0, qty: 0, tid: null });
      for (const vb of vBars) {
        rows.push({ type: 'U', val: vb.barH, qty: 1, tid: null });
        rows.push({ type: 'RV', val: vb.ru, qty: 1, tid: null });
        rows.push({ type: 'V', val: vb.vPw, qty: vb.vQty, tid: vb.typeId });
      }
    }
    i += batchQty;
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────
// WINCUT GRAMMAR VALIDATOR — production tripwire.
//
// Walks the final row stream and enforces the WinCut cut-list grammar.
// If ANY rule is violated it throws — guaranteeing a malformed .txt is
// NEVER written (a broken file silently halting the saw on the shop
// floor is far worse than a loud, clear failure the operator can report).
//
// Grammar (Y-mode):  RY ( Y RX X+ ( U* (X RU U+)+ )? )+
// Grammar (X-mode):  RX ( X RU U+ ( V* (U RV V+)+ )? )+
//
// The single most common real-world break is the "missing cut after the
// trim" error: a strip trim (RX in Y-mode / RU in X-mode) followed
// directly by the offcut/vBar asterisk with no primary cut between.
// ─────────────────────────────────────────────────────────────────────
function assertWincutRowsValid(rows, ctx) {
  const where = ctx ? ` [${ctx}]` : '';
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error(`WinCut rows invalid${where}: empty row list`);
  const m0 = rows[0].type;
  const mode = m0 === 'RY' ? 'Y' : m0 === 'RX' ? 'X' : null;
  if (!mode)
    throw new Error(`WinCut rows invalid${where}: first row must be RY or RX, got "${m0}"`);

  const OPEN  = mode === 'Y' ? 'Y'  : 'X';   // strip-opening cut
  const TRIM  = mode === 'Y' ? 'RX' : 'RU';  // in-strip leading trim
  const PRIM  = mode === 'Y' ? 'X'  : 'U';   // primary cut
  const AST   = mode === 'Y' ? 'U*' : 'V*';  // offcut / vBar marker
  const G1    = mode === 'Y' ? 'X'  : 'U';   // offcut/vBar group: lead
  const G2    = mode === 'Y' ? 'RU' : 'RV';  //                     trim
  const G3    = mode === 'Y' ? 'U'  : 'V';   //                     cuts

  let i = 1;  // row 0 is the panel-edge trim (RY/RX)
  while (i < rows.length) {
    if (rows[i].type !== OPEN)
      throw new Error(`WinCut rows invalid${where}: row ${i + 1} expected ${OPEN} (strip open), got "${rows[i].type}"`);
    i++;
    if (i >= rows.length || rows[i].type !== TRIM)
      throw new Error(`WinCut rows invalid${where}: row ${i + 1} expected ${TRIM} after ${OPEN}`);
    i++;
    let prims = 0;
    while (i < rows.length && rows[i].type === PRIM) { prims++; i++; }
    if (prims === 0)
      throw new Error(`WinCut rows invalid${where}: row ${i + 1} — no ${PRIM} primary cut after ${TRIM} ("missing cut after rifilo"). This strip would crash WinCut.`);
    if (i < rows.length && rows[i].type === AST) {
      i++;
      let groups = 0;
      while (i < rows.length && rows[i].type === G1) {
        i++;
        if (i >= rows.length || rows[i].type !== G2)
          throw new Error(`WinCut rows invalid${where}: row ${i + 1} expected ${G2} in offcut/vBar group`);
        i++;
        let c = 0;
        while (i < rows.length && rows[i].type === G3) { c++; i++; }
        if (c === 0)
          throw new Error(`WinCut rows invalid${where}: row ${i + 1} expected ${G3} cut(s) in offcut/vBar group`);
        groups++;
      }
      if (groups === 0)
        throw new Error(`WinCut rows invalid${where}: ${AST} marker with no offcut/vBar group following`);
    }
  }
}

function genFileContent(panelL, panelW, panelT, supplier, rows, snap, velR, velA) {
  assertWincutRowsValid(rows, 'genFileContent');
  const lines = ['[Intestazione]', `Descrizione=${supplier}`, `TipoMateriale=${supplier}_1`,
    `Lunghezza=${panelL}.000000`, `Larghezza=${panelW}.000000`, `Spessore=${panelT}.000000`,
    'AltPacco=90.000000', `VelRotaz=${velR}`, `VelAvanz=${velA}.000000`,
    '[Righe]', `NumeroRighe=${rows.length}`];
  rows.forEach((r, i) => lines.push(
    `${i+1}=${r.type},${(r.val||0).toFixed(6)},${r.qty||0},0.000000,0.000000,0.000000,0.000000`));
  const placed = snap.filter(t => t.placedOnThisPanel > 0);
  lines.push('[Dati]', `NumeroDati=${placed.length}`);
  // Build a typeId → 1-based [Dati] index map BEFORE emitting [Riferimenti].
  // WinCut treats the reference `(N)` as a 1-based lookup into [Dati], NOT
  // as the optimizer's internal typeId.  If a piece type is referenced by
  // its raw typeId but the [Dati] index differs (very common when not every
  // type lands on every panel), WinCut reads past the end of the [Dati]
  // array, dereferences a null pointer, and crashes with an access violation
  // when the operator clicks the piece to inspect it.  Mapping by index here
  // keeps every reference inside the [Dati] range.
  const tidToDatiIdx = new Map();
  placed.forEach((t, i) => {
    tidToDatiIdx.set(t.id, i + 1);
    const xRefs = rows.filter(r => r.tid === t.id && r.type === 'X').length;
    const field5 = xRefs > 0 ? xRefs : 1;
    lines.push(`${i+1}=,,${t.placedOnThisPanel},CuttElab,,${field5},${t.w}.00,${t.h}.00,${panelT}.00,,0,${t.total}`);
  });
  lines.push('[Riferimenti]');
  rows.forEach((r, i) => {
    const idx = r.tid != null ? tidToDatiIdx.get(r.tid) : undefined;
    lines.push(`${i+1}=${idx ? '(' + idx + ')' : ''}`);
  });
  return lines.join('\r\n');
}

// ─────────────────────────────────────────────────────────────────────
// CROSS-PANEL ORCHESTRATOR — MULTI-SEED SEARCH
// ─────────────────────────────────────────────────────────────────────
//
// The naive approach (pick best single panel, repeat) doesn't minimize total
// panel count — sometimes packing 24 pieces on panel 1 forces 3 total panels
// when packing 14 on panel 1 yields just 2 total. So instead:
//
//   1. Generate ALL viable first-panel candidates (the candidate list from
//      packPanelBestOfMany, but we don't filter to just the top one).
//   2. For each candidate, simulate the entire job: play out remaining
//      panels greedily from there. Count total panels.
//   3. Pick the candidate with the FEWEST TOTAL PANELS (ties broken by
//      efficiency).
//   4. Commit only that candidate's first panel. Recurse.
//
// This is "expand top-K candidates by 1 step, score by full-rollout, pick best".
// Cost: ~K × N_panels × per-panel-time. For 4-8 candidates × 6-8 panels × 50ms
// per panel = 1.5-3 seconds total. Within timeout.
// ─────────────────────────────────────────────────────────────────────

// Generate ALL viable candidates for one panel — like packPanelBestOfMany but
// returns the sorted list, not just the winner. Caller picks via lookahead.
//
// Margins (under the corrected saw-operator model):
//   Both `trimEdge` and `trimSub` resolve to the same `headTrim` value.
//   Every saw pass starts with a head-trim cut. Pass 1 (panel) → RX/RY=headTrim.
//   Pass 2 (each strip) → RU/RV=headTrim. Pass 3 (each V-bar sub-band) → RV=headTrim.
//
// Pass cost (for the new cost function):
//   Each panel needs 1 pass-1 + (strips.length) pass-2s + (V-bar strips) pass-3s.
//   Lower passes = less material burned to head-trims, less operator time. The
//   saw operator confirmed Cutty's behavior: group pieces by shared dimension
//   into a single strip when possible, so multiple types share one pass-2.
function generateCandidates(types, panelL, panelW, kerf, trimEdge, trimSub, cutDir, opts) {
  // opts.fastMode: when true, skip the exponential allStripWidthCombos
  // enumeration and rely on greedy + shared-dim + V-bar variants only.
  // For 30+ piece types, allStripWidthCombos is intractable (30^maxStrips
  // paths) and produces redundant candidates anyway when used per-panel
  // by a greedy multi-panel orchestrator.
  //
  // AUTO-FASTMODE: even when the caller didn't ask for it, flip to fast
  // when the live distinct-dim count exceeds the safe limit.  Past ~8-10
  // types the unbounded enumerator easily blows the 540s function budget
  // (verified empirically: 10 types ~ 300s on a real job).  This guards
  // production jobs from hanging when the user imports a richly varied
  // material with many distinct dimensions (Fiber, MDF Rimeso Lisi,
  // Melamine Cotton, etc.).
  const liveTypeCount = (types || []).filter(t => t.rem > 0).length;
  const AUTO_FAST_THRESHOLD = 5;   // any non-trivial job auto-enables fast
  const fastMode = !!(opts && opts.fastMode) || liveTypeCount > AUTO_FAST_THRESHOLD;
  // Multi-sub-strip Y offcuts: when true, generate variants where Y-strip
  // offcuts pack multiple sub-strips (denser per panel but consume more
  // filler types). Default off so per-panel greedy doesn't get misled by
  // the higher placedCount of these locally-optimal-but-globally-bad picks.
  // B&B (set-cover over the full pool) sets this true to gain candidate
  // variety.
  const multiOffcut = !!(opts && opts.multiOffcut);
  const candidates = [];

  // Compute pass count for a candidate. Used both as a tiebreaker in the
  // composite score and as part of the dedup signature so layouts with same
  // density-but-different pass-cost don't collapse onto each other.
  const computePasses = (cand) => {
    if (!cand.strips) return 1;
    let passes = 1 + cand.strips.length;  // pass 1 + per-strip pass 2
    for (const st of cand.strips) {
      const vBarCount = (st.vBars && st.vBars.length) || 0;
      passes += vBarCount;  // each V-bar adds a pass 3
    }
    return passes;
  };

  const tryCandidate = (c) => {
    if (!c || c.placedCount <= 0) return;
    c.passes = computePasses(c);
    candidates.push(c);
  };

  if (cutDir === 'X' || cutDir === 'auto') {
    // X-mode strip widths run left→right: reserve the panel LEFT RX
    // (trimEdge, explicit first row) AND the RIGHT edge (trimEdge, no row).
    const availL = panelL - 2 * trimEdge;
    // X-mode reserves trimEdge at the top (implicit, no row) on top of the
    // per-strip RU=trimSub at the bottom of each vertical strip.
    const availW = panelW - trimSub - trimEdge;
    const r = packXGreedy(types, availL, availW, kerf, trimEdge, trimSub);
    if (r.strips.length > 0) {
      const placedArea = r.strips.reduce((s, st) => {
        const a = st.uQty * st.stripW * st.uPh;
        const v = st.vBars.reduce((aa, bb) => aa + bb.vQty * bb.vPw * bb.barH, 0);
        return s + a + v;
      }, 0);
      const placedCount = r.strips.reduce(
        (s, st) => s + st.uQty + st.vBars.reduce((a, b) => a + b.vQty, 0), 0);
      tryCandidate({
        mode: 'X', strips: r.strips, placedCount,
        eff: placedArea / (panelL * panelW),
        score: placedCount * 1000 + Math.round(placedArea / (panelL * panelW) * 1000),
        finalRem: r.finalRem,
      });
    }
  }

  if (cutDir === 'Y' || cutDir === 'auto') {
    // Reserve left RX (trimSub) + right panel edge (trimEdge, no row).
    const availL = panelL - trimSub - trimEdge;
    // Bottom RY (trimEdge) explicit + top edge (trimEdge) implicit.
    const availW = panelW - 2 * trimEdge;
    const r = packYGreedy(types, availL, availW, kerf, trimSub);
    if (r.strips.length > 0) {
      const placedArea = r.strips.reduce((s, st) => {
        const a = st.primaryCuts.reduce((aa, c) => aa + c.qty * c.pw * c.ph, 0);
        const o = (st.offcuts || []).reduce(
          (aa, oc) => aa + oc.uCuts.reduce(
            (bb, u) => bb + u.uQty * oc.xPw * u.uPh, 0), 0);
        return s + a + o;
      }, 0);
      tryCandidate({
        mode: 'Y', strips: r.strips, placedCount: r.score,
        eff: placedArea / (panelL * panelW),
        score: r.score * 1000 + Math.round(placedArea / (panelL * panelW) * 1000),
        finalRem: r.finalRem,
      });
    }
  }

  // Combinatorial strip-width enumeration. Each call enumerates all
  // sequences of up to ~6 strip widths drawn from piece dimensions, packing
  // each. With ~3-7 types this is fast (< 1s) and produces hundreds of
  // good candidates. With 30+ types it explodes (30^6 paths) and is
  // skipped via fastMode.
  if (!fastMode) {
    if (cutDir === 'X' || cutDir === 'auto') {
      const allX = allStripWidthCombos(types, panelL, panelW, kerf, trimEdge, trimSub, 'X', false, multiOffcut);
      for (const r of allX) tryCandidate(r);
    }
    if (cutDir === 'Y' || cutDir === 'auto') {
      const allY = allStripWidthCombos(types, panelL, panelW, kerf, trimEdge, trimSub, 'Y', false, multiOffcut);
      for (const r of allY) tryCandidate(r);
    }
    if (cutDir === 'X' || cutDir === 'auto') {
      const uniformX = allStripWidthCombos(types, panelL, panelW, kerf, trimEdge, trimSub, 'X', true, multiOffcut);
      for (const r of uniformX) tryCandidate(r);
    }
  }

  // ─── Bounded multi-strip combos ────────────────────────────────────────
  // Runs even in fastMode: limits the dim set to top 8 by demand-area, so
  // 8^6 ≈ 262K paths (vs 30^6 ≈ 730M in unbounded). Generates the multi-
  // strip patterns that match Cutty's mixed-X-zone layouts. Only runs in
  // fastMode (in slow mode, allStripWidthCombos already covers this and
  // more).
  if (fastMode && (cutDir === 'X' || cutDir === 'Y' || cutDir === 'auto')) {
    addBoundedStripCombos(types, panelL, panelW, kerf, trimEdge, trimSub, cutDir, tryCandidate, multiOffcut);
  }

  // ─── Same-dimension grouping strategy ─────────────────────────────────
  if (cutDir === 'X' || cutDir === 'Y' || cutDir === 'auto') {
    addSharedDimensionCandidates(types, panelL, panelW, kerf, trimEdge, trimSub, cutDir, tryCandidate, multiOffcut);
  }

  // De-duplicate by mode + placedCount + eff + passes + strip-count.
  // The previous dedup ignored strip-count, which collapsed layouts of
  // identical density-but-different pass-cost onto one survivor (whichever
  // came first). Including stripCount preserves the lower-pass variant.
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    const stripCount = c.strips ? c.strips.length : 0;
    const sig = `${c.mode}|${c.placedCount}|${c.eff.toFixed(4)}|${c.passes}|${stripCount}`;
    if (!seen.has(sig)) { seen.add(sig); unique.push(c); }
  }

  // Sort: panels-aware lexicographic. Within the candidates of one panel,
  // we don't know "panels" yet (that comes from rollout). So at the per-panel
  // level: sort by placedCount (desc), then by passes (asc), then by eff (desc).
  // This gives top-K the densest-AND-fewest-passes layouts first.
  unique.sort((a, b) => {
    if (a.placedCount !== b.placedCount) return b.placedCount - a.placedCount;
    if (a.passes !== b.passes) return a.passes - b.passes;
    return b.eff - a.eff;
  });
  return unique;
}

// Bounded multi-strip enumerator. Like allStripWidthCombos but with the
// candidate dimension set restricted to the top-K most-promising values
// (by frequency × area). With K=8 and maxStrips=6, the search is 8^6 ≈
// 262K paths — fast enough to run alongside fastMode.
//
// This closes the Cutty gap on jobs where the dominant single strip leaves
// useful X-tail space that fits 2-4 smaller strips (e.g. Ermir Kurti P2:
// X=2250 + X=250 + X=120 + X=100 packs 14 pieces vs our X=2250 + X=477
// packs 8). The unbounded enumerator handles this but explodes for >8
// types; this bounded variant catches the common case without blowup.
function addBoundedStripCombos(types, panelL, panelW, kerf, trimEdge, trimSub, cutDir, tryCandidate, allowMultiOffcut) {
  const live = types.filter(t => t.rem > 0);
  if (live.length === 0) return;

  // Wall-clock soft cap.  Bumped to 4 s (was 1.5 s) so big-grain jobs can
  // explore enough strip schedules to find the densest panel count.  When
  // grain ("Ruaj Ujerat") is on, every PDF row is its own type — identical-
  // dim materials present 30+ types where a non-grain run had ~10.  The
  // 3-panel-vs-2-panel difference on a 33-type Mel.Rimeso job came down to
  // the recur enumerator not getting to enumerate [395, 395, 395, 395, 95]
  // (4× same-h grain band + a thin 95-strip on top).  The same-height +
  // same-plus-one-off passes below catch that pattern in O(dims × maxK)
  // time, which is FAR cheaper than recur (dims^maxStrips), so we can also
  // bump maxStrips back up without blowing the budget.
  const __budgetMs = 4000;
  const __t0 = Date.now();
  let __aborted = false;

  // recurMaxStrips and topDimsCap apply only to the MIXED-height recur at
  // the end; the same-h / one-off passes that come first don't depend on
  // these.  Larger type counts still trim the recur tree (the inner
  // packPanelYWithHeightsAll grows O(types × leads)), but Pass 1/2 ensure
  // dominant patterns are still reachable.
  const recurMaxStrips =
      live.length <= 8  ? 6 :
      live.length <= 16 ? 5 :
      live.length <= 24 ? 4 :
      3;
  const topDimsCap =
      live.length <= 8  ? 8 :
      live.length <= 16 ? 6 :
      live.length <= 24 ? 5 :
      5;

  // Score each piece DIMENSION by (total demand area on this dim).
  // A dim that appears in many high-demand types ranks high.
  const dimScore = new Map();
  for (const t of live) {
    for (const d of [t.w, t.h]) {
      const otherD = (d === t.w) ? t.h : t.w;
      const sc = t.rem * d * otherD;
      dimScore.set(d, (dimScore.get(d) || 0) + sc);
    }
  }
  const topDims = [...dimScore.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topDimsCap)
    .map(([d]) => d);
  if (topDims.length === 0) return;

  const availL = panelL - 2 * trimEdge;
  const availW = panelW - 2 * trimEdge;
  const seenSigs = new Set();

  // Helpers — encapsulate the abort check + dedupe + tryCandidate calls so
  // every pass below shares the same emission discipline.
  function emitY(combo) {
    if (__aborted) return;
    if (Date.now() - __t0 > __budgetMs) { __aborted = true; return; }
    const results = packPanelYWithHeightsAll(types, combo, panelL, panelW, kerf, trimEdge, trimSub, allowMultiOffcut);
    for (const r of results) {
      const sig = `Yb|${r.placedCount}|${r.eff.toFixed(4)}|${r.strips.map(s=>s.primaryCuts[0]?.typeId).join(',')}`;
      if (!seenSigs.has(sig)) { seenSigs.add(sig); tryCandidate(r); }
    }
  }
  function emitX(combo) {
    if (__aborted) return;
    if (Date.now() - __t0 > __budgetMs) { __aborted = true; return; }
    const result = packPanelXWithWidths(types, combo, panelL, panelW, kerf, trimEdge, trimSub, false);
    if (result) {
      const sig = `Xb|${result.placedCount}|${result.eff.toFixed(4)}`;
      if (!seenSigs.has(sig)) { seenSigs.add(sig); tryCandidate(result); }
    }
  }

  // ── PASS 1: SAME-HEIGHT (cheap, exhaustive on viable dims) ──
  // For each viable strip dimension d in topDims, try k uniform strips for
  // k=1..maxFit.  Crucial for high-type-count grain jobs: the recur path
  // shrinks `recurMaxStrips` below the natural panel-fit (often 4-5 same-h
  // strips), so the dominant "4 strips of 395-mm grain pieces" layout is
  // unreachable through recur alone.  Cost: O(numDims × maxFit) calls to
  // the inner packer — typically < 50 calls total.
  for (const d of topDims) {
    if (__aborted) break;
    if (d <= 0) continue;
    if ((cutDir === 'Y' || cutDir === 'auto') && d <= availW) {
      const maxK = Math.floor((availW + kerf) / (d + kerf));
      for (let k = 1; k <= maxK && !__aborted; k++) {
        emitY(new Array(k).fill(d));
      }
    }
    if ((cutDir === 'X' || cutDir === 'auto') && d <= availL) {
      const maxK = Math.floor((availL + kerf) / (d + kerf));
      for (let k = 1; k <= maxK && !__aborted; k++) {
        emitX(new Array(k).fill(d));
      }
    }
  }

  // ── PASS 2: SAME-HEIGHT-PLUS-ONE-OFF ──
  // Extend each uniform [h1 × k] combo with one strip of a different height
  // h2.  Catches "4 strips of 395 + 1 strip of 95" patterns common when a
  // PDF mixes long thin pieces (Panel: 1265×95, 2665×100) with regular
  // shelves.  Without this pass, the recur tree can't reach combos of
  // length > recurMaxStrips, so 33-type inputs (recurMaxStrips=3) miss the
  // 5-strip optimum.  Cost: O(numDims² × maxFit) ~ 100-200 calls.
  for (const h1 of topDims) {
    if (__aborted) break;
    if (h1 <= 0) continue;
    if ((cutDir === 'Y' || cutDir === 'auto') && h1 <= availW) {
      const maxK = Math.floor((availW + kerf) / (h1 + kerf));
      // Loop k=1..maxK INCLUSIVE so the user-observed pattern of [h1×maxK + h2]
      // (the panel is filled top-to-bottom with same-h grain strips with one
      // small h2 cap-strip on top) is reachable.  k<maxK would skip it.  The
      // remW check below still rules out h2 values that don't fit.
      for (let k = 1; k <= maxK && !__aborted; k++) {
        // k h1-strips consume k×h1 + (k-1)×kerf; adding an h2 strip needs a
        // separating kerf before it, so total = k×h1 + k×kerf + h2.  remW is
        // the slack available for h2 (and counts the separating kerf).
        const used = k * h1 + k * kerf;
        const remW = availW - used;
        if (remW <= 0) continue;
        for (const h2 of topDims) {
          if (__aborted) break;
          if (h2 === h1 || h2 <= 0 || h2 > remW) continue;
          emitY(new Array(k).fill(h1).concat([h2]));
        }
      }
    }
    if ((cutDir === 'X' || cutDir === 'auto') && h1 <= availL) {
      const maxK = Math.floor((availL + kerf) / (h1 + kerf));
      for (let k = 1; k <= maxK && !__aborted; k++) {
        const used = k * h1 + k * kerf;
        const remL = availL - used;
        if (remL <= 0) continue;
        for (const w2 of topDims) {
          if (__aborted) break;
          if (w2 === h1 || w2 <= 0 || w2 > remL) continue;
          emitX(new Array(k).fill(h1).concat([w2]));
        }
      }
    }
  }

  // ── PASS 3: BOUNDED MIXED-HEIGHT (recursive) ──
  // Generic recursion through topDims × recurMaxStrips.  Provides diversity
  // for irregular layouts that Pass 1/2 miss (e.g. three distinct strip
  // heights on one panel).  Bounded by both recurMaxStrips (depth) and the
  // budget cap above, and seenSigs dedupes duplicates emitted by Passes 1/2.
  function recurX(combo, used) {
    if (__aborted) return;
    if (Date.now() - __t0 > __budgetMs) { __aborted = true; return; }
    if (combo.length > 0) emitX(combo);
    if (combo.length >= recurMaxStrips) return;
    for (const w of topDims) {
      const newUsed = used + w + (combo.length > 0 ? kerf : 0);
      if (newUsed > availL) continue;
      combo.push(w);
      recurX(combo, newUsed);
      combo.pop();
    }
  }
  function recurY(combo, used) {
    if (__aborted) return;
    if (Date.now() - __t0 > __budgetMs) { __aborted = true; return; }
    if (combo.length > 0) emitY(combo);
    if (combo.length >= recurMaxStrips) return;
    for (const h of topDims) {
      const newUsed = used + h + (combo.length > 0 ? kerf : 0);
      if (newUsed > availW) continue;
      combo.push(h);
      recurY(combo, newUsed);
      combo.pop();
    }
  }
  if (cutDir === 'X' || cutDir === 'auto') recurX([], 0);
  if (cutDir === 'Y' || cutDir === 'auto') recurY([], 0);
}

// Generate "shared dimension" candidates: for each pair of types that
// share one dimension, produce a layout grouping them.
function addSharedDimensionCandidates(types, panelL, panelW, kerf, trimEdge, trimSub, cutDir, tryCandidate, allowMultiOffcut) {
  const live = types.filter(t => t.rem > 0);
  if (live.length < 2) return;  // need at least 2 piece types to group

  // Find all shared dimensions across types. A "shared dimension" is a value
  // that appears as either width or height in 2+ types.
  const dimToTypes = new Map();  // dim → [{typeId, otherDim, orientation, ...}]
  for (const t of live) {
    // Grain types only contribute their fixed orientation (W along X means
    // ph = t.h is the only valid Y-strip height for this piece). Non-grain
    // contribute both orientations.
    const orients = t.grainLock
      ? [[t.w, t.h, 'wh']]
      : [[t.w, t.h, 'wh'], [t.h, t.w, 'hw']];
    for (const [pw, ph, orientation] of orients) {
      // For each piece type and orientation, ph (height) is the candidate
      // shared dim. We index by ph.
      if (!dimToTypes.has(ph)) dimToTypes.set(ph, []);
      dimToTypes.get(ph).push({
        typeId: t.id, t,
        groupDim: ph,   // the shared dimension (becomes strip height in Y-mode)
        otherDim: pw,   // the dimension along the strip
      });
    }
  }

  for (const [sharedDim, members] of dimToTypes.entries()) {
    // Filter to UNIQUE typeIds (a type might appear twice from both orientations)
    const uniqTypeIds = new Set();
    const uniqMembers = [];
    for (const m of members) {
      const k = `${m.typeId}|${m.otherDim}`;
      if (!uniqTypeIds.has(k)) { uniqTypeIds.add(k); uniqMembers.push(m); }
    }
    if (uniqMembers.length < 2) continue;
    // Don't bother with very small shared dims that won't combine usefully
    if (sharedDim < 50) continue;

    // ── Y-mode candidate: one strip of height = sharedDim, holding all
    //     uniq members side-by-side along X.
    if (cutDir === 'Y' || cutDir === 'auto') {
      // Use the existing packPanelYWithHeightsAll([sharedDim]) which calls
      // bestStripFill internally. That packer already handles multi-type fills.
      const ys = packPanelYWithHeightsAll(types, [sharedDim], panelL, panelW, kerf, trimEdge, trimSub, allowMultiOffcut);
      for (const r of ys) tryCandidate(r);
    }

    // ── X-mode candidate: one strip of width = sharedDim, with members
    //     stacked along Y. This works only if all members' otherDim < panelW.
    if (cutDir === 'X' || cutDir === 'auto') {
      // X-mode "strip of width = sharedDim" requires that one piece type has
      // pw = sharedDim. We use `packPanelXWithWidths` with widths=[sharedDim].
      // It expects there to be a piece of that strip width available.
      const xs = packPanelXWithWidths(types, [sharedDim], panelL, panelW, kerf, trimEdge, trimSub);
      if (xs) tryCandidate(xs);
      const xsUniform = packPanelXWithWidths(types, [sharedDim], panelL, panelW, kerf, trimEdge, trimSub, true);
      if (xsUniform) tryCandidate(xsUniform);
    }
  }
}

// Greedy rollout from a given first-panel candidate. Plays the rest of the
// job, at each step trying top-N candidates and picking the one that leads
// to the best continuation. This is bounded BFS/best-first search.
//
// rolloutTopN: how many candidates to consider at each step inside the rollout.
//              Higher = better quality but quadratic cost. 1=greedy.
function rolloutFrom(firstPanel, panelL, panelW, kerf, trimEdge, trimSub, cutDir, maxRollout = 30, rolloutTopN = 3) {
  const out = [firstPanel];
  let types = firstPanel.finalRem;
  let safety = 0;
  while (types.some(t => t.rem > 0) && safety++ < maxRollout) {
    // Try scheme reuse first (cheap)
    const prev = out[out.length - 1];
    const replay = tryReplayLayout(prev, types, panelL, panelW, kerf, trimEdge, trimSub);
    if (replay && replay.placedCount === prev.placedCount) {
      out.push(replay);
      types = replay.finalRem;
      continue;
    }

    // Generate candidates and pick the one whose own greedy rollout is shortest
    const cands = generateCandidates(types, panelL, panelW, kerf, trimEdge, trimSub, cutDir);
    if (cands.length === 0) break;
    const top = cands.slice(0, rolloutTopN);
    let bestNext = null;
    for (const c of top) {
      // Mini-rollout with depth-1 greedy
      const sub = greedyRolloutFrom(c, panelL, panelW, kerf, trimEdge, trimSub, cutDir, maxRollout - safety);
      if (sub.remaining > 0) continue;
      const score = -sub.panels.length;
      if (!bestNext || score > bestNext.score) bestNext = { score, cand: c, sub };
    }
    if (!bestNext) break;
    out.push(bestNext.cand);
    types = bestNext.cand.finalRem;
  }
  const remaining = types.reduce((s, t) => s + t.rem, 0);
  return { panels: out, remaining };
}

// Pure greedy rollout (always picks top-1 candidate). Cheap inner loop.
function greedyRolloutFrom(firstPanel, panelL, panelW, kerf, trimEdge, trimSub, cutDir, maxRollout = 30) {
  const out = [firstPanel];
  let types = firstPanel.finalRem;
  let safety = 0;
  while (types.some(t => t.rem > 0) && safety++ < maxRollout) {
    const prev = out[out.length - 1];
    const replay = tryReplayLayout(prev, types, panelL, panelW, kerf, trimEdge, trimSub);
    if (replay && replay.placedCount === prev.placedCount) {
      out.push(replay);
      types = replay.finalRem;
      continue;
    }
    const cands = generateCandidates(types, panelL, panelW, kerf, trimEdge, trimSub, cutDir);
    if (cands.length === 0) break;
    out.push(cands[0]);
    types = cands[0].finalRem;
  }
  const remaining = types.reduce((s, t) => s + t.rem, 0);
  return { panels: out, remaining };
}

function runOptimizerCore(input) {
  const { panelL, panelW, panelT, kerf, trimX, trimY, supplier, cutDir, raw } = input;

  // Margin model (corrected per saw operator interview, 2026):
  //   Every saw pass starts with a "head trim" cut — the saw chops a fixed
  //   `headTrim` mm off the leading edge of whatever's being fed in. This
  //   applies on every pass: pass 1 (raw panel), pass 2 (rotated strip),
  //   pass 3 (rotated sub-band for V-bars). Default value is 10mm but is
  //   operator-configurable via the saw's `skuadrim` field.
  //
  //   The opposite end (the "tail") is just leftover material — no cut is
  //   reserved there. Between pieces inside a single pass: just kerf, no
  //   extra margin.
  //
  //   In WinCut format terms: RX, RY, RU, RV are all the head-trim of one
  //   pass each, so they all carry the same value (`headTrim`).
  //
  // Public API note:
  //   We keep `trimX` and `trimY` as input fields for backward compatibility
  //   with the v12 client. We unify them: the saw can't tell which axis is
  //   "X" vs "Y" until we choose a feed direction, so a single value suffices.
  //   We use max(trimX, trimY) so we never under-reserve. If the caller
  //   passes an explicit `headTrim`, that takes precedence.
  const headTrim = (typeof input.headTrim === 'number')
    ? input.headTrim
    : Math.max(trimX || 0, trimY || 0);

  // Internally we keep the names `trimEdge` and `trimSub` for symmetry with
  // older code, but under the new model they are identical (both = headTrim).
  // This is intentional: the saw's behavior makes no distinction between
  // "panel-edge trim" and "in-strip trim" — every pass starts with a head
  // trim, period.
  const trimEdge = headTrim;
  const trimSub = headTrim;

  let allTypes = consolidate(raw);
  const committedPanels = [];
  let prevRem = raw.length;
  let safetyCounter = 0;
  const SAFETY_LIMIT = 200;
  // TOP_K = how many candidate first-panels we lookahead-evaluate per panel
  // decision.  Each costs a full rollout (≤30 panels × N sub-cands), so for
  // jobs with many distinct types the 25-seed default multiplies into a
  // multi-minute hang even after fastMode trims allStripWidthCombos.  Scale
  // down with type count: small jobs keep the wide search (better layout);
  // bigger jobs drop to a few seeds (good-enough layout, finishes in time).
  const _initialLiveTypes = allTypes.filter(t => t.rem > 0).length;
  const TOP_K =
      _initialLiveTypes <= 5  ? 25 :
      _initialLiveTypes <= 8  ? 12 :
      _initialLiveTypes <= 12 ? 6  :
      3;

  while (allTypes.some(t => t.rem > 0)) {
    if (++safetyCounter > SAFETY_LIMIT) break;

    let chosen = null;

    if (committedPanels.length > 0) {
      const prev = committedPanels[committedPanels.length - 1];
      const replay = tryReplayLayout(prev, allTypes, panelL, panelW, kerf, trimEdge, trimSub);
      if (replay && replay.placedCount === prev.placedCount) {
        chosen = replay;
      }
    }

    if (!chosen) {
      const cands = generateCandidates(allTypes, panelL, panelW, kerf, trimEdge, trimSub, cutDir);
      if (cands.length === 0) break;

      // Multi-seed lookahead: rollout each of the top-K candidates greedily
      // and score each by lexicographic ordering:
      //   (1) Panel count — fewer wins. A panel costs real money.
      //   (2) Total saw passes — fewer wins. A pass costs ~10mm head-trim
      //       material burn + operator time. Per saw operator: passes per
      //       panel = 1 + strips.length + (V-bars), so reducing strips
      //       (via same-dimension grouping) AND avoiding V-bars both help.
      //   (3) Total area placed — denser wins ties. Better offcuts.
      //
      // Implementation: a single composite score with weights large enough
      // that lower priorities can never overturn higher ones. Panel count
      // has the largest weight; any saw-pass cost can NEVER justify an
      // extra panel (that would burn way more material than any pass-savings).
      const topK = cands.slice(0, TOP_K);

      let bestRollout = null;
      for (const cand of topK) {
        const ro = rolloutFrom(cand, panelL, panelW, kerf, trimEdge, trimSub, cutDir);
        if (ro.remaining > 0) continue;
        const totalArea = ro.panels.reduce((s, p) => s + p.eff * (panelL * panelW), 0);
        // Total passes across all panels in this rollout.
        // Each panel: 1 pass-1 + (strips.length) pass-2s + (V-bars) pass-3s.
        const totalPasses = ro.panels.reduce((sum, panel) => {
          if (!panel.strips) return sum + 1;
          let p = 1 + panel.strips.length;
          for (const st of panel.strips) p += (st.vBars && st.vBars.length) || 0;
          return sum + p;
        }, 0);
        // Lexicographic composite (higher = better):
        //   panel count: ×1e12 (so a +1 panel costs more than any other delta)
        //   total area:  ×100 (rounded mm²; denser wins ties on panels+passes)
        //   passes:      ×-1e6 (negative → fewer passes wins; ranks above area)
        // Wait: we want ordering panels → passes → eff (area). So passes
        // should rank above area. Use a high negative weight on passes that
        // exceeds the max possible area swing.
        //   Max area per panel ≈ 5e6 mm². Weight on area = 100 → max area
        //   contribution ≈ 5e8 per panel. A single pass weight needs to
        //   exceed that to dominate. Use 1e10.
        const score = -ro.panels.length * 1e14
                    - totalPasses * 1e10
                    + Math.round(totalArea) * 100;
        if (!bestRollout || score > bestRollout.score) {
          bestRollout = { score, cand, totalPanels: ro.panels.length, totalPasses };
        }
      }
      if (!bestRollout) chosen = cands[0];
      else chosen = bestRollout.cand;
    }

    if (!chosen) break;

    const remBefore = cp(allTypes);
    allTypes = chosen.finalRem;
    const newRem = allTypes.reduce((s, t) => s + t.rem, 0);
    if (newRem >= prevRem) break;
    prevRem = newRem;

    const snap = remBefore.map(t => {
      const after = allTypes.find(a => a.id === t.id);
      return { ...t, placedOnThisPanel: t.rem - (after ? after.rem : 0) };
    });

    // Render. rowsY uses trimEdge for the panel's RY and trimSub for each strip's RX.
    // rowsX uses trimEdge for the panel's RX and pulls per-strip RU/RV from
    // strip/V-bar objects (already set to trimSub during packing).
    const rows = chosen.mode === 'Y'
      ? rowsY(chosen.strips, trimSub, trimEdge)
      : rowsX(chosen.strips, trimEdge, trimSub);
    const content = genFileContent(panelL, panelW, panelT, supplier, rows, snap, 3000, 32);

    committedPanels.push({
      strips: chosen.strips,
      mode: chosen.mode,
      rows,
      content,
      eff: Math.round(chosen.eff * 100),
      placedCount: chosen.placedCount,
      // Keep finalRem on the panel so rollout can use it for replay
      finalRem: chosen.finalRem,
      // Keep the per-type [Dati] snapshot so the final-panel absorber can
      // re-emit a modified panel's .txt (internal; stripped from output).
      snap,
    });
  }

  // ── FINAL-PANEL ABSORBER ────────────────────────────────────────────
  // The per-panel optimizer minimizes panel COUNT but does not push a
  // leftover near-empty trailing panel's pieces back into the empty
  // offcut / V-bar space of the panels already committed (committed
  // panels are frozen during the search, and the combinatorial search
  // only fills ONE offcut sub-strip per strip — multi-offcut there is
  // exponential).  This single post-pass closes that gap: if the LAST
  // panel is clearly sparse, try to place EVERY one of its pieces into
  // the already-empty leftover space of the earlier panels (their
  // primary layout and placed pieces are never touched — we only append
  // into empty material).  It reuses the production-validated
  // fitYStripOffcuts / fillVBars packers and the rowsX/Y → genFileContent
  // emitter, whose assertWincutRowsValid tripwire guarantees a valid
  // .txt.  ALL-OR-NOTHING: the last panel is dropped only if EVERY piece
  // finds a legal home; on any shortfall or emission error the
  // optimizer's original output is kept verbatim.  Cost: O(panels ×
  // strips × types), one pass — zero impact on the search time budget.
  try {
    if (committedPanels.length >= 2) {
      const last = committedPanels[committedPanels.length - 1];
      const ABSORB_EFF_MAX = 45;            // only a clearly-sparse tail panel
      if (last.eff <= ABSORB_EFF_MAX) {
        // Pieces on the last panel = the pool that entered it = the
        // second-to-last panel's finalRem (the last panel drained it).
        const pool = cp(committedPanels[committedPanels.length - 2].finalRem)
                       .filter(t => t.rem > 0);
        const availL  = panelL - trimSub - trimEdge;   // Y primary X-budget
        const availWX = panelW - trimSub - trimEdge;   // X-mode vertical budget
        // Work on deep clones so any failure leaves committedPanels intact.
        const work = committedPanels.slice(0, -1).map(p => ({
          ...p,
          strips: JSON.parse(JSON.stringify(p.strips)),
          snap: p.snap.map(s => ({ ...s })),
        }));
        for (const ep of work) {
          if (!pool.some(t => t.rem > 0)) break;
          const before = new Map(pool.map(t => [t.id, t.rem]));
          if (ep.mode === 'Y') {
            for (const st of ep.strips) {
              const sumQty = st.primaryCuts.reduce((s, c) => s + c.qty, 0);
              const xPrim = st.primaryCuts.reduce((s, c) => s + c.qty * c.pw, 0)
                          + (sumQty - 1) * kerf;
              const xOff = (st.offcuts || []).reduce((s, o) => s + o.xPw + kerf, 0);
              const remL = availL - xPrim - kerf - xOff;
              if (remL <= 0) continue;
              const extra = fitYStripOffcuts(pool, remL, st.stripH, kerf, trimSub);
              if (extra.length) st.offcuts = (st.offcuts || []).concat(extra);
            }
          } else {
            for (const st of ep.strips) {
              let uUsed = (st.ru || trimSub) + (st.uQty || 0) * st.uPh
                        + Math.max(0, (st.uQty || 0) - 1) * kerf;
              for (const vb of (st.vBars || [])) uUsed += vb.barH + kerf;
              const more = fillVBars(pool, st.stripW, uUsed, availWX, kerf, trimSub);
              if (more.length) st.vBars = (st.vBars || []).concat(more);
            }
          }
          // Record what THIS panel absorbed → bump its [Dati] snapshot.
          for (const t of ep.snap) {
            const b = before.get(t.id);
            if (b == null) continue;
            const af = (pool.find(p => p.id === t.id) || {}).rem;
            const took = b - (af == null ? 0 : af);
            if (took > 0) t.placedOnThisPanel = (t.placedOnThisPanel || 0) + took;
          }
        }
        if (!pool.some(t => t.rem > 0)) {
          // Every leftover piece found a home. Re-emit each modified
          // earlier panel; a malformed result throws (assertWincutRowsValid)
          // and is caught below, keeping the original output.
          for (const ep of work) {
            const rows = ep.mode === 'Y'
              ? rowsY(ep.strips, trimSub, trimEdge)
              : rowsX(ep.strips, trimEdge, trimSub);
            const content = genFileContent(panelL, panelW, panelT, supplier,
                                           rows, ep.snap, 3000, 32);
            let area = 0, cnt = 0;
            if (ep.mode === 'Y') {
              for (const st of ep.strips) {
                for (const c of st.primaryCuts) { area += c.qty * c.pw * c.ph; cnt += c.qty; }
                for (const oc of (st.offcuts || [])) for (const u of oc.uCuts) {
                  area += u.uQty * oc.xPw * u.uPh; cnt += u.uQty;
                }
              }
            } else {
              for (const st of ep.strips) {
                area += (st.uQty || 0) * st.stripW * st.uPh; cnt += (st.uQty || 0);
                for (const vb of (st.vBars || [])) { area += vb.vQty * vb.vPw * vb.barH; cnt += vb.vQty; }
              }
            }
            ep.rows = rows;
            ep.content = content;
            ep.eff = Math.round(area / (panelL * panelW) * 100);
            ep.placedCount = cnt;
          }
          // Commit: drop the now-redundant last panel.
          committedPanels.length = 0;
          for (const ep of work) committedPanels.push(ep);
        }
      }
    }
  } catch (e) {
    console.error('[finalPanelAbsorber] skipped, original layout kept:',
                  e && e.message);
  }

  // Strip internal-only fields from output (not part of public API)
  const panels = committedPanels.map(p => {
    const { finalRem, snap, ...pub } = p;
    return pub;
  });

  return { panels };
}

// Try to replay a prior panel's layout onto the current remaining pieces.
// Returns a result-shaped object if successful, null if it can't reuse.
function tryReplayLayout(prev, types, panelL, panelW, kerf, trimEdge, trimSub) {
  // Walk prev.strips and consume from `types`. If any piece is unavailable,
  // bail out.
  const rem = cp(types);
  const newStrips = [];
  if (prev.mode === 'X') {
    for (const st of prev.strips) {
      const t = rem.find(r => r.id === st.typeId);
      if (!t || t.rem < st.uQty) return null;
      t.rem -= st.uQty;
      // Replay V-bars
      const newVBars = [];
      for (const vb of st.vBars) {
        const vt = rem.find(r => r.id === vb.typeId);
        if (!vt || vt.rem < vb.vQty) return null;
        vt.rem -= vb.vQty;
        newVBars.push({ ...vb });
      }
      newStrips.push({
        typeId: st.typeId, stripW: st.stripW, uPh: st.uPh,
        uQty: st.uQty, ru: st.ru, vBars: newVBars,
      });
    }
  } else {
    for (const st of prev.strips) {
      // primary cuts
      const newPrim = [];
      for (const c of st.primaryCuts) {
        const t = rem.find(r => r.id === c.typeId);
        if (!t || t.rem < c.qty) return null;
        t.rem -= c.qty;
        newPrim.push({ ...c });
      }
      // Replay offcuts (handles both new array schema and legacy single offcut).
      const prevOffcuts = normalizeYOffcuts(st);
      const newOffcuts = [];
      let offcutPlaced = 0;
      let replayOk = true;
      for (const oc of prevOffcuts) {
        const newUCuts = [];
        for (const u of oc.uCuts) {
          const t = rem.find(r => r.id === u.typeId);
          if (!t || t.rem < u.uQty) { replayOk = false; break; }
          t.rem -= u.uQty;
          newUCuts.push({ ...u });
          offcutPlaced += u.uQty;
        }
        if (!replayOk) break;
        newOffcuts.push({ xPw: oc.xPw, ru: oc.ru, uCuts: newUCuts });
      }
      if (!replayOk) return null;
      newStrips.push({
        stripH: st.stripH, primaryCuts: newPrim, offcuts: newOffcuts,
        placed: newPrim.reduce((s, c) => s + c.qty, 0) + offcutPlaced,
      });
    }
  }

  // Compute area & eff for the replayed layout (matches packed-panel calculation)
  let placedArea = 0, placedCount = 0;
  if (prev.mode === 'X') {
    for (const st of newStrips) {
      placedArea += st.uQty * st.stripW * st.uPh;
      placedCount += st.uQty;
      for (const vb of st.vBars) {
        placedArea += vb.vQty * vb.vPw * vb.barH;
        placedCount += vb.vQty;
      }
    }
  } else {
    for (const st of newStrips) {
      for (const c of st.primaryCuts) {
        placedArea += c.qty * c.pw * c.ph;
        placedCount += c.qty;
      }
      for (const oc of (st.offcuts || [])) {
        for (const u of oc.uCuts) {
          placedArea += u.uQty * oc.xPw * u.uPh;
          placedCount += u.uQty;
        }
      }
    }
  }

  return {
    mode: prev.mode, strips: newStrips, placedCount,
    eff: placedArea / (panelL * panelW),
    score: placedCount * 1000 + Math.round(placedArea / (panelL * panelW) * 1000),
    finalRem: rem,
  };
}

// ─────────────────────────────────────────────────────────────────────
// VALIDATION (unchanged from v1)
// ─────────────────────────────────────────────────────────────────────
function validateInput(d) {
  if (!d || typeof d !== 'object') return 'Të dhënat mungojnë.';
  const numFields = ['panelL', 'panelW', 'panelT', 'kerf', 'trimX', 'trimY'];
  for (const f of numFields) {
    if (typeof d[f] !== 'number' || !Number.isFinite(d[f]) || d[f] < 0) {
      return `Fusha "${f}" duhet të jetë numër pozitiv.`;
    }
  }
  // trimSub is optional. If absent, defaults to 2.4 (just-above-kerf — the
  // floor of what's safe for sub-cuts inside an already-separated strip).
  // If present, must be a non-negative number.
  if (d.trimSub !== undefined) {
    if (typeof d.trimSub !== 'number' || !Number.isFinite(d.trimSub) || d.trimSub < 0) {
      return 'Margjina e brendshme (trimSub) duhet të jetë numër jo-negativ.';
    }
  }
  if (d.panelL > 10000 || d.panelW > 10000) return 'Dimensionet e panelit jashtë kufirit.';
  if (typeof d.supplier !== 'string') return 'Furnitori mungon.';
  if (!['X', 'Y', 'auto'].includes(d.cutDir)) return 'Drejtimi i prerjes i pavlefshëm.';
  if (!Array.isArray(d.raw) || d.raw.length === 0) return 'Lista e copave është bosh.';
  if (d.raw.length > 5000) return 'Shumë copa për një bllok të vetëm.';
  for (const p of d.raw) {
    if (!p || typeof p.w !== 'number' || typeof p.h !== 'number' ||
        p.w <= 0 || p.h <= 0 || !Number.isFinite(p.w) || !Number.isFinite(p.h)) {
      return 'Copë me dimensione të pavlefshme.';
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// PUBLIC CALLABLE
// ─────────────────────────────────────────────────────────────────────
exports.runOptimizer = onCall(
  { cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Duhet të jeni i kyçur.');
    }
    const validationErr = validateInput(request.data);
    if (validationErr) {
      throw new HttpsError('invalid-argument', validationErr);
    }
    try {
      return runOptimizerCore(request.data);
    } catch (err) {
      console.error('[runOptimizer] internal error:', err);
      throw new HttpsError('internal', 'Optimizimi dështoi. Provo përsëri.');
    }
  }
);

// Exports for testing
exports._test = { runOptimizerCore, consolidate, generateCandidates, rolloutFrom };