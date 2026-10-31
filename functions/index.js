// ═══════════════════════════════════════════════════════════════════════
// INCO Furniture Optimizer — v4 (strip-native B&B)
// ═══════════════════════════════════════════════════════════════════════
//
// Pipeline:
//   1. consolidate raw pieces → types.
//   2. generateCandidates (v2's strip-native generator) → array of
//      WinCut-format panel candidates {mode, strips, eff, ...}.
//   3. dominanceFilter → prune covered candidates.
//   4. setCoverBB → pick fewest-panels subset whose union covers demand.
//   5. Render each picked candidate's strips directly via rowsX/rowsY +
//      genFileContent. No extraction, no fallback.
//
// Why this design:
//   - Candidates are WinCut-native from generation. There is no impedance
//     mismatch between the optimizer's output and the saw format, so there
//     is no need to extract strips from coords, and no fallback re-pack path.
//   - B&B set-cover is optimal under the candidate set, replacing v2's
//     greedy multi-seed rollout (which was the slow path on big inputs).
// ═══════════════════════════════════════════════════════════════════════

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions }   = require('firebase-functions/v2');

setGlobalOptions({
  region:         'europe-west1',
  memory:         '2GiB',
  timeoutSeconds: 540,
  maxInstances:   10,
});

const v2 = require('./lib/v2packer');
const algo = require('./lib/algorithm');

const { consolidate, generateCandidates, rowsX, rowsY, genFileContent,
        packXGreedy, packYGreedy, fitYStripOffcuts, buildYCandidate,
        orientations, MIN_INNER_TRIM, assertWincutRowsValid } = v2;
const { setCoverBB, dominanceFilter } = algo;

// ─────────────────────────────────────────────────────────────────────
// Derive the consumption map (typeId → qty placed) from a strip-native
// candidate. setCoverBB and dominanceFilter both index by this.
// ─────────────────────────────────────────────────────────────────────
// Normalize a Y strip's offcut(s) into the canonical array form. Accepts
// the new `offcuts: array` form, the legacy single `offcut: object` form,
// or absence — always returns an array.
function normalizeYOffcuts(st) {
  if (Array.isArray(st.offcuts)) return st.offcuts;
  if (st.offcut) return [{
    xPw: st.offcut.xPw, ru: st.offcut.ru,
    uCuts: [{ typeId: st.offcut.typeId, uPh: st.offcut.uPh, uQty: st.offcut.uQty }],
  }];
  return [];
}

function computeConsumption(cand) {
  const cons = {};
  if (cand.mode === 'X') {
    for (const st of cand.strips) {
      cons[st.typeId] = (cons[st.typeId] || 0) + st.uQty;
      for (const vb of (st.vBars || [])) {
        cons[vb.typeId] = (cons[vb.typeId] || 0) + vb.vQty;
      }
    }
  } else {
    for (const st of cand.strips) {
      for (const pc of st.primaryCuts) {
        cons[pc.typeId] = (cons[pc.typeId] || 0) + pc.qty;
      }
      for (const oc of normalizeYOffcuts(st)) {
        for (const u of oc.uCuts) {
          cons[u.typeId] = (cons[u.typeId] || 0) + u.uQty;
        }
      }
    }
  }
  return cons;
}

// ─────────────────────────────────────────────────────────────────────
// Sum of strip extents along the stacking axis.
//   Y-mode: strips stacked vertically → sum of stripH + (n-1)*kerf
//   X-mode: strips arranged side-by-side → sum of stripW + (n-1)*kerf
// ─────────────────────────────────────────────────────────────────────
function usedAxis(strips, mode, kerf) {
  if (strips.length === 0) return 0;
  if (mode === 'Y') {
    return strips.reduce((s, st) => s + st.stripH, 0) + (strips.length - 1) * kerf;
  }
  return strips.reduce((s, st) => s + st.stripW, 0) + (strips.length - 1) * kerf;
}

// ─────────────────────────────────────────────────────────────────────
// Compute placedArea (total piece area) from a strip-list.
// ─────────────────────────────────────────────────────────────────────
function placedAreaOf(strips, mode) {
  if (mode === 'X') {
    return strips.reduce((s, st) => {
      const a = st.uQty * st.stripW * st.uPh;
      const v = (st.vBars || []).reduce((aa, bb) => aa + bb.vQty * bb.vPw * bb.barH, 0);
      return s + a + v;
    }, 0);
  }
  return strips.reduce((s, st) => {
    const a = st.primaryCuts.reduce((aa, c) => aa + c.qty * c.pw * c.ph, 0);
    const o = normalizeYOffcuts(st).reduce(
      (aa, oc) => aa + oc.uCuts.reduce(
        (bb, u) => bb + u.uQty * oc.xPw * u.uPh, 0), 0);
    return s + a + o;
  }, 0);
}

// ─────────────────────────────────────────────────────────────────────
// Augment a candidate by filling its leftover panel extent with extra
// strips drawn from the still-unplaced demand.
//
// The most common failure mode of v2's per-panel candidate generators is
// "single strip + huge empty rest" — happens when `addSharedDimensionCandidates`
// emits a one-strip layout that out-scores `packYGreedy`'s multi-strip
// layout on placedCount. This function fixes that uniformly: whatever
// candidate was picked, fill the remaining extent panel-end-to-panel-end
// using the same greedy that packYGreedy/packXGreedy would have used.
//
// Returns either the original (if nothing more fits) or a new candidate
// with concatenated strips, recomputed consumption/placedCount/eff.
// ─────────────────────────────────────────────────────────────────────
function augmentCandidate(cand, availableRem, panelL, panelW, kerf, trimEdge, trimSub) {
  // availableRem: array of { id, w, h, rem, total } — pieces the caller
  // is willing to add to this panel's leftover extent. The caller sets
  // .rem to the actual quantity available; this function does NOT subtract
  // cand.consumption (callers compute that themselves).
  if (!cand || !cand.strips || cand.strips.length === 0) return cand;
  if (!availableRem || availableRem.every(r => r.rem === 0)) return cand;

  const used = usedAxis(cand.strips, cand.mode, kerf);
  let cont;
  if (cand.mode === 'Y') {
    // Strips stack along the panelW (Y) axis.  Reserve trimEdge on BOTH the
    // bottom (RY row) and the top edge (no row enforces it) — same model the
    // candidate packer uses, so continuation strips don't overflow into the
    // top trim margin.
    const remaining = (panelW - 2 * trimEdge) - used - kerf;
    if (remaining < 100) return cand;
    cont = packYGreedy(availableRem, panelL - trimSub, remaining, kerf, trimSub);
  } else {
    // X-mode: reserve top trim (trimEdge) on top of the per-strip RU (trimSub).
    const remaining = (panelL - trimEdge) - used - kerf;
    if (remaining < 100) return cand;
    cont = packXGreedy(availableRem, remaining, panelW - trimSub - trimEdge, kerf, trimEdge, trimSub);
  }
  if (!cont || cont.strips.length === 0) return cand;

  const newStrips = cand.strips.concat(cont.strips);
  return rebuildCandidate(cand, newStrips, panelL, panelW);
}

// ─────────────────────────────────────────────────────────────────────
// Back-fill pass.
// After greedy produces N panels, try to fully absorb the LAST panel's
// pieces into the leftover extents of earlier panels. If successful,
// drop the last panel and repeat. The last panel is dropped only when ALL
// its pieces fit elsewhere; partial moves are kept (the last panel is then
// trimmed to what is still on it). Earlier panels are only ever extended:
// pass A stacks into existing sub-columns, pass B appends whole strips,
// pass C (placeIntoStrips) adds pieces inside existing strips.
//
// This is the "go back and recheck if there's space left in the first
// panels" idea — applied iteratively from the end.
// ─────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────
// Stack additional same-xPw pieces in existing Y-mode offcut sub-strips.
// Walks every strip's offcuts, computes the residual height left over the
// current uCut stack, and appends one more uCut group of the best matching
// type from the pool. Pure intra-panel tightening — never adds new strips
// or offcuts, only fills gaps that the original packer left empty.
// Mutates `pool[i].rem` to reflect anything consumed.
// ─────────────────────────────────────────────────────────────────────
function fillExistingOffcuts(cand, pool, kerf, panelL, panelW) {
  if (!cand || cand.mode !== 'Y' || !cand.strips) return cand;
  let changed = false;
  const newStrips = cand.strips.map(st => {
    const offs = normalizeYOffcuts(st);
    if (offs.length === 0) return st;
    const newOffcuts = offs.map(oc => {
      const totalPieces = oc.uCuts.reduce((s, u) => s + u.uQty, 0);
      const usedH = (oc.ru || 0) +
                    oc.uCuts.reduce((s, u) => s + u.uQty * u.uPh, 0) +
                    Math.max(0, totalPieces - 1) * kerf;
      const remH = st.stripH - usedH - kerf;
      if (remH <= 0) return oc;
      const addedUCuts = [];
      let curRemH = remH;
      // Greedy stack: keep adding same-xPw types while space permits.
      const safety = 6;
      for (let s = 0; s < safety; s++) {
        let best = null, bestScore = 0;
        for (const xt of pool.filter(p => p.rem > 0)) {
          for (const [xw, xh] of [[xt.w, xt.h], [xt.h, xt.w]]) {
            if (Math.abs(xw - oc.xPw) > 0.5) continue;
            if (xh > curRemH) continue;
            const maxQ = Math.floor((curRemH + kerf) / (xh + kerf));
            const q = Math.min(maxQ, xt.rem);
            if (q < 1) continue;
            const sc = q * xw * xh;
            if (sc > bestScore) { bestScore = sc; best = { id: xt.id, uPh: xh, uQty: q }; }
          }
        }
        if (!best) break;
        addedUCuts.push({ typeId: best.id, uPh: best.uPh, uQty: best.uQty });
        pool.find(p => p.id === best.id).rem -= best.uQty;
        curRemH -= kerf + best.uQty * best.uPh + (best.uQty - 1) * kerf;
        changed = true;
      }
      if (addedUCuts.length === 0) return oc;
      return { ...oc, uCuts: [...oc.uCuts, ...addedUCuts] };
    });
    if (!changed) return st;
    const stCopy = { ...st };
    delete stCopy.offcut;
    return { ...stCopy, offcuts: newOffcuts };
  });
  if (!changed) return cand;
  return rebuildCandidate(cand, newStrips, panelL, panelW);
}

// ─────────────────────────────────────────────────────────────────────
// Back-fill pass C: place leftover pieces INSIDE the existing strips of an
// earlier panel. (Inco Furniture 103 sec 1: one 340×94 piece was left
// alone on a 5th board while board 4 had 41 mm of free height — a new
// 94 mm strip needs 98.4 mm, so passes A/B could not use it; by hand the
// 80 mm strip was simply raised to 94.)
//
// Three placements are tried for every leftover piece, in every strip:
//   (1) an extra primary cut of exactly the strip's size (free length);
//   (2) a new sub-column (Y: X/RU/U; X: U/RV/V) in the strip's free length,
//       with the packer's own column fit model;
//   (3) grow the strip to the piece's height (Y) / width (X), paid from the
//       board's spare along the stacking axis; the piece becomes the new
//       full-size primary and the strip's former primaries are demoted to
//       single-piece sub-columns under an inner trim (the manual editor's
//       layout for a short piece in a tall strip). Needs old size + trim
//       ≤ new size; any trim-kerf tightness is then handled by
//       repairTightColumns like every other column.
// Free placements (1)(2) always win over growth; growth prefers the
// smallest increase, then the fewest demoted pieces. Along the strip every
// new element reserves a trailing kerf (the primary fitters' model). The
// result must pass the WinCut grammar tripwire or the panel is returned
// untouched. `pool[i].rem` is reduced by what was placed.
// ─────────────────────────────────────────────────────────────────────
function placeIntoStrips(cand, pool, kerf, panelL, panelW, trimEdge, trimSub) {
  if (!cand || !cand.strips || cand.strips.length === 0) return cand;
  if (!pool || !pool.some(p => p.rem > 0) || !(kerf > 0)) return cand;
  const mode = cand.mode === 'X' ? 'X' : 'Y';
  const EPS = 0.01;
  const strips = JSON.parse(JSON.stringify(cand.strips));
  const work = pool.map(p => ({ ...p }));
  const innerRu = Math.min(trimSub, MIN_INNER_TRIM);
  // Spare along the stacking axis. Y mirrors augmentCandidate (trimEdge on
  // both edges); X keeps the edge trim plus one trailing kerf.
  let spare = mode === 'Y'
    ? (panelW - 2 * trimEdge) - usedAxis(strips, 'Y', kerf)
    : (panelL - trimEdge - kerf) - usedAxis(strips, 'X', kerf);
  // Free length after the last element, a kerf reserved behind every element.
  const freeY = st => {
    let used = 0;
    for (const c of (st.primaryCuts || [])) used += c.qty * (c.pw + kerf);
    for (const oc of normalizeYOffcuts(st)) used += oc.xPw + kerf;
    return (panelL - trimSub) - used;
  };
  const freeX = st => {
    let used = trimSub + (st.uQty || 0) * (st.uPh + kerf);
    for (const vb of (st.vBars || [])) used += vb.barH + kerf;
    return (panelW - trimSub - trimEdge) - used;
  };
  const fitKerf = (free, size, max) => Math.min(max, Math.floor(free / (size + kerf) + 1e-9));
  const better = (a, b) => !b || a.rank < b.rank ||
    (a.rank === b.rank && (a.area > b.area + 1e-9 ||
      (Math.abs(a.area - b.area) <= 1e-9 && (a.grow < b.grow - 1e-9 ||
        (Math.abs(a.grow - b.grow) <= 1e-9 && a.conv < b.conv)))));
  let changed = false;
  for (let guard = 0; guard < 64; guard++) {
    let best = null;
    for (const t of work) {
      if (!(t.rem > 0)) continue;
      for (const [pw, ph] of orientations(t)) {
        for (const st of strips) {
          if (mode === 'Y') {
            const free = freeY(st);
            if (Math.abs(ph - st.stripH) <= EPS) {
              const q = fitKerf(free, pw, t.rem);
              if (q < 1) continue;
              const opt = { t, rank: 0, area: q * pw * ph, grow: 0, conv: 0, apply: () => {
                (st.primaryCuts = st.primaryCuts || []).push({ typeId: t.id, pw, ph: st.stripH, qty: q });
                return q; } };
              if (better(opt, best)) best = opt;
            } else if (ph < st.stripH) {
              if (pw + kerf > free + 1e-9) continue;
              let ru = null;
              for (const r of [trimSub, MIN_INNER_TRIM]) {
                if (r > trimSub) continue;
                if (ph + r <= st.stripH + 1e-9) { ru = r; break; }
              }
              if (ru == null) continue;
              const q = Math.min(t.rem, Math.floor((st.stripH - ru + kerf) / (ph + kerf) + 1e-9));
              if (q < 1) continue;
              const opt = { t, rank: 1, area: q * pw * ph, grow: 0, conv: 0, apply: () => {
                const offs = normalizeYOffcuts(st).slice();
                offs.push({ xPw: pw, ru, uCuts: [{ typeId: t.id, uPh: ph, uQty: q }] });
                delete st.offcut; st.offcuts = offs;
                return q; } };
              if (better(opt, best)) best = opt;
            } else {
              const grow = ph - st.stripH;
              if (grow > spare + 1e-9) continue;
              if (st.stripH + innerRu > ph + 1e-9) continue;   // demoted pieces must fit under their trim
              const prim = st.primaryCuts || [];
              if (!prim.length) continue;
              const q = fitKerf(free, pw, t.rem);
              if (q < 1) continue;
              const conv = prim.reduce((s, c) => s + c.qty, 0);
              const opt = { t, rank: 2, area: q * pw * ph, grow, conv, apply: () => {
                const cols = [];
                for (const c of prim) for (let k = 0; k < c.qty; k++)
                  cols.push({ xPw: c.pw, ru: innerRu, uCuts: [{ typeId: c.typeId, uPh: st.stripH, uQty: 1 }] });
                const offs = cols.concat(normalizeYOffcuts(st));
                st.stripH = ph;
                st.primaryCuts = [{ typeId: t.id, pw, ph, qty: q }];
                delete st.offcut; st.offcuts = offs;
                spare -= grow;
                return q; } };
              if (better(opt, best)) best = opt;
            }
          } else {
            const free = freeX(st);
            if (Math.abs(pw - st.stripW) <= EPS && st.typeId === t.id && Math.abs(ph - st.uPh) <= EPS) {
              const q = fitKerf(free, ph, t.rem);
              if (q < 1) continue;
              const opt = { t, rank: 0, area: q * pw * ph, grow: 0, conv: 0, apply: () => { st.uQty += q; return q; } };
              if (better(opt, best)) best = opt;
            } else if (pw + kerf <= st.stripW - trimSub + 1e-9) {
              if (ph > free + 1e-9) continue;                     // fillVBars: barH <= remainH
              const q = Math.min(t.rem, Math.floor((st.stripW - trimSub) / (pw + kerf) + 1e-9));
              if (q < 1) continue;
              const opt = { t, rank: 1, area: q * pw * ph, grow: 0, conv: 0, apply: () => {
                st.vBars = (st.vBars || []).concat([{ typeId: t.id, barH: ph, vPw: pw, vQty: q, ru: trimSub }]);
                return q; } };
              if (better(opt, best)) best = opt;
            } else if (pw > st.stripW + EPS) {
              const grow = pw - st.stripW;
              if (grow > spare + 1e-9) continue;
              if (st.stripW + innerRu + kerf > pw + 1e-9) continue;   // fillVBars model: ru + vPw + kerf <= stripW
              if (!(st.uQty > 0)) continue;
              const q = fitKerf(free, ph, t.rem);
              if (q < 1) continue;
              const opt = { t, rank: 2, area: q * pw * ph, grow, conv: st.uQty, apply: () => {
                const bands = [];
                for (let k = 0; k < st.uQty; k++)
                  bands.push({ typeId: st.typeId, barH: st.uPh, vPw: st.stripW, vQty: 1, ru: innerRu });
                st.vBars = bands.concat(st.vBars || []);
                st.stripW = pw; st.typeId = t.id; st.uPh = ph; st.uQty = q;
                spare -= grow;
                return q; } };
              if (better(opt, best)) best = opt;
            }
          }
        }
      }
    }
    if (!best) break;
    best.t.rem -= best.apply();
    changed = true;
  }
  if (!changed) return cand;
  // Grammar tripwire: never hand back a layout the renderer would reject.
  try {
    const rows = mode === 'Y' ? rowsY(strips, trimSub, trimEdge) : rowsX(strips, trimEdge, kerf);
    assertWincutRowsValid(rows, 'placeIntoStrips', { panelL, panelW, kerf });
  } catch (e) {
    return cand;
  }
  work.forEach((p, i) => { pool[i].rem = p.rem; });
  return rebuildCandidate(cand, strips, panelL, panelW);
}

function backfillPass(picks, types, panelL, panelW, kerf, trimEdge, trimSub, log) {
  let dropped = 0;
  let tightened = 0;
  outer: while (picks.length > 1) {
    const last = picks[picks.length - 1];
    const remaining = { ...last.consumption };
    const trial = picks.slice(0, -1);

    for (let i = 0; i < trial.length; i++) {
      // Build the available pool from what's still in `remaining`.
      // Grain-locked types are included — the packers honor no-rotation via
      // the grainLock flag, so backfill can move them too.
      const remView = types
        .map(t => ({ id: t.id, w: t.w, h: t.h, grainLock: t.grainLock, groupId: t.groupId,
                     rem: remaining[t.id] || 0,
                     total: remaining[t.id] || 0 }))
        .filter(t => t.rem > 0);
      if (remView.length === 0) break;

      // Pass A: stack additional same-xPw pieces in existing offcut sub-strips
      // (Y-mode only). Cheap to attempt — only succeeds when the leftover panel
      // has an offcut whose width matches a remaining piece dimension.
      const before0 = { ...trial[i].consumption };
      const filled = fillExistingOffcuts(trial[i], remView, kerf, panelL, panelW);
      if (filled !== trial[i]) {
        for (const tid of Object.keys(filled.consumption)) {
          const delta = (filled.consumption[tid] || 0) - (before0[tid] || 0);
          if (delta > 0) {
            remaining[tid] = Math.max(0, (remaining[tid] || 0) - delta);
            if (remaining[tid] === 0) delete remaining[tid];
            const p = remView.find(p => p.id === Number(tid));
            if (p) p.rem = Math.max(0, p.rem - delta);
          }
        }
        trial[i] = filled;
        tightened++;
      }

      // Pass B: append entirely new strips along the panel's stacking axis.
      const before1 = { ...trial[i].consumption };
      const augmented = augmentCandidate(
        trial[i], remView.filter(p => p.rem > 0),
        panelL, panelW, kerf, trimEdge, trimSub
      );
      if (augmented !== trial[i]) {
        for (const tid of Object.keys(augmented.consumption)) {
          const delta = (augmented.consumption[tid] || 0) - (before1[tid] || 0);
          if (delta > 0) {
            remaining[tid] = Math.max(0, (remaining[tid] || 0) - delta);
            if (remaining[tid] === 0) delete remaining[tid];
          }
        }
        trial[i] = augmented;
      }

      // Pass C: place pieces inside the existing strips (new sub-column,
      // extra same-size piece, or grow a strip and demote its pieces).
      // The pool is rebuilt from `remaining` — pass B does not update remView.
      const remView2 = types
        .map(t => ({ id: t.id, w: t.w, h: t.h, grainLock: t.grainLock, groupId: t.groupId,
                     rem: remaining[t.id] || 0, total: remaining[t.id] || 0 }))
        .filter(t => t.rem > 0);
      if (remView2.length > 0) {
        const before2 = { ...trial[i].consumption };
        const placed = placeIntoStrips(trial[i], remView2, kerf, panelL, panelW, trimEdge, trimSub);
        if (placed !== trial[i]) {
          for (const tid of Object.keys(placed.consumption)) {
            const delta = (placed.consumption[tid] || 0) - (before2[tid] || 0);
            if (delta > 0) {
              remaining[tid] = Math.max(0, (remaining[tid] || 0) - delta);
              if (remaining[tid] === 0) delete remaining[tid];
            }
          }
          trial[i] = placed;
          tightened++;
        }
      }
    }

    if (Object.keys(remaining).length === 0) {
      // Fully absorbed — drop the last panel and try again.
      picks = trial;
      dropped++;
    } else {
      // Some pieces wouldn't fit. Keep any tightening that happened, but
      // don't drop the last panel.
      // Note: tightening earlier panels means those pieces moved out of
      // `last`. We need to update `last`'s consumption to reflect what's
      // still there (= original `remaining`).
      if (tightened > 0) {
        // Rebuild last to drop pieces that moved.
        const lastCons = picks[picks.length - 1].consumption;
        const stillThere = {};
        for (const tid of Object.keys(lastCons)) {
          const moved = (lastCons[tid] || 0) - (remaining[tid] || 0);
          const left = lastCons[tid] - moved;
          if (left > 0) stillThere[tid] = left;
        }
        // Trim the last panel to only what remains.
        const idxOf = new Map(types.map((t, i) => [t.id, i]));
        const remDemand = types.map(t => stillThere[t.id] || 0);
        const trimmed = trimCandidateInPlace(picks[picks.length - 1], remDemand, idxOf, panelL, panelW);
        const newPicks = trial.slice();
        if (trimmed) newPicks.push(trimmed);
        picks = newPicks;
      }
      break outer;
    }
  }
  if (log) log('backfill', `dropped=${dropped}${tightened ? ` tightened=${tightened}` : ''}`);
  return picks;
}

// ─────────────────────────────────────────────────────────────────────
// Rebuild a candidate with a new strip list. Recomputes consumption,
// placedCount, and eff from the strips themselves so the result is
// internally consistent.
// ─────────────────────────────────────────────────────────────────────
function rebuildCandidate(cand, newStrips, panelL, panelW) {
  const placedArea = placedAreaOf(newStrips, cand.mode);
  const newCons = {};
  let placedCount = 0;
  if (cand.mode === 'X') {
    for (const st of newStrips) {
      newCons[st.typeId] = (newCons[st.typeId] || 0) + st.uQty;
      placedCount += st.uQty;
      for (const vb of (st.vBars || [])) {
        newCons[vb.typeId] = (newCons[vb.typeId] || 0) + vb.vQty;
        placedCount += vb.vQty;
      }
    }
  } else {
    for (const st of newStrips) {
      for (const pc of st.primaryCuts) {
        newCons[pc.typeId] = (newCons[pc.typeId] || 0) + pc.qty;
        placedCount += pc.qty;
      }
      for (const oc of normalizeYOffcuts(st)) {
        for (const u of oc.uCuts) {
          newCons[u.typeId] = (newCons[u.typeId] || 0) + u.uQty;
          placedCount += u.uQty;
        }
      }
    }
  }
  return {
    ...cand,
    strips: newStrips,
    placedCount,
    eff: placedArea / (panelL * panelW),
    consumption: newCons,
  };
}

// ─────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────
// TIGHT-COLUMN REPAIR (post-processing only — never part of the search).
//
// On the shop saw a head trim (RX/RY/RU/RV) removes the trim value AND the
// blade kerf: the first piece starts at trim + kerf, not at trim. The
// packer's fitters count the kerf inside the trim, so a sub-strip column
// may be filled to within one kerf of the strip height (e.g. RU 10 + U 438
// in a 448 strip). The saw then has 4.4 mm less than the program assumes
// and the LAST piece of that column comes out short by (kerf − spare):
// the "3 mm smaller" pieces (Erion 125, Inco Furniture 103, Ersi Tarelli
// 101 …). The X-mode vBar fitter already reserves a trailing kerf, so only
// Y-mode columns (and manual X-mode vBars) can be tight.
//
// Repair: after ALL packing decisions are made (Step 4 render), lower the
// tight column's own trim (RU / RV) by exactly its deficit, in 0.1 mm
// steps, so trim + kerf lands where the plan assumed the pieces start.
// Nothing else moves: strip sizes, piece sizes, counts, order and
// efficiency are untouched (growing the strip instead would also grow its
// full-height primary pieces — that variant was wrong and is gone). The
// trim never drops below REPAIR_MIN_TRIM; a column that would need less is
// left as it is and counted in `tight`. Everything is done on copies; the
// candidate is never mutated.
// ─────────────────────────────────────────────────────────────────────
const REPAIR_MIN_TRIM = 5;   // mm; a 10 mm trim minus one 4.4 kerf is 5.6
function repairTightColumns(strips, mode, panelL, panelW, kerf, trimEdge) {
  const out = { strips, trimmed: 0, trimMm: 0, tight: 0 };
  if (!Array.isArray(strips) || !strips.length || !(kerf > 0)) return out;
  const trimNeed = ru => (ru > 0 ? ru + kerf : 0);       // what the saw consumes for a trim cut
  const ceil10 = v => Math.ceil(v * 10 - 1e-9) / 10;       // 0.1 mm steps, never less than the deficit
  const round1 = v => Math.round(v * 10) / 10;
  const copy = JSON.parse(JSON.stringify(strips));
  let changed = false;
  // Lower the group's trim by its deficit against `capacity`; true when tight.
  const fix = (group, used, capacity) => {
    const deficit = used - capacity;
    if (deficit <= 1e-6) return false;
    const cut = ceil10(deficit);
    const ru2 = round1((group.ru || 0) - cut);
    if (ru2 >= REPAIR_MIN_TRIM - 1e-9) { group.ru = ru2; out.trimmed++; out.trimMm += cut; changed = true; }
    else out.tight++;
    return true;
  };
  copy.forEach(st => {
    if (mode === 'Y') {
      const offs = normalizeYOffcuts(st);
      let touched = false;
      for (const oc of offs) {
        if (!oc.uCuts || !oc.uCuts.length) continue;
        let used = trimNeed(oc.ru || 0), q = 0;
        for (const u of oc.uCuts) { used += u.uPh * u.uQty; q += u.uQty; }
        used += kerf * Math.max(0, q - 1);
        if (fix(oc, used, st.stripH)) touched = true;
      }
      if (touched) { delete st.offcut; st.offcuts = offs; }   // write the normalized form back
    } else {
      for (const vb of (st.vBars || [])) {
        if (vb.typeId == null && !(vb.vQty > 0)) continue;   // empty spacer bar
        const used = trimNeed(vb.ru || 0) + vb.vPw * vb.vQty + kerf * Math.max(0, vb.vQty - 1);
        fix(vb, used, st.stripW);
      }
    }
  });
  if (!changed) return out;
  out.strips = copy;
  out.trimMm = round1(out.trimMm);
  return out;
}

// Render a strip-native candidate to a v2-compatible panel object.
// ─────────────────────────────────────────────────────────────────────
function buildPanelFromCandidate(cand, types, panelL, panelW, panelT, supplier, kerf, trimEdge, trimSub) {
  const { mode, consumption } = cand;
  // Tight-column repair happens here, on a copy, after the search is over.
  const repair = repairTightColumns(cand.strips, mode, panelL, panelW, kerf, trimEdge);
  const strips = repair.strips;
  const placedCount = cand.placedCount || Object.values(consumption).reduce((a, b) => a + b, 0);

  const snap = types.map(t => ({
    ...t,
    placedOnThisPanel: consumption[t.id] || 0,
  }));

  const rows = mode === 'Y'
    ? rowsY(strips, trimSub, trimEdge)
    : rowsX(strips, trimEdge, trimSub);
  const content = genFileContent(panelL, panelW, panelT, supplier, rows, snap, 3000, 32);

  return {
    strips, mode, rows, content,
    eff: Math.round(cand.eff * 100),
    placedCount,
    // Repair record (data only): column trims lowered for the saw's trim
    // kerf, and groups that could not be repaired (still cut one piece short).
    repair: { trimmed: repair.trimmed, trimMm: repair.trimMm, tight: repair.tight },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Build a single Y-mode panel that places grain-locked groups in
// dedicated bottom strips. Groups with smaller h sit at the bottom so
// the grain band of the shorter group is closest to the panel's bottom-
// left corner. Within a strip, multiple groups (and same-h non-grain
// fillers) co-exist as primary cuts; residual X width becomes an offcut
// stack for non-grain types via `fitYStripOffcuts`.
//
// `rem[].rem` is mutated to reflect what this panel consumed.
// Returns a candidate (mode/strips/eff/placedCount/consumption) or null
// if no grain pieces remain.
// ─────────────────────────────────────────────────────────────────────
function buildGrainPanel(remIn, panelL, panelW, kerf, trimEdge, trimSub) {
  // Work on a SHALLOW COPY so this function doesn't mutate the caller's rem.
  // The grain-strip placement decrements `.rem` on each type as it fits
  // pieces; if those decrements leaked back to the caller, greedyPack would
  // then subtract the consumption a second time and lose pieces.
  const rem = remIn.map(t => ({ ...t }));
  const grainRem = rem.filter(t => t.grainLock && t.rem > 0);
  if (grainRem.length === 0) return null;

  // Group grain types by their locked h (no rotation). Each h-group is
  // a separate strip; groups of equal h share their strip.
  const byH = new Map();
  for (const g of grainRem) {
    const arr = byH.get(g.h) || [];
    arr.push(g);
    byH.set(g.h, arr);
  }
  // Build strips LARGEST-h first.  This lets a tall strip absorb shorter
  // grain pieces into its leftover X-budget as offcut sub-strips, instead
  // of those small pieces each taking a near-empty strip of their own.
  // Pattern matching is preserved within each strip (all pieces in the
  // strip — primaries and offcuts — share the strip's horizontal band of
  // panel grain), while overall material usage drops sharply on jobs with
  // many distinct heights and few pieces per height.
  const hValues = [...byH.keys()].sort((a, b) => b - a);

  const availL = panelL - trimSub;
  // Bottom RY explicit + top edge implicit → both trimmed.
  const availW = panelW - 2 * trimEdge;
  const strips = [];
  const cons = {};

  let yUsed = 0;
  // Greedy strip-by-strip: each iteration, pick the smallest-h that still
  // has grain pieces and fits in the remaining panel-Y. Allows multiple
  // strips of the same h when a single group has more pieces than one
  // strip can hold.
  const stripSafetyMax = 200;
  for (let stripIter = 0; stripIter < stripSafetyMax; stripIter++) {
    const remH = availW - yUsed - (strips.length > 0 ? kerf : 0);
    if (remH <= 0) break;

    let h = -1;
    for (const cand of hValues) {
      if (cand > remH) continue;
      if (!byH.get(cand).some(g => g.rem > 0)) continue;
      h = cand;
      break;
    }
    if (h < 0) break;

    const groupsHere = byH.get(h).slice().sort((a, b) => (a.groupId || 0) - (b.groupId || 0));
    const primaryCuts = [];
    let xUsed = 0;
    let placedInStrip = 0;

    for (const g of groupsHere) {
      if (g.rem <= 0) continue;
      const remX = availL - xUsed;
      if (remX <= 0) break;
      const maxQ = Math.floor((remX + (xUsed > 0 ? kerf : 0)) / (g.w + kerf) + 1e-9);
      const q = Math.min(maxQ, g.rem);
      if (q < 1) continue;
      primaryCuts.push({ typeId: g.id, pw: g.w, ph: g.h, qty: q });
      cons[g.id] = (cons[g.id] || 0) + q;
      g.rem -= q;
      placedInStrip += q;
      xUsed += q * (g.w + kerf);
    }

    if (primaryCuts.length === 0) break;  // no grain piece fit; stop building strips

    // Fill remaining X with same-h non-grain primary cuts (rotation allowed
    // for non-grain types). This is the user-confirmed sharing rule.
    for (const t of rem.filter(x => !x.grainLock && x.rem > 0)) {
      const remX = availL - xUsed;
      if (remX <= 0) break;
      let placed = false;
      for (const [pw, ph] of [[t.w, t.h], [t.h, t.w]]) {
        if (Math.abs(ph - h) > 0.5) continue;
        if (pw > remX) continue;
        const maxQ = Math.floor((remX + (xUsed > 0 ? kerf : 0)) / (pw + kerf) + 1e-9);
        const q = Math.min(maxQ, t.rem);
        if (q < 1) continue;
        primaryCuts.push({ typeId: t.id, pw, ph, qty: q });
        cons[t.id] = (cons[t.id] || 0) + q;
        t.rem -= q;
        placedInStrip += q;
        xUsed += q * (pw + kerf);
        placed = true;
        break;
      }
      if (!placed) continue;
    }

    // Residual X width → offcut sub-strip(s).  Pool now includes BOTH non-
    // grain AND grain-locked pieces whose `h` is ≤ this strip's `h`.  Grain
    // pieces in an offcut still keep W along X (fitYStripOffcuts uses the
    // grain-aware `orientations(t)` helper), and they share the strip's
    // horizontal band — so direction-grain and within-strip pattern-grain
    // both hold.  This is the relaxation that recovers material on jobs
    // with many distinct heights, at the cost of pattern-matching across
    // strips for any same-type pieces that happen to split between primary
    // and absorbed placements.
    const offcutL = availL - xUsed;
    let offcuts = [];
    let offcutPlaced = 0;
    if (offcutL > 0) {
      const offcutPool = rem.filter(t => t.rem > 0).map(t => ({ ...t }));
      offcuts = fitYStripOffcuts(offcutPool, offcutL, h, kerf, trimSub);
      // Apply consumption from the offcut fitter back to `rem`.
      for (const oc of offcuts) {
        for (const u of oc.uCuts) {
          cons[u.typeId] = (cons[u.typeId] || 0) + u.uQty;
          const t = rem.find(r => r.id === u.typeId);
          if (t) t.rem -= u.uQty;
          offcutPlaced += u.uQty;
        }
      }
    }

    strips.push({ stripH: h, primaryCuts, offcuts, placed: placedInStrip + offcutPlaced });
    yUsed += h + (strips.length > 1 ? kerf : 0);
  }

  if (strips.length === 0) return null;

  // Fill remaining Y with non-grain Y-strips (regular packYGreedy).
  const remYBudget = availW - yUsed - kerf;
  if (remYBudget > 100) {
    const nonGrainPool = rem.filter(t => !t.grainLock && t.rem > 0)
      .map(t => ({ ...t }));
    if (nonGrainPool.length > 0) {
      const cont = packYGreedy(nonGrainPool, availL, remYBudget, kerf, trimSub);
      for (const st of cont.strips) {
        for (const pc of st.primaryCuts) {
          cons[pc.typeId] = (cons[pc.typeId] || 0) + pc.qty;
          const t = rem.find(r => r.id === pc.typeId);
          if (t) t.rem -= pc.qty;
        }
        for (const oc of (st.offcuts || [])) {
          for (const u of oc.uCuts) {
            cons[u.typeId] = (cons[u.typeId] || 0) + u.uQty;
            const t = rem.find(r => r.id === u.typeId);
            if (t) t.rem -= u.uQty;
          }
        }
        strips.push(st);
      }
    }
  }

  // Build the candidate object using rebuildCandidate's semantics.
  const placedArea = placedAreaOf(strips, 'Y');
  const placedCount = strips.reduce((s, st) => {
    const a = st.primaryCuts.reduce((aa, c) => aa + c.qty, 0);
    const o = (st.offcuts || []).reduce(
      (aa, oc) => aa + oc.uCuts.reduce((bb, u) => bb + u.uQty, 0), 0);
    return s + a + o;
  }, 0);
  return {
    mode: 'Y', strips, placedCount,
    eff: placedArea / (panelL * panelW),
    score: placedCount * 1000 + Math.round(placedArea / (panelL * panelW) * 1000),
    consumption: cons,
  };
}

// ─────────────────────────────────────────────────────────────────────
// ALIGN-GROUP PANEL BUILDER
// ─────────────────────────────────────────────────────────────────────
// "Grupi" rows in the UI carry an `alignGroup` color tag.  Pieces sharing
// that tag MUST be cut from the same vertical strip on a panel (an X-mode
// strip), so paired cabinet doors / fronts visually align AND share the
// same grain band.  This is the HIGHEST-priority constraint, ranked above
// material savings — see the customer's priority list:
//   1. No rotation (already enforced via orientations() for grain types)
//   2. Save material
//   3. Same-line grouping (soft tiebreaker in the regular path)
//
// This builder runs BEFORE the greedy/B&B pipeline.  Each group gets one
// or more vertical columns; columns are tightly packed onto panels; any
// leftover X-budget per panel is then filled with non-group pieces via
// packXGreedy so material isn't wasted.  Pieces consumed here are removed
// from the types[] handed to the regular packers.
// ─────────────────────────────────────────────────────────────────────
function buildAlignedGroupPanel(rem, panelL, panelW, kerf, trimEdge, trimSub) {
  const availL = panelL - 2 * trimEdge;          // X-axis budget for primary cuts
  const availW = panelW - 2 * trimEdge;          // Y-axis budget for strip stack
  const cons = {};

  // Bucket types by alignGroup → h → [types].  Y-mode lets multiple pieces
  // of the SAME h share one horizontal strip side-by-side along X, which is
  // far tighter than the X-mode-one-column-per-piece approach we tried first.
  // It also matches the customer's preference: "1× 1194×430 + 2× 335×430 on
  // the same line".  Different-h pieces of the same group land on adjacent
  // strips so the group stays visually clustered.
  const groupMap = new Map();
  for (const t of rem) {
    if (!t.alignGroup || t.rem <= 0) continue;
    if (!groupMap.has(t.alignGroup)) groupMap.set(t.alignGroup, new Map());
    const hMap = groupMap.get(t.alignGroup);
    if (!hMap.has(t.h)) hMap.set(t.h, []);
    hMap.get(t.h).push(t);
  }
  if (groupMap.size === 0) return null;

  // Sort groups by TOTAL AREA descending — densest groups go first so they
  // claim the panel.  Lighter groups then either piggyback on the same panel
  // (if they fit) or land on the next panel where the leftover-fill stage
  // gets a generous Y-budget to pack non-group pieces alongside them.  This
  // is what the customer expects from "group clustering doesn't have to waste
  // panels": cluster the heaviest group, then fill, repeat.
  const groupOrder = [...groupMap.entries()].sort(([, a], [, b]) => {
    const areaOf = hMap => [...hMap.entries()].reduce((s, [h, types]) =>
      s + types.reduce((ss, t) => ss + h * t.w * t.rem, 0), 0);
    return areaOf(b) - areaOf(a);
  });

  const strips = [];
  let yUsed = 0;

  for (const [, hMap] of groupOrder) {
    // Process h values largest-first so the tallest strips of the group sit
    // at the bottom of the panel (visual convention; cosmetic only).
    const hVals = [...hMap.keys()].sort((a, b) => b - a);
    for (const h of hVals) {
      const types = hMap.get(h);
      // Flatten to pieces, widest-first for first-fit-decreasing packing.
      const pool = [];
      for (const t of types) {
        for (let i = 0; i < t.rem; i++) pool.push({ typeId: t.id, w: t.w });
      }
      pool.sort((a, b) => b.w - a.w);

      while (pool.length > 0) {
        // Y-budget check: does another strip of height h fit on this panel?
        const stripYDelta = h + (yUsed > 0 ? kerf : 0);
        if (yUsed + stripYDelta > availW) break;

        // First-fit-decreasing pack into one strip.  Walk pool largest-first;
        // each piece that fits the remaining X-budget joins this strip.  The
        // pool keeps the rest for subsequent strips (or subsequent panels).
        const stripPieces = [];
        let xUsed = 0;
        for (let j = 0; j < pool.length; ) {
          const p = pool[j];
          const need = xUsed + (xUsed > 0 ? kerf : 0) + p.w;
          if (need <= availL) {
            stripPieces.push(p);
            pool.splice(j, 1);
            xUsed = need;
          } else {
            j++;
          }
        }
        if (stripPieces.length === 0) break;  // nothing fits even alone — give up

        // Emit primaryCuts, consolidating runs of identical (pw, typeId).
        const primaryCuts = [];
        let k = 0;
        while (k < stripPieces.length) {
          const sp = stripPieces[k];
          let qty = 1;
          while (k + qty < stripPieces.length &&
                 stripPieces[k + qty].w === sp.w &&
                 stripPieces[k + qty].typeId === sp.typeId) qty++;
          primaryCuts.push({ typeId: sp.typeId, pw: sp.w, ph: h, qty });
          cons[sp.typeId] = (cons[sp.typeId] || 0) + qty;
          k += qty;
        }
        strips.push({ stripH: h, primaryCuts, offcuts: [] });
        yUsed += stripYDelta;
      }
      // NOTE: previously this broke the H-loop when remaining Y couldn't fit
      // another h-strip.  That was a bug — it also skipped SMALLER h values
      // within the same group, even though they could still fit.  Removing
      // the break lets every h in this group get a chance.
    }
  }

  if (strips.length === 0) return null;

  // ── LEFTOVER FILL ──────────────────────────────────────────────────────
  // After group strips are placed, the leftover Y-budget can take a generous
  // amount of NON-GROUP pieces.  Per the customer's clarification: "the idea
  // of grouping is that you group a certain set of pieces together, but that
  // does not mean you cant fit other pieces in there — as long as the pieces
  // are together, you can optimize the rest of the panel as you normally
  // would by prioritizing the material waste."
  //
  // The fill pool ALSO includes pieces from groups already on this panel
  // whose stripe-packing left some leftover (they exceeded the strip's
  // X-budget); since their group is already clustered here, additional
  // pieces of those same groups can still join via offcut sub-strips.
  //
  // We run BOTH Y-mode greedy and X-mode greedy and keep whichever places
  // more pieces — this catches cases where the Y-leftover is too short for
  // tall pieces but X-mode columns would slot them in.
  const remYBudget = availW - yUsed - kerf;
  if (remYBudget > 100) {
    const groupsOnThisPanel = new Set();
    for (const tid of Object.keys(cons)) {
      const t = rem.find(r => r.id === Number(tid));
      if (t && t.alignGroup) groupsOnThisPanel.add(t.alignGroup);
    }
    const fillPool = rem
      .filter(t => t.rem - (cons[t.id] || 0) > 0)
      .filter(t => !t.alignGroup || groupsOnThisPanel.has(t.alignGroup))
      .map(t => ({ ...t, rem: t.rem - (cons[t.id] || 0) }));

    if (fillPool.length > 0) {
      // Try Y-mode fill (existing path).
      const contY = packYGreedy(
        fillPool.map(t => ({ ...t })), availL, remYBudget, kerf, trimSub);
      const yPlaced = contY && contY.strips
        ? contY.strips.reduce((s, st) =>
            s + (st.primaryCuts || []).reduce((a, c) => a + c.qty, 0) +
                (st.offcuts || []).reduce((a, o) =>
                  a + (o.uCuts || []).reduce((aa, u) => aa + u.uQty, 0), 0),
            0)
        : 0;

      // Try X-mode fill on the same leftover area — sub-strips run along the
      // X-axis with U-cuts stacking pieces vertically.  Picks up cases the
      // Y-mode greedy misses (e.g. several short-but-narrow pieces).
      const contX = packXGreedy(
        fillPool.map(t => ({ ...t })), availL, remYBudget, kerf, trimEdge, trimSub);
      // X-mode strips have their own schema — convert to Y-mode strip shape
      // so they can be appended alongside group strips that use Y-mode.
      // Each X-mode strip becomes one Y-strip with a single offcut sub-strip
      // holding the strip's U-pieces.
      let yFromX = null, xPlaced = 0;
      if (contX && contX.strips && contX.strips.length > 0) {
        const converted = [];
        // Group X-mode strips into one Y-strip with multiple sub-strips
        // since they all share the same Y-band (the leftover).
        const stripH = remYBudget;
        const offcuts = [];
        for (const xs of contX.strips) {
          // Each X-mode strip = a sub-strip in Y-mode (xPw=stripW, ru, uCuts).
          if (!xs.uPh || !xs.uQty) continue;
          offcuts.push({
            xPw: xs.stripW,
            ru: xs.ru || trimSub,
            uCuts: [{ typeId: xs.typeId, uPh: xs.uPh, uQty: xs.uQty }],
          });
          xPlaced += xs.uQty;
          // V-bars within this X-strip: add as additional uCut groups in the
          // same sub-strip (stacked above the primary uCut group).
          for (const vb of (xs.vBars || [])) {
            if (!vb.vQty) continue;
            // V-bars in X-mode are HORIZONTAL bands of vQty pieces side-by-
            // side at width vPw each.  In Y-mode-as-sub-strip form, those
            // pieces become uCuts at uPh=barH (the bar's height) but each
            // with its own xPw=vPw.  Emit them as separate sub-strips.
            for (let v = 0; v < vb.vQty; v++) {
              offcuts.push({
                xPw: vb.vPw,
                ru: vb.ru || trimSub,
                uCuts: [{ typeId: vb.typeId, uPh: vb.barH, uQty: 1 }],
              });
              xPlaced += 1;
            }
          }
        }
        if (offcuts.length > 0) {
          converted.push({ stripH, primaryCuts: [], offcuts });
          yFromX = converted;
        }
      }

      // Pick whichever variant placed more pieces.
      if (yPlaced >= xPlaced && contY && contY.strips) {
        for (const st of contY.strips) {
          strips.push(st);
          for (const pc of (st.primaryCuts || [])) {
            cons[pc.typeId] = (cons[pc.typeId] || 0) + pc.qty;
          }
          for (const oc of (st.offcuts || [])) {
            for (const u of oc.uCuts) cons[u.typeId] = (cons[u.typeId] || 0) + u.uQty;
          }
        }
      } else if (yFromX) {
        for (const st of yFromX) {
          strips.push(st);
          for (const oc of (st.offcuts || [])) {
            for (const u of oc.uCuts) cons[u.typeId] = (cons[u.typeId] || 0) + u.uQty;
          }
        }
      }
    }
  }

  // Compute placedCount + placedArea.
  let placedCount = 0, placedArea = 0;
  for (const st of strips) {
    for (const pc of st.primaryCuts) {
      placedCount += pc.qty;
      placedArea += pc.qty * pc.pw * pc.ph;
    }
    for (const oc of (st.offcuts || [])) {
      for (const u of oc.uCuts) {
        placedCount += u.uQty;
        placedArea += u.uQty * oc.xPw * u.uPh;
      }
    }
  }
  const eff = placedArea / (panelL * panelW);

  return {
    mode: 'Y',
    strips,
    placedCount,
    eff,
    score: placedCount * 1000 + Math.round(eff * 1000),
    consumption: cons,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Greedy panel-by-panel packer.
// For each panel, regenerate strip-native candidates against the current
// remaining demand and pick the best (most placedCount, then highest eff).
// Used as the primary path for big inputs, where B&B set-cover's branching
// factor is too high to converge in a reasonable time budget.
// ─────────────────────────────────────────────────────────────────────
function greedyPack(types, panelL, panelW, kerf, trimEdge, trimSub, cutDir, log) {
  // Working copy: each iteration shrinks .rem until all are 0.
  const rem = types.map(t => ({ ...t, rem: t.total, total: t.total }));
  const picks = [];
  const safetyMax = Math.max(200, types.reduce((s, t) => s + t.total, 0));
  let safety = safetyMax;

  while (rem.some(t => t.rem > 0) && safety-- > 0) {
    // Grain handling (priority order from customer):
    //   1. Never rotate grain-locked pieces — W stays along the X axis.
    //   2. Optimize for material savings (panel count first, then efficiency).
    //   3. If possible, prefer layouts that group same-type pieces into the
    //      same line — but ONLY when it doesn't cost (i.e. as a tiebreaker).
    //
    // Priority 1 is enforced INSIDE the packers (bestStripFill, packYGreedy,
    // packXGreedy, fillVBars, fitYStripOffcuts, dominantPiece) via the
    // `orientations(t)` helper, which returns only the natural orientation
    // for grain-locked types.  Nothing in this function needs grain-specific
    // logic — direction is preserved no matter which candidate wins.
    //
    // Priority 2 is the existing eff/placedCount/strips scoring below.
    // Priority 3 falls out of the "fewer strips" tiebreaker: a Y-mode layout
    // that fits all same-type pieces into one strip uses fewer strips than
    // an X-mode column placing the same pieces, so it wins ties.
    const liveTypes = rem.filter(t => t.rem > 0);
    if (liveTypes.length === 0) break;

    // For >8 live types, use fastMode (skip allStripWidthCombos enumeration).
    // packXGreedy + packYGreedy + addSharedDimensionCandidates produce ~5-10
    // good candidates per call, plenty for greedy to pick from.
    //
    // multiOffcut=true enables the multi-sub-strip offcut variants from
    // buildYCandidate.  Previously greedy was restricted to single-sub-strip
    // offcuts (the historical concern was that multi-offcut picks could be
    // "globally bad" per the buildYCandidate comment), but on grain-locked
    // PDFs with many same-h pieces that's exactly the pattern that closes
    // the panel-count gap — packing 4 narrow grain pieces side-by-side in a
    // single primary row's leftover is denser than reserving each in its
    // own strip.  generateCandidates' SAME-HEIGHT pass plus the per-candidate
    // dedup signature already keep the candidate set bounded.
    const opts = { fastMode: liveTypes.length > 8, multiOffcut: true };
    const cs = generateCandidates(liveTypes, panelL, panelW, kerf, trimEdge, trimSub, cutDir, opts);
    if (cs.length === 0) break;

    // Filter candidates to those whose consumption fits inside `rem`.
    //
    // REMNANT CONSOLIDATION (final-panel tiebreak):
    //   When the job ENDS on this panel (a candidate covers every remaining
    //   piece), all full-placement candidates tie on eff AND placedCount —
    //   they place the same pieces.  The old tiebreak ("fewer strips") then
    //   picked visually-simple layouts that sprawl across the panel and
    //   scatter the leftover into unusable gaps (e.g. two 764-tall strips
    //   at 54% fill).  Among job-finishing candidates we now prefer the one
    //   that consumes the LEAST of the panel along its stacking axis —
    //   leaving the largest contiguous full-width (Y-mode) / full-height
    //   (X-mode) remnant band the workshop can actually reuse ("resto").
    //
    //   Panel-count safety: this tiebreak only applies when BOTH candidates
    //   finish the job — the job ends with this panel either way, so total
    //   panel count is mathematically unchanged.  Non-final panels keep the
    //   existing comparator exactly.
    //
    //   We also prefer a job-FINISHING candidate over a non-finishing one on
    //   exact eff/placedCount ties (equal area, different piece mix): the
    //   finisher ends the job now, the other would strand pieces for one
    //   more panel — strictly fewer panels, never more.
    const _availY = panelW - 2 * trimEdge;       // Y-mode stacking budget
    const _availX = panelL - 2 * trimEdge;       // X-mode stacking budget
    // Contiguous leftover band area beyond the last strip (mode-fair:
    // compares Y-mode height-leftover × panel length against X-mode
    // width-leftover × panel width on equal footing).
    const bandAreaOf = (cc) => {
      if (!cc.strips || cc.strips.length === 0) return 0;
      const used = usedAxis(cc.strips, cc.mode, kerf);
      return cc.mode === 'Y'
        ? Math.max(0, _availY - used) * panelL
        : Math.max(0, _availX - used) * panelW;
    };
    const finishesJob = (cons) =>
      rem.every(t => t.rem <= 0 || (cons[t.id] || 0) >= t.rem);
    let best = null;
    let bestFinishes = false;
    for (const c of cs) {
      const cons = computeConsumption(c);
      let fits = true;
      for (const tid of Object.keys(cons)) {
        const t = rem.find(r => r.id === Number(tid));
        if (!t || cons[tid] > t.rem) { fits = false; break; }
      }
      if (!fits) continue;
      // Score: eff first (= area placed, since panel area is fixed), then
      // placedCount, then — on full ties — remnant band (job-finishing
      // candidates only) and fewer strips. Eff/placedCount take priority,
      // so intermediate-panel outcomes are byte-identical to the previous
      // comparator; the new rules only decide among tied candidates.
      const stripsOf = (cc) => (cc.strips && cc.strips.length) || 0;
      const take = () => { c.consumption = cons; best = c; bestFinishes = finishesJob(cons); };
      if (!best) {
        take();
      } else if (c.eff > best.eff + 1e-9) {
        take();
      } else if (Math.abs(c.eff - best.eff) <= 1e-9) {
        if (c.placedCount > best.placedCount) {
          take();
        } else if (c.placedCount === best.placedCount) {
          const cFinishes = finishesJob(cons);
          if (cFinishes && !bestFinishes) {
            // Same area+count but this one ends the job → strictly fewer panels.
            take();
          } else if (cFinishes && bestFinishes) {
            // Both end the job: maximize the contiguous remnant band, then
            // keep the old fewer-strips preference for true residual ties.
            const cBand = bandAreaOf(c), bBand = bandAreaOf(best);
            if (cBand > bBand + 1) take();
            else if (Math.abs(cBand - bBand) <= 1 && stripsOf(c) < stripsOf(best)) take();
          } else if (!cFinishes && !bestFinishes && stripsOf(c) < stripsOf(best)) {
            // Neither finishes: previous behavior, unchanged.
            take();
          }
        }
      }
    }
    if (!best) break;

    // ── FINAL-PANEL TIGHT REPACK ─────────────────────────────────────
    // When the job ends on this panel, the candidate pool rarely contains
    // the TIGHTEST full-placement layout (the bounded strip-schedule
    // enumerator explores same-height-heavy subtrees first and its wall
    // budget can expire before mixed tight schedules are reached).  So:
    // probe the production greedy packers directly with a SHRINKING
    // stacking budget (binary search) and keep the smallest budget that
    // still places every remaining piece.  If the resulting layout leaves
    // a larger contiguous remnant band than the chosen candidate, adopt
    // it (after a full render pre-validation so a malformed layout can
    // never replace a good one).
    //
    // Safety: runs ONLY when bestFinishes (job ends here regardless), uses
    // the same packers candidates are built from, and adoption requires
    // (a) full placement, (b) strictly better band, (c) clean rowsY/rowsX
    // + genFileContent render.  Cost: ~2×11 greedy probes on ≤ final-panel
    // piece counts — microseconds against the optimize budget.
    if (bestFinishes) {
      try {
        const remLive = rem.filter(t => t.rem > 0)
          .map(t => ({ ...t, total: t.rem }));
        const totArea = remLive.reduce((s, t) => s + t.w * t.h * t.rem, 0);
        const fullyPlaced = (res) => res && res.finalRem &&
          res.finalRem.every(t => t.rem <= 0);
        // Convert a raw packer result into a candidate via rebuildCandidate
        // (recomputes consumption/placedCount/eff from the strips).
        const toCand = (strips, mode) =>
          rebuildCandidate({ mode, strips }, strips, panelL, panelW);
        // Render pre-validation: the WinCut grammar tripwire inside
        // genFileContent throws on any malformed strip stream.
        const renders = (cand) => {
          try {
            const rows = cand.mode === 'Y'
              ? rowsY(cand.strips, trimSub, trimEdge)
              : rowsX(cand.strips, trimEdge, trimSub);
            const snap = remLive.map(t => ({
              ...t, placedOnThisPanel: cand.consumption[t.id] || 0 }));
            genFileContent(panelL, panelW, 18, 'probe', rows, snap, 3000, 32);
            return true;
          } catch (e) { return false; }
        };
        // Binary-search the smallest stacking budget with full placement.
        const probeMin = (packFn, hardLo, hardHi) => {
          let lo = hardLo, hi = hardHi, found = null;
          for (let it = 0; it < 12 && lo <= hi; it++) {
            const mid = Math.floor((lo + hi) / 2);
            const res = packFn(mid);
            if (fullyPlaced(res)) { found = res; hi = mid - 1; }
            else lo = mid + 1;
          }
          return found;
        };
        const availYTot = panelW - 2 * trimEdge;
        const availXTot = panelL - 2 * trimEdge;
        const yLo = Math.max(50, Math.floor(totArea / (panelL - trimSub - trimEdge)));
        const xLo = Math.max(50, Math.floor(totArea / (panelW - trimSub - trimEdge)));
        const tries = [];
        const yRes = probeMin(
          (H) => packYGreedy(remLive.map(t => ({ ...t })),
                             panelL - trimSub - trimEdge, H, kerf, trimSub),
          yLo, availYTot);
        if (yRes) tries.push(toCand(yRes.strips, 'Y'));
        const xRes = probeMin(
          (W) => packXGreedy(remLive.map(t => ({ ...t })),
                             W, panelW - trimSub - trimEdge, kerf, trimEdge, trimSub),
          xLo, availXTot);
        if (xRes) tries.push(toCand(xRes.strips, 'X'));

        // Probe family 3: EXACT strip-height combinations.  The greedy
        // probes above are bounded by dominant-piece ordering; a schedule
        // built from the pieces' own heights (e.g. [525, 500, 364]) often
        // packs the same job noticeably tighter.  Enumerate combos (k ≤ 4)
        // of the top strip heights by demand-area, build each via the
        // production buildYCandidate (no lead exploration — single pass),
        // and keep full-placement results.  ≤ ~330 cheap calls, final
        // panel only.
        if (typeof buildYCandidate === 'function') {
          const hScore = new Map();
          for (const t of remLive) {
            const orients = t.grainLock ? [[t.w, t.h]] : [[t.w, t.h], [t.h, t.w]];
            for (const [, ph] of orients) {
              if (ph <= availYTot) {
                hScore.set(ph, (hScore.get(ph) || 0) + t.rem * t.w * t.h);
              }
            }
          }
          const hs = [...hScore.entries()]
            .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([h]) => h);
          const combos = [];
          const gen = (start, combo, sum) => {
            if (combo.length) combos.push(combo.slice());
            if (combo.length >= 4) return;
            for (let i = start; i < hs.length; i++) {
              const nsum = sum + hs[i] + (combo.length ? kerf : 0);
              if (nsum > availYTot) continue;
              combo.push(hs[i]);
              gen(i + 1, combo, nsum);
              combo.pop();
            }
          };
          gen(0, [], 0);
          for (const combo of combos) {
            // Tallest strip at the bottom (house convention), plus the
            // reverse order — strip order changes which strip claims
            // contested pieces first.
            for (const order of [combo.slice().sort((a, b) => b - a),
                                 combo.slice().sort((a, b) => a - b)]) {
              const c = buildYCandidate(
                remLive.map(t => ({ ...t })), order, panelL, panelW,
                kerf, trimEdge, trimSub, null,
                new Array(order.length).fill(false), true);
              if (c && c.finalRem && c.finalRem.every(t => t.rem <= 0)) {
                tries.push(toCand(c.strips, 'Y'));
              }
            }
          }
        }
        for (const cand of tries) {
          if (!cand || !cand.strips || cand.strips.length === 0) continue;
          if (!finishesJob(cand.consumption)) continue;
          // Never exceed available demand (paranoia — packer was fed rem).
          let ok = true;
          for (const tid of Object.keys(cand.consumption)) {
            const t = rem.find(r => r.id === Number(tid));
            if (!t || cand.consumption[tid] > t.rem) { ok = false; break; }
          }
          if (!ok) continue;
          if (bandAreaOf(cand) > bandAreaOf(best) + 1 && renders(cand)) {
            best = cand;
          }
        }
      } catch (e) {
        if (log) log('tight-repack skipped', e && e.message);
      }
    }

    // Augment: if the picked candidate leaves leftover panel extent, fill
    // it with additional strips from the remaining demand minus what
    // `best` itself places. This converts sparse single-strip picks (a
    // common output of `addSharedDimensionCandidates`) into dense
    // multi-strip panels.
    // Grain types are included — the inner packers honor no-rotation via
    // the grainLock flag, so augment is safe to feed them.
    const remForAug = rem
      .map(t => ({ id: t.id, w: t.w, h: t.h, grainLock: t.grainLock, groupId: t.groupId,
                   rem: Math.max(0, t.rem - (best.consumption[t.id] || 0)),
                   total: Math.max(0, t.rem - (best.consumption[t.id] || 0)) }))
      .filter(t => t.rem > 0);
    const augmented = augmentCandidate(
      best, remForAug, panelL, panelW, kerf, trimEdge, trimSub
    );

    picks.push(augmented);
    for (const tid of Object.keys(augmented.consumption)) {
      const t = rem.find(r => r.id === Number(tid));
      if (t) t.rem = Math.max(0, t.rem - augmented.consumption[tid]);
    }
  }
  if (rem.some(t => t.rem > 0)) {
    if (log) log('greedy WARN unsatisfied', JSON.stringify(rem.map(t => ({id: t.id, rem: t.rem}))));
  }
  return picks;
}

// ─────────────────────────────────────────────────────────────────────
// MAIN OPTIMIZER CORE
// ─────────────────────────────────────────────────────────────────────
async function runOptimizerCore(input) {
  if (!input.raw || input.raw.length === 0) return { panels: [] };

  const { panelL, panelW, panelT, kerf, trimX, trimY, supplier, cutDir, raw } = input;
  const headTrim = (typeof input.headTrim === 'number')
    ? input.headTrim
    : Math.max(trimX || 0, trimY || 0);
  const trimEdge = headTrim;
  const trimSub  = headTrim;

  const reqId = Math.random().toString(36).slice(2, 8);
  const T0 = Date.now();
  const log = (phase, extra) => {
    const ex = extra ? ` ${extra}` : '';
    console.log(`[${reqId}] +${Date.now() - T0}ms ${phase}${ex}`);
  };
  log('start', `pieces=${raw.length}`);

  // ─── Step 1: consolidate raw pieces ──────────────────────────────
  const types = consolidate(raw);
  const demArr = types.map(t => t.total);
  log('consolidate', `types=${types.length}`);

  // Area-based panel-count lower bound. Used to gate B&B vs greedy.
  const totalArea = raw.reduce((s, p) => s + p.w * p.h, 0);
  const panelArea = panelL * panelW;
  const areaLB = Math.ceil(totalArea / panelArea);
  log('LB', `areaLB=${areaLB}`);

  // ─── Step 1.5: align-group = soft clustering hint only ───────────
  // Customer rule (verbatim): "preserve the grains, and also keep the
  // pieces all together in a section of the panel.  The rest of logic
  // is intact, no need to change any existing optimization, just keep
  // them close, keep it simple."
  //
  // So we do NOT carve dedicated panels and do NOT touch greedy/B&B.
  // The ONLY thing we do is sort the `types` array so pieces sharing an
  // alignGroup color are contiguous (largest-first within each group).
  // greedy/B&B fill strips in pool order, so adjacent types naturally
  // land in the same section of the same panel.  Grain is preserved by
  // the existing `grainLock` flag — untouched here.
  //
  // KEEP IN SYNC with the in-browser worker copy in INCO_Furniture_v12.html
  // (#inco-optimizer-worker-src → runOptimizerCore Step 1.5).
  if (types.some(t => t.alignGroup)) {
    types.sort((a, b) => {
      const aG = a.alignGroup || '';
      const bG = b.alignGroup || '';
      if (!aG && bG) return -1;
      if (aG && !bG) return 1;
      if (aG !== bG) return aG < bG ? -1 : 1;
      return (b.w * b.h) - (a.w * a.h);
    });
    log('group-sort', 'clustered same-color types; optimizer untouched');
  }
  const groupPanels = [];          // no dedicated group panels anymore
  const remainingTypes = types;    // optimizer sees everything, as-is

  // ─── Step 2: greedy baseline ─────────────────────────────────────
  // Always run greedy first. It's fast even on big inputs and produces
  // a decent baseline that seeds B&B for small inputs (massive pruning).
  const tG = Date.now();
  let greedyPicks = greedyPack(remainingTypes, panelL, panelW, kerf, trimEdge, trimSub, cutDir, log);
  greedyPicks = backfillPass(greedyPicks, remainingTypes, panelL, panelW, kerf, trimEdge, trimSub, log);
  log('greedy', `panels=${greedyPicks.length} took=${Date.now()-tG}ms`);

  let bestPicks = greedyPicks;

  // ─── Step 3: B&B improvement attempt (small/medium inputs only) ──
  // Greedy is solid for big inputs but for small ones B&B can prove
  // optimum or find combinations greedy misses. We seed it with
  // `greedyPicks.length` so it ONLY accepts strictly-smaller solutions
  // — this prunes the search tree dramatically.
  //
  // Looser dominance (`minEffGap: 0.005`): preserves candidates that
  // differ only by 1 cheap filler piece. The classic Cutty C2/C3/C4
  // patterns are exactly this — sparse "clean" templates that get
  // wrongly dominated by `template + 1× 100×100` variants. Keeping
  // both gives B&B the combinations it needs.
  // B&B set-cover runs on grain inputs too — the candidate generator and
  // packers all honor `t.grainLock` (no rotation) uniformly via the shared
  // `orientations(t)` helper, so every set-cover candidate satisfies the
  // direction-grain constraint by construction.  Customer prioritizes
  // material savings (priority 2) over pattern-grain (priority 3), so B&B's
  // material-optimal solution is the desired outcome.
  // B&B runs over the NON-group remainder.  remainingDemArr mirrors
  // remainingTypes.total so the set-cover constraints reflect what's left
  // after group panels claimed their pieces.
  const remainingDemArr = remainingTypes.map(t => t.total);
  const trySmallInputBB = areaLB <= 10 && remainingTypes.filter(t => t.total > 0).length <= 8
                          && remainingDemArr.some(d => d > 0);
  if (trySmallInputBB && greedyPicks.length > 0) {
    const tGen = Date.now();
    // B&B path: enable multi-sub-strip Y offcut variants. These pack denser
    // per panel and combine better in set-cover, even though they'd mislead
    // a per-panel greedy. Greedy keeps multiOffcut=false (default).
    const baseCands = generateCandidates(remainingTypes, panelL, panelW, kerf, trimEdge, trimSub, cutDir, { multiOffcut: true });
    log('generateCandidates', `count=${baseCands.length} took=${Date.now()-tGen}ms`);

    if (baseCands.length > 0) {
      for (const c of baseCands) c.consumption = computeConsumption(c);

      // Drop candidates whose consumption EXCEEDS demand on any type — they
      // can't appear in an exact-cover solution and they confuse the
      // post-B&B trim-over-cover step (regeneration there can break the
      // covering structure that B&B carefully built). Keeping only
      // demand-compliant candidates lets B&B's solution flow through
      // unmodified.
      const idxOfType = new Map(remainingTypes.map((t, i) => [t.id, i]));
      const demandCompliant = baseCands.filter(c => {
        for (const tid of Object.keys(c.consumption)) {
          const i = idxOfType.get(Number(tid));
          if (i !== undefined && c.consumption[tid] > remainingDemArr[i]) return false;
        }
        return true;
      });
      log('demand-filter', `kept=${demandCompliant.length}/${baseCands.length}`);

      const tFilt = Date.now();
      const filtered = dominanceFilter(demandCompliant, remainingTypes, { minEffGap: 0.005 });
      log('dominanceFilter (loose)',
          `kept=${filtered.length}/${demandCompliant.length} took=${Date.now()-tFilt}ms`);

      // First B&B pass: exact cover only.
      const tBB = Date.now();
      let bb = await setCoverBB(filtered, remainingTypes, remainingDemArr, panelL, panelW, {
        allowOverCover: false,
        useTiebreak: false,
        noImprovementMs: 30000,
        seedBestFound: greedyPicks.length,
      }, 60000);
      log('setCoverBB exact',
          `picked=${bb.solution ? bb.solution.length : 'null'} nodes=${bb.nodes} took=${Date.now()-tBB}ms`);
      if (!bb.solution) {
        const tBB2 = Date.now();
        bb = await setCoverBB(filtered, remainingTypes, remainingDemArr, panelL, panelW, {
          allowOverCover: true,
          useTiebreak: false,
          noImprovementMs: 30000,
          seedBestFound: greedyPicks.length,
        }, 60000);
        log('setCoverBB over',
            `picked=${bb.solution ? bb.solution.length : 'null'} nodes=${bb.nodes} took=${Date.now()-tBB2}ms`);
      }
      if (bb.solution && bb.solution.length < greedyPicks.length) {
        const improved = await applyTrimAndBackfill(
          bb.solution.map(w => w.ref), remainingTypes, remainingDemArr,
          panelL, panelW, kerf, trimEdge, trimSub, cutDir, log
        );
        if (improved.length < bestPicks.length) {
          bestPicks = improved;
          log('B&B improved', `${greedyPicks.length} → ${bestPicks.length}`);
        }
      }
    }
  }

  // ─── Step 4: render ──────────────────────────────────────────────
  // Group panels come FIRST in the output so they're rendered as the
  // earliest panels in the carousel (matching the customer's mental model
  // — "the aligned pieces are cut on panel 1, the rest follows").
  const allPicks = [...groupPanels, ...bestPicks];
  const outPanels = allPicks.map(c => buildPanelFromCandidate(
    c, types, panelL, panelW, panelT, supplier, kerf, trimEdge, trimSub
  ));
  log('done', `total=${outPanels.length} panels`);
  return { panels: outPanels };
}

// ─────────────────────────────────────────────────────────────────────
// Trim a candidate's strips in-place so consumption ≤ remDemand. The
// candidate's strip structure is preserved — we just lower `uQty` /
// `qty` / `vQty` fields and drop strips that fully empty. Panels that
// end up entirely empty are dropped from the result.
//
// Why in-place trim instead of full regeneration:
//   When B&B picks an over-covering 6-tuple (e.g., two panels each
//   placing 17× 100×100 against a demand of 20), regenerating each
//   over-consuming pick from scratch produces a totally different
//   candidate that may not cover what was originally needed — the
//   covering structure breaks and trim ends up with MORE panels than
//   B&B picked. In-place trim never breaks coverage; it just makes
//   each panel cut fewer pieces. If a pick becomes redundant, its
//   panel is dropped — we end up with a SHORTER solution than B&B's.
// ─────────────────────────────────────────────────────────────────────
function trimCandidateInPlace(cand, remDemand, idxOf, panelL, panelW) {
  const newStrips = [];
  if (cand.mode === 'Y') {
    for (const st of cand.strips) {
      const newCuts = [];
      for (const pc of st.primaryCuts) {
        const i = idxOf.get(pc.typeId);
        if (i === undefined) continue;
        const allowed = Math.max(0, remDemand[i]);
        if (allowed <= 0) continue;
        const useQty = Math.min(pc.qty, allowed);
        newCuts.push({ ...pc, qty: useQty });
        remDemand[i] -= useQty;
      }
      const newOffcuts = [];
      for (const oc of normalizeYOffcuts(st)) {
        const newUCuts = [];
        for (const u of oc.uCuts) {
          const i = idxOf.get(u.typeId);
          if (i === undefined) continue;
          const allowed = Math.max(0, remDemand[i]);
          if (allowed <= 0) continue;
          const useUQty = Math.min(u.uQty, allowed);
          newUCuts.push({ ...u, uQty: useUQty });
          remDemand[i] -= useUQty;
        }
        if (newUCuts.length > 0) {
          newOffcuts.push({ xPw: oc.xPw, ru: oc.ru, uCuts: newUCuts });
        }
      }
      if (newCuts.length === 0 && newOffcuts.length === 0) continue;
      // Remove legacy `offcut` field if present, since we now use `offcuts`.
      const stCopy = { ...st };
      delete stCopy.offcut;
      newStrips.push({ ...stCopy, primaryCuts: newCuts, offcuts: newOffcuts });
    }
  } else {
    for (const st of cand.strips) {
      const i = idxOf.get(st.typeId);
      let useUQty = 0;
      if (i !== undefined) {
        useUQty = Math.min(st.uQty, Math.max(0, remDemand[i]));
        remDemand[i] -= useUQty;
      }
      const newVBars = [];
      for (const vb of (st.vBars || [])) {
        const j = idxOf.get(vb.typeId);
        if (j === undefined) continue;
        const allowed = Math.max(0, remDemand[j]);
        if (allowed <= 0) continue;
        const useVQty = Math.min(vb.vQty, allowed);
        newVBars.push({ ...vb, vQty: useVQty });
        remDemand[j] -= useVQty;
      }
      if (useUQty === 0 && newVBars.length === 0) continue;
      newStrips.push({ ...st, uQty: useUQty, vBars: newVBars });
    }
  }
  if (newStrips.length === 0) return null;
  return rebuildCandidate(cand, newStrips, panelL, panelW);
}

// ─────────────────────────────────────────────────────────────────────
// Apply in-place trim + back-fill to B&B-picked candidates.
// ─────────────────────────────────────────────────────────────────────
async function applyTrimAndBackfill(pickedRefs, types, demArr,
                                     panelL, panelW, kerf, trimEdge, trimSub, cutDir, log) {
  const idxOf = new Map(types.map((t, i) => [t.id, i]));
  const remDemand = demArr.slice();

  // In-place trim: walk picks in order, lowering qty/uQty/vQty so each
  // pick consumes only what's still needed. Empty strips and empty
  // panels are dropped. This catches the case where B&B's over-cover
  // solution has duplicate picks — trimming the duplicates' qty to 0
  // drops those panels entirely, yielding fewer panels than B&B picked.
  const tTrim = Date.now();
  const finalCands = [];
  let droppedCount = 0;
  for (const c of pickedRefs) {
    const trimmed = trimCandidateInPlace(c, remDemand, idxOf, panelL, panelW);
    if (trimmed === null) { droppedCount++; continue; }
    finalCands.push(trimmed);
  }
  if (log) {
    const note = droppedCount > 0 ? ` dropped=${droppedCount}` : '';
    log('trim in-place', `${pickedRefs.length} → ${finalCands.length}${note} took=${Date.now()-tTrim}ms`);
  }

  // Top-up: if trimming left demand unsatisfied (rare — only when a
  // strip-trim had to be more aggressive than B&B accounted for, e.g.,
  // a vBar already exhausted couldn't be replaced), generate one more
  // panel per missing chunk.
  let safety = 8;
  while (remDemand.some(r => r > 0) && safety-- > 0) {
    const partialTypes = types.map((t, i) => ({
      ...t, rem: remDemand[i], total: remDemand[i],
    })).filter(t => t.rem > 0);
    const cs = generateCandidates(
      partialTypes, panelL, panelW, kerf, trimEdge, trimSub, cutDir
    );
    if (cs.length === 0) break;
    let best = null;
    for (const pc of cs) {
      const cons = computeConsumption(pc);
      let fits = true;
      for (const tid of Object.keys(cons)) {
        const i = idxOf.get(Number(tid));
        if (i === undefined || cons[tid] > remDemand[i]) { fits = false; break; }
      }
      if (!fits) continue;
      if (!best || pc.placedCount > best.placedCount) {
        pc.consumption = cons;
        best = pc;
      }
    }
    if (!best) break;
    finalCands.push(best);
    for (const tid of Object.keys(best.consumption)) {
      const i = idxOf.get(Number(tid));
      if (i !== undefined) remDemand[i] = Math.max(0, remDemand[i] - best.consumption[tid]);
    }
  }

  // Back-fill: drop trailing panels whose pieces fit elsewhere.
  return backfillPass(finalCands, types, panelL, panelW, kerf, trimEdge, trimSub, log);
}

// ─────────────────────────────────────────────────────────────────────
// Input validation (same as v3, minor simplification)
// ─────────────────────────────────────────────────────────────────────
function validateInput(d) {
  if (!d || typeof d !== 'object') return 'Invalid input: not an object.';
  const required = ['panelL', 'panelW', 'panelT', 'kerf', 'trimX', 'trimY', 'supplier', 'cutDir', 'raw'];
  for (const k of required) if (d[k] === undefined) return `Missing field: ${k}`;
  if (typeof d.panelL !== 'number' || d.panelL <= 0) return 'panelL must be a positive number.';
  if (typeof d.panelW !== 'number' || d.panelW <= 0) return 'panelW must be a positive number.';
  if (typeof d.panelT !== 'number' || d.panelT <= 0) return 'panelT must be a positive number.';
  if (typeof d.kerf !== 'number' || d.kerf < 0) return 'kerf must be a non-negative number.';
  if (typeof d.trimX !== 'number' || d.trimX < 0) return 'trimX must be a non-negative number.';
  if (typeof d.trimY !== 'number' || d.trimY < 0) return 'trimY must be a non-negative number.';
  if (!Array.isArray(d.raw)) return 'raw must be an array.';
  if (d.raw.length === 0) return 'raw must not be empty.';
  for (let i = 0; i < d.raw.length; i++) {
    const p = d.raw[i];
    if (!p || typeof p.w !== 'number' || typeof p.h !== 'number')
      return `Invalid piece at index ${i}.`;
    if (p.w <= 0 || p.h <= 0) return `Piece at index ${i} has non-positive dimensions.`;
    const maxDim = Math.max(d.panelL, d.panelW);
    const minDimPanel = Math.min(d.panelL, d.panelW);
    const pieceMax = Math.max(p.w, p.h);
    const pieceMin = Math.min(p.w, p.h);
    if (pieceMax > maxDim || pieceMin > minDimPanel) {
      return `Piece ${p.w}x${p.h} doesn't fit panel ${d.panelL}x${d.panelW}.`;
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
      return await runOptimizerCore(request.data);
    } catch (err) {
      console.error('[runOptimizer] internal error:', err);
      throw new HttpsError('internal', 'Optimizimi dështoi. Provo përsëri.');
    }
  }
);

exports._test = { runOptimizerCore, repairTightColumns, placeIntoStrips, backfillPass };
