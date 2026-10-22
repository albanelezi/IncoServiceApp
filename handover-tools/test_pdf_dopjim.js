// End-to-end test of the "dopjim" (doubled label) import: runs the app's REAL
// parser on the real PDF with pdf.js, then the real review + confirm code
// with DOM stubs, then the real WinCut label injector.
const fs = require('fs'), path = require('path');
const SRC = require('path').join(__dirname, '..', 'INCO_Furniture_v12.src.html');
const PDF = process.argv[2] || 'C:/Users/Lenovo/Downloads/Fasada_Label.pdf';
const H = fs.readFileSync(SRC, 'utf8');
function extract(a, b) {
  const s = H.indexOf(a); if (s < 0) throw new Error('marker not found: ' + a);
  const e = H.indexOf(b, s); if (e < 0) throw new Error('end marker not found: ' + b);
  return H.slice(s, e);
}
const code =
  extract('function makeRow(block) {', '\nfunction removeBlock(') +
  extract('function _buildImportQueueForGroup', 'function _buildImportQueueForBlock') +
  extract('function _buildImportQueueForBlock', '// Per-block label-printing gate') +
  extract('function _fixupManualSubLabels', 'function _stripLabelRefsIfDisabled') +
  extract('function _injectCodesIntoTxt', 'function _meGenFileContent') +
  extract('const _pdfImport = {', '\n</script>\n<script id="inco-optimizer-worker-src"');

// ── stubs ──
const els = {};
const el = id => (els[id] = els[id] || { id, style: {}, textContent: '', innerHTML: '', value: '' });
const toasts = [];
const MATS = [
  { id: 'bm_mel_rimeso', type: 'melamine', description: 'Mel.Rimeso Druri', prices: { 'bf_3660x1830x18': 1 } },
  { id: 'bm_mdf', type: 'mdf', description: 'MDF Bardhe Shqeto', prices: { 'bf_3660x1830x18': 1 } },
];
const FMTS = [{ id: 'bf_3660x1830x18', lung: 3660, larg: 1830, thickness: 18 }];
let blocks = [];
let blockIdCtr = 0;
const env = {
  document: { getElementById: el, querySelectorAll: () => [] },
  console, confirm: () => true,
  escHtml: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  shellToast: (m, k) => toasts.push(m),
  loadPrices: () => ({ materials: MATS, formats: FMTS }),
  getMaterialById: id => MATS.find(m => m.id === id) || null,
  getFormatById: id => FMTS.find(f => f.id === id) || null,
  getPricedFormats: m => FMTS.filter(f => (m.prices || {})[f.id]),
  blockHasTenie: () => true,
  calcBlock: () => {}, renderBlocks: () => {}, updateAddButtons: () => {}, updateGrandTotal: () => {}, markBlockDirty: b => { b._optDirty = true; },
  pdfjsLib: null, setTimeout, clearTimeout,
};
const F = new Function(...Object.keys(env), `
  let blocks = []; let blockIdCtr = 0;
  function addBlock(materialId, formatId) { const b = { id: blockIdCtr++, materialId, formatId, name: 'blk', rows: [], rowIdCtr: 0, panels: [] }; b.rows.push(makeRow(b)); blocks.push(b); }
  function _pdfImportClose() {}
  ${code}
  return { _pdfImportExtractPage, _pdfImportParseCell, _pdfImportMarkDopjim, _pdfImportGroupKey, _pdfImportRenderReview, _pdfImportConfirm, _pdfImportRemoveMaterial,
           _pdfImport, _buildImportQueueForGroup, _injectCodesIntoTxt, getBlocks: () => blocks, setBlocks: b => { blocks = b; } };`)(...Object.values(env));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  OK  ' + n); } else { fail++; console.log('  FAIL ' + n + (x ? ' :: ' + x : '')); } };

(async () => {
  // A. the real PDF through the real parser
  // Needs pdf.js: run `npm i pdfjs-dist@3.11.174` in handover-tools/ (or point PDFJS_DIR at a folder that has node_modules/pdfjs-dist).
  const pdfjs = require(path.join(process.env.PDFJS_DIR || __dirname, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(PDF)), useSystemFonts: true }).promise;
  const pieces = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const pagePieces = await F._pdfImportExtractPage(await doc.getPage(p));
    pagePieces.forEach((pc, idx) => { pc._page = p; pc._pos = `p${p}_${idx}`; });   // as _pdfImportOnFile does
    pieces.push(...pagePieces);
  }
  console.log(`A. parsed ${pieces.length} labels from ${path.basename(PDF)} (${doc.numPages} pages)`);
  const thk = {}; pieces.forEach(p => { thk[p.thickness] = (thk[p.thickness] || 0) + 1; });
  console.log('   thickness counts:', JSON.stringify(thk), '| materials:', [...new Set(pieces.map(p => p.material))].join(' / '));
  const p36 = pieces.filter(p => p.thickness === 36);
  ok('36 mm labels found in the PDF', p36.length > 0, JSON.stringify(thk));
  p36.slice(0, 3).forEach(p => console.log(`   36mm: ${p.length}x${p.width} part="${p.part}" codes=${(p.codes || []).join(',')} case=#${p.caseNumber} job="${p.job}"`));

  // B. detection + grouping
  F._pdfImportMarkDopjim(pieces);
  ok('every 36 mm label is marked dopjim with base 18', p36.every(p => p.dopjim && p.baseThickness === 18));
  ok('18 mm labels are NOT marked', pieces.filter(p => p.thickness === 18).every(p => !p.dopjim));
  const keys = [...new Set(pieces.map(F._pdfImportGroupKey))];
  console.log('   group keys:', keys.join(' | '));
  ok('36 mm labels join the 18 mm group of the same material', !keys.some(k => /36\s*mm/i.test(k)) && p36.every(p => /18 mm/i.test(F._pdfImportGroupKey(p))));
  // synthetic edge cases
  const syn = [{ material: 'MDF 18 mm', thickness: 18 }, { material: 'MDF 36 mm', thickness: 36 }, { material: 'X 32 mm', thickness: 32 },
               { material: 'Y 50 mm', thickness: 50 }, { material: 'Z 25 mm', thickness: 25 }, { material: 'Fiber 8 mm', thickness: 8 }, { material: 'Q 38 mm', thickness: 38 }];
  F._pdfImportMarkDopjim(syn);
  ok('32→2×16, 50→2×25, 38→2×19 are dopjim; 25, 8, 18 are not',
     syn[2].dopjim && syn[2].baseThickness === 16 && syn[3].dopjim && syn[3].baseThickness === 25 && syn[6].dopjim && syn[6].baseThickness === 19 &&
     !syn[4].dopjim && !syn[5].dopjim && !syn[0].dopjim && syn[1].dopjim);
  ok('group key of a 50 mm label is "Y 25 mm"', F._pdfImportGroupKey(syn[3]) === 'Y 25 mm');

  // C. review render + confirm on the real pieces
  F._pdfImport.pieces = pieces;
  F._pdfImportRenderReview();
  const reviewRows = F._pdfImport.pieces;
  ok(`review shows TWO rows per doubled label (${reviewRows.length} = ${pieces.length} + ${p36.length})`, reviewRows.length === pieces.length + p36.length);
  const halves = reviewRows.filter(p => p.dopjimHalf);
  ok('each doubled label became halves 1/2 and 2/2: 18 mm, in the 18 mm material, part + " dopjim"',
     halves.length === 2 * p36.length && halves.filter(p => p.dopjimHalf === 1).length === p36.length &&
     halves.every(p => p.thickness === 18 && /18 mm/i.test(p.material) && p.dopjimThickness === 36 && /^dopjim /.test(p.part) && p.dopjim));
  ok('the two halves of a label carry the same codes, case and job', p36.every(s => {
    const h = halves.filter(p => p._pos === s._pos);   // _pos = page/cell of the label, unique
    return h.length === 2 && h[0].codeFront === s.codeFront && h[1].codeBack === s.codeBack && h[0].job === h[1].job;
  }));
  ok('review summary mentions dopjim', /dopjim/.test(el('pdf-import-summary').textContent));
  ok('review table: one badge per half', (el('pdf-import-table').innerHTML.match(/dopjim [12]\/2 · 36 mm/g) || []).length === halves.length);
  ok('review table shows no ×2 marker', !/×2</.test(el('pdf-import-table').innerHTML));
  F._pdfImportRenderReview();
  ok('re-rendering the review does not split again', F._pdfImport.pieces.length === reviewRows.length);
  for (const k of F._pdfImport.groupKeys) F._pdfImport.mapping[k] = { materialId: 'bm_mel_rimeso', formatId: 'bf_3660x1830x18' };
  F._pdfImportConfirm();
  const blocks = F.getBlocks();
  const rows = blocks.flatMap(b => b.rows);
  ok('one section created (base material, 18 mm format)', blocks.length === 1 && blocks[0].formatId === 'bf_3660x1830x18');
  ok(`rows = labels + one extra per dopjim (${rows.length} = ${pieces.length} + ${p36.length})`, rows.length === pieces.length + p36.length);
  const dopRows = rows.filter(r => r._importDopjim);
  ok('each dopjim label produced exactly 2 rows', dopRows.length === 2 * p36.length);
  const sample = p36[0];
  const twins = dopRows.filter(r => r._importCaseNumber === String(sample.caseNumber) && r.l === String(sample.length));
  ok('the two rows are identical (dims, codes, case, job)', twins.length === 2 &&
     twins[0].l === twins[1].l && twins[0].g === twins[1].g && twins[0].s === '1' && twins[1].s === '1' &&
     twins[0]._importCode === twins[1]._importCode && twins[0]._importCodeBack === twins[1]._importCodeBack &&
     twins[0]._importCode === (sample.codeFront || '') && twins[0]._importJob === twins[1]._importJob);
  ok('their description STARTS with "dopjim "', twins.every(r => r._importPart === ('dopjim ' + (sample.part || '').trim()).trim() && r.koment === r._importPart));
  ok('a normal label row has no dopjim', rows.filter(r => !r._importDopjim).every(r => !/dopjim/.test(r._importPart)));
  ok('toast reports the dopjim rows', /dopjim/.test(toasts[toasts.length - 1] || ''));

  // D. the saw label (WinCut [Dati]) for the twins
  const block = blocks[0];
  block.rows = twins.map(r => ({ ...r }));         // just the pair, qty 1 each
  el('nr-fatura').value = '120'; el('klienti').value = 'Gre';
  F.setBlocks([block]);
  const w = sample.length, h = sample.width;
  const content = ['[Intestazione]', 'Descrizione=X', 'TipoMateriale=Y', '[Righe]', 'NumeroRighe=2',
    '1=RY,10.000000,1,0.000000,0.000000,0.000000,0.000000', `2=Y,${h}.000000,1,0.000000,0.000000,0.000000,0.000000`,
    '[Dati]', 'NumeroDati=1', `1=,,2,CuttElab,,1,${w}.00,${h}.00,18.00,,0,2`, '[Riferimenti]', '1=', '2=(1)'].join('\r\n');
  const out = F._injectCodesIntoTxt(content, block, F._buildImportQueueForGroup([block]));
  const dati = out.split(/\r?\n/).filter(l => /^\d+=,,1,CuttElab/.test(l));
  console.log('   label 1:', dati[0]); console.log('   label 2:', dati[1]);
  ok('two labels emitted', dati.length === 2);
  ok('both labels identical', dati.length === 2 && dati[0].replace(/^\d+=/, '') === dati[1].replace(/^\d+=/, ''));
  ok('label description carries "dopjim" and the barcodes', dati.every(l => l.split(',')[7].startsWith('dopjim ') && l.split(',')[11] === (sample.codeFront || '') && l.split(',')[5] === String(sample.caseNumber)));

  console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL PASS'} (${pass} ok)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e && e.stack || e); process.exit(1); });
