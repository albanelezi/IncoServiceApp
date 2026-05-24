// ═══════════════════════════════════════════════════════════════════════
// algorithm.js — set-cover B&B + dominance pruning.
// ═══════════════════════════════════════════════════════════════════════
//
// Used by index.js to pick the fewest-panels subset of strip-native
// candidates whose union covers piece demand. Both helpers are
// candidate-format-agnostic: they only require each candidate to expose
// a `consumption` map (typeId → qty placed) and an `eff` field
// (placedArea / panelArea).
//
// Pre-v4 this file also contained coord-based packers (BLF/NFDH/etc.),
// post-processing (densityPush/consolidate/compact), and a coord-template
// generator. Those were dead in the strip-native pipeline and were
// removed; the prior implementation lives at algorithm.js.coord-based.bak
// for reference.
// ═══════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// Dominance pruning.
// Removes candidate j if some other candidate i covers ≥ everything j covers
// (and strictly more on at least one type). The retained candidate is
// always at least as good for set-cover purposes.
// ─────────────────────────────────────────────────────────────────────
function dominanceFilter(candidates, types, opts) {
  // opts.minEffGap: when > 0, A only dominates B if A's eff exceeds B's
  // by at least this much. With minEffGap=0 (the default) we use strict
  // consumption-only dominance, which prunes aggressively but can erase
  // candidates that differ only by "cheap-filler" pieces (e.g., 1× 100×100).
  // Such candidates are critical for set-cover flexibility — a 5-piece
  // "clean" panel often combines better with peers than a 6-piece variant
  // that over-covers a small type. minEffGap=0.005 (0.5%) keeps them.
  const minEffGap = (opts && opts.minEffGap) || 0;
  const arrs = candidates.map(c => types.map(t => c.consumption[t.id] || 0));
  const keep = new Array(candidates.length).fill(true);
  for (let i = 0; i < candidates.length; i++) {
    if (!keep[i]) continue;
    for (let j = 0; j < candidates.length; j++) {
      if (i === j || !keep[j]) continue;
      let geq = true, strict = false;
      for (let k = 0; k < types.length; k++) {
        if (arrs[i][k] < arrs[j][k]) { geq = false; break; }
        if (arrs[i][k] > arrs[j][k]) strict = true;
      }
      if (!(geq && strict)) continue;
      if (minEffGap > 0) {
        const ei = candidates[i].eff || 0;
        const ej = candidates[j].eff || 0;
        if (ei - ej + 1e-9 < minEffGap) continue;
      }
      keep[j] = false;
    }
  }
  return candidates.filter((_, i) => keep[i]);
}

// ─────────────────────────────────────────────────────────────────────
// B&B set-cover.
//   - panel-count primary objective (minimize)
//   - useTiebreak=true: among min-panel solutions, maximize total efficiency
//   - allowOverCover=true: at-least cover; false: exact match (no surplus)
//
// Returns:
//   { solution, bestFound, bestEff, nodes, timeMs, timedOut }
// where `solution` is an array of { arr, eff, ref } (ref points back to
// the original candidate) or null if budget exceeded before any feasible
// solution found.
//
// Time-budget controls:
//   * budgetMs       — hard cap on total search time
//   * noImprovementMs — soft cap; stop if no improvement for this long
// Both are honored; whichever fires first wins.
//
// Suitable for ≤ ~10 panels and ≤ ~8 piece types. Beyond that the search
// tree explodes and the caller should fall back to a greedy strategy.
// ─────────────────────────────────────────────────────────────────────
async function setCoverBB(filtered, types, demArr, panelW, panelH, opts, budgetMs) {
  // opts.seedBestFound: when finite, B&B starts with this as the
  // best-known panel count. It only accepts solutions strictly smaller.
  // Used when a greedy run already produced a baseline — the seed lets
  // B&B prune aggressively (anything >= seed is rejected immediately)
  // and search ONLY for improvements. If B&B finds nothing better,
  // `solution` remains null and the caller falls back to greedy.
  const { allowOverCover = true, useTiebreak = false,
          noImprovementMs = 8000, seedBestFound = Infinity } = opts || {};
  const C = filtered.map(c => ({
    arr: types.map(t => c.consumption[t.id] || 0),
    eff: c.eff, ref: c,
  }));
  const candByType = types.map((_, i) =>
    C.filter(c => c.arr[i] > 0).sort((a, b) => b.eff - a.eff)
  );
  const maxPerType = types.map((_, i) => Math.max(0, ...C.map(c => c.arr[i])));
  const maxCandEff = C.length > 0 ? Math.max(...C.map(c => c.eff)) : 0;
  const areaArr = types.map(t => t.w * t.h);
  let solution = null, bestFound = seedBestFound, bestEff = -1, nodes = 0;
  const tBB = performance.now();
  let timedOut = false;
  let lastImprovementAt = tBB;

  function lb(rem) {
    let totalArea = 0;
    for (let i = 0; i < types.length; i++) totalArea += rem[i] * areaArr[i];
    let l = Math.ceil(totalArea / (panelW * panelH));
    for (let i = 0; i < types.length; i++) {
      if (rem[i] > 0) {
        if (maxPerType[i] === 0) return Infinity;
        l = Math.max(l, Math.ceil(rem[i] / maxPerType[i]));
      }
    }
    return l;
  }
  function isCovered(rem) {
    for (let i = 0; i < types.length; i++) if (rem[i] > 0) return false;
    return true;
  }
  function pickType(rem) {
    let bestI = -1, bestRatio = Infinity;
    for (let i = 0; i < types.length; i++) if (rem[i] > 0) {
      const r = maxPerType[i] / rem[i];
      if (r < bestRatio) { bestRatio = r; bestI = i; }
    }
    return bestI;
  }

  // Generator-based recursion. Avoids the per-call Promise allocation that
  // async/await would incur, while still allowing periodic event-loop
  // yields so the host (browser tab or Node) stays responsive.
  function* recurseGen(rem, depth, picked, totalEff) {
    if (timedOut) return;
    nodes++;
    if ((nodes & 4095) === 0) yield;
    if (depth > bestFound) return;
    if (depth === bestFound) {
      if (!useTiebreak) return;
      if (totalEff <= bestEff) return;
    }
    if (isCovered(rem)) {
      if (depth < bestFound || (useTiebreak && depth === bestFound && totalEff > bestEff)) {
        bestFound = depth;
        bestEff = totalEff;
        solution = picked.slice();
        lastImprovementAt = performance.now();
      }
      return;
    }
    const minPanels = depth + lb(rem);
    if (minPanels > bestFound) return;
    if (!useTiebreak && minPanels === bestFound) return;
    if (useTiebreak && minPanels === bestFound) {
      const remainingPicks = bestFound - depth;
      if (totalEff + remainingPicks * maxCandEff <= bestEff + 1e-9) return;
    }
    const branchType = pickType(rem);
    if (branchType < 0) return;
    const cands = candByType[branchType];
    for (let ci = 0; ci < cands.length; ci++) {
      if (timedOut) return;
      const c = cands[ci];
      const newRem = rem.slice();
      let infeasible = false;
      for (let i = 0; i < types.length; i++) {
        newRem[i] = rem[i] - c.arr[i];
        if (newRem[i] < 0) {
          if (allowOverCover) newRem[i] = 0;
          else { infeasible = true; break; }
        }
      }
      if (infeasible) continue;
      picked.push(c);
      yield* recurseGen(newRem, depth + 1, picked, totalEff + c.eff);
      picked.pop();
      if (timedOut) return;
    }
  }

  const gen = recurseGen(demArr.slice(), 0, [], 0);
  let lastYield = tBB;
  while (true) {
    const r = gen.next();
    if (r.done) break;
    const now = performance.now();
    if (now - tBB > budgetMs) { timedOut = true; break; }
    if (solution !== null && noImprovementMs !== null && noImprovementMs !== Infinity &&
        now - lastImprovementAt > noImprovementMs) {
      timedOut = true; break;
    }
    if (now - lastYield > 250) {
      lastYield = now;
      await new Promise(res => setTimeout(res, 0));
    }
  }

  return {
    solution, bestFound, bestEff, nodes,
    timeMs: performance.now() - tBB, timedOut,
  };
}

module.exports = { dominanceFilter, setCoverBB };
