// ═══════════════════════════════════════════════════════════════════════
// Saw Simulator — verifies that extracted strips actually produce the
// pieces my algorithm intended.
//
// The simulator takes (mode, strips, panelL, panelW, kerf, trim) and walks
// through the cut sequence step by step, computing the (x, y, w, h, typeId)
// of every piece the saw will output. We then compare against the original
// placed[] array — counts per (typeId, w, h) must match exactly.
//
// This is the safety check before deploying. A mismatch here means the
// extractor produced WinCut content that, when fed to a real saw, would
// cut DIFFERENT pieces than my algorithm planned. That would be unrecoverable
// material loss.
// ═══════════════════════════════════════════════════════════════════════

// Simulate the saw's cut sequence. Returns the list of pieces produced,
// each with { x, y, w, h, typeId }.
function simulateSaw(strips, mode, panelL, panelW, kerf, trimEdge, trimSub) {
  const pieces = [];

  if (mode === 'X') {
    // RX: head-trim from leading X edge
    let xCursor = trimEdge;
    for (const st of strips) {
      const stripX = xCursor;
      // RU: head-trim from leading Y edge of strip
      let yCursor = trimSub;
      // Primary stack: uQty pieces of stripW × uPh, stacked vertically
      for (let j = 0; j < st.uQty; j++) {
        pieces.push({
          x: stripX, y: yCursor, w: st.stripW, h: st.uPh, typeId: st.typeId,
        });
        yCursor += st.uPh + kerf;
      }
      // vBars: each vBar is a horizontal sub-band in residual height
      for (const vb of st.vBars) {
        const bandY = yCursor;
        // RV: head-trim from leading X edge of sub-band
        let bandX = stripX + trimSub;
        // V cuts: vQty pieces of vPw × barH, side-by-side
        for (let k = 0; k < vb.vQty; k++) {
          pieces.push({
            x: bandX, y: bandY, w: vb.vPw, h: vb.barH, typeId: vb.typeId,
          });
          bandX += vb.vPw + kerf;
        }
        yCursor += vb.barH + kerf;
      }
      xCursor += st.stripW + kerf;
    }
  } else if (mode === 'Y') {
    // RY: head-trim from leading Y edge
    let yCursor = trimEdge;
    for (const st of strips) {
      const stripY = yCursor;
      // RX: head-trim from leading X edge of strip
      let xCursor = trimSub;
      // primaryCuts: pieces side-by-side along X, all of stripH height
      for (const c of st.primaryCuts) {
        for (let j = 0; j < c.qty; j++) {
          pieces.push({
            x: xCursor, y: stripY, w: c.pw, h: st.stripH, typeId: c.typeId,
          });
          xCursor += c.pw + kerf;
        }
      }
      // offcuts: 0+ sub-strips after primary, each holding 1+ stacked U-cut
      // groups of one type. Both new array form and legacy single offcut
      // are accepted.
      let offcuts;
      if (Array.isArray(st.offcuts)) offcuts = st.offcuts;
      else if (st.offcut) offcuts = [{
        xPw: st.offcut.xPw, ru: st.offcut.ru,
        uCuts: [{ typeId: st.offcut.typeId, uPh: st.offcut.uPh, uQty: st.offcut.uQty }],
      }];
      else offcuts = [];
      for (const oc of offcuts) {
        const offX = xCursor;
        let offY = stripY + oc.ru;
        for (const u of oc.uCuts) {
          for (let k = 0; k < u.uQty; k++) {
            pieces.push({
              x: offX, y: offY, w: oc.xPw, h: u.uPh, typeId: u.typeId,
            });
            offY += u.uPh + kerf;
          }
        }
        xCursor += oc.xPw + kerf;
      }
      yCursor += st.stripH + kerf;
    }
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }

  return pieces;
}

// Verify simulated pieces match original placed pieces by type counts.
// Returns { ok: bool, mismatches: [...] }
function verifyMatch(placed, simulated) {
  const key = p => `t${p.typeId}|${p.w}x${p.h}`;
  const placedCounts = new Map();
  const simCounts = new Map();
  for (const p of placed) {
    const k = key(p);
    placedCounts.set(k, (placedCounts.get(k) || 0) + 1);
  }
  for (const p of simulated) {
    const k = key(p);
    simCounts.set(k, (simCounts.get(k) || 0) + 1);
  }
  const mismatches = [];
  const allKeys = new Set([...placedCounts.keys(), ...simCounts.keys()]);
  for (const k of allKeys) {
    const p = placedCounts.get(k) || 0;
    const s = simCounts.get(k) || 0;
    if (p !== s) mismatches.push({ key: k, placed: p, simulated: s });
  }
  return { ok: mismatches.length === 0, mismatches };
}

// Verify simulated pieces are within panel boundaries (no overflow).
function verifyBounds(simulated, panelL, panelW) {
  const out = [];
  for (const p of simulated) {
    if (p.x < -1e-3) out.push({ piece: p, reason: 'x < 0' });
    if (p.y < -1e-3) out.push({ piece: p, reason: 'y < 0' });
    if (p.x + p.w > panelL + 1e-3) out.push({ piece: p, reason: 'x+w > panelL' });
    if (p.y + p.h > panelW + 1e-3) out.push({ piece: p, reason: 'y+h > panelW' });
  }
  return { ok: out.length === 0, violations: out };
}

// Verify simulated pieces don't overlap each other.
function verifyNoOverlap(simulated) {
  const out = [];
  for (let i = 0; i < simulated.length; i++) {
    for (let j = i + 1; j < simulated.length; j++) {
      const a = simulated[i], b = simulated[j];
      const overlapX = a.x < b.x + b.w - 1e-3 && b.x < a.x + a.w - 1e-3;
      const overlapY = a.y < b.y + b.h - 1e-3 && b.y < a.y + a.h - 1e-3;
      if (overlapX && overlapY) out.push({ a, b });
    }
  }
  return { ok: out.length === 0, overlaps: out };
}

module.exports = { simulateSaw, verifyMatch, verifyBounds, verifyNoOverlap };
