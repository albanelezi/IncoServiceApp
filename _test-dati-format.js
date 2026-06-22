// Standalone test for the manual-vs-PDF [Dati] label format change in
// _injectCodesIntoTxt. Extracts the live functions from the source HTML
// (no duplication drift) and runs them with stubbed DOM globals.
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'INCO_Furniture_v12.src.html'), 'utf8');
function extract(startMarker, endMarker) {
  const s = html.indexOf(startMarker);
  if (s < 0) throw new Error('start marker not found: ' + startMarker);
  const e = html.indexOf(endMarker, s);
  if (e < 0) throw new Error('end marker not found: ' + endMarker);
  return html.slice(s, e);
}
const code =
  extract('function _buildImportQueueForGroup', 'function _buildImportQueueForBlock') +
  extract('function _buildImportQueueForBlock', '// Per-block label-printing gate') +
  extract('function _fixupManualSubLabels', 'function _stripLabelRefsIfDisabled') +
  extract('function _injectCodesIntoTxt', 'function _meGenFileContent');

const makeFns = new Function('document', 'blocks', 'loadPrices',
  code + '\nreturn { _buildImportQueueForGroup, _buildImportQueueForBlock, _injectCodesIntoTxt, _fixupManualSubLabels };');

// ── Shared stubs ─────────────────────────────────────────────────────
const docStub = {
  getElementById: (id) => {
    if (id === 'klienti')   return { value: 'Erion Gjokeja' };
    if (id === 'nr-fatura') return { value: '119' };
    return null;
  },
};
const pricesStub = () => ({
  materials: [{ id: 'm1', description: 'MDF Bardhe Shqeto' }],
  formats:   [{ id: 'f1', thickness: 18 }],
  tenies: [],
});

// Synthetic raw worker output: one consolidated type, qty 2 (1200x900),
// plus a second type qty 1 (412x180).
const RAW = [
  '[Intestazione]',
  'Descrizione=Erion Gjokeja',
  'TipoMateriale=Erion Gjokeja_1',
  'Lunghezza=3660.000000',
  'Larghezza=1830.000000',
  'Spessore=18.000000',
  'AltPacco=90.000000',
  'VelRotaz=3000',
  'VelAvanz=32.000000',
  '[Righe]',
  'NumeroRighe=5',
  '1=RY,10.000000,1,0.000000,0.000000,0.000000,0.000000',
  '2=Y,900.000000,1,0.000000,0.000000,0.000000,0.000000',
  '3=RX,10.000000,1,0.000000,0.000000,0.000000,0.000000',
  '4=X,1200.000000,2,0.000000,0.000000,0.000000,0.000000',
  '5=X,412.000000,1,0.000000,0.000000,0.000000,0.000000',
  '[Dati]',
  'NumeroDati=2',
  '1=,,2,CuttElab,,2,1200.00,900.00,18.00,,0,2',
  '2=,,1,CuttElab,,1,412.00,180.00,18.00,,0,1',
  '[Riferimenti]',
  '1=',
  '2=',
  '3=',
  '4=(1)',
  '5=(2)',
].join('\r\n');

function getDati(out) {
  const lines = out.split('\r\n');
  const s = lines.indexOf('[Dati]');
  const e = lines.findIndex((l, i) => i > s && l.startsWith('[') );
  return lines.slice(s + 1, e).filter(l => !l.startsWith('NumeroDati='));
}

let failures = 0;
function expectEq(label, actual, expected) {
  if (actual === expected) { console.log('  OK  ' + label); }
  else {
    failures++;
    console.log('  FAIL ' + label);
    console.log('    expected: ' + expected);
    console.log('    actual:   ' + actual);
  }
}

// Unified format (field 11 = "#fatura-N", last field, no trailing comma):
//   ,,1,CuttElab,<project>,<case>,<material>,<desc>,<W>,<H>,<T>,<front>,<back>,<#fatura-N>

// ── Scenario 1: MANUAL order (komente only, comma inside one koment) ──
{
  const blockA = {
    id: 1, materialId: 'm1', formatId: 'f1',
    rows: [
      { l: '1200', g: '900', s: '2', koment: 'Pasqyre, patura e pasqyres mbrapa' },
      { l: '412',  g: '180', s: '1', koment: 'Gola inkaso' },
    ],
  };
  const blockB = { id: 2, materialId: 'm1', formatId: 'f1', rows: [] }; // position filler
  const blocks = [blockA, blockB];
  const fns = makeFns(docStub, blocks, pricesStub);
  const queue = fns._buildImportQueueForGroup([blockA]);
  const out = fns._injectCodesIntoTxt(RAW, blockA, queue);
  const dati = getDati(out);
  console.log('Scenario 1 — manual order (unified, comma stripped):');
  expectEq('line 1', dati[0],
    '1=,,1,CuttElab,Erion Gjokeja/119,,MDF Bardhe Shqeto 18mm,Pasqyre patura e pasqyres mbrapa,1200,900,18,,,#119-1');
  expectEq('line 2', dati[1],
    '2=,,1,CuttElab,Erion Gjokeja/119,,MDF Bardhe Shqeto 18mm,Pasqyre patura e pasqyres mbrapa,1200,900,18,,,#119-1');
  expectEq('line 3', dati[2],
    '3=,,1,CuttElab,Erion Gjokeja/119,,MDF Bardhe Shqeto 18mm,Gola inkaso,412,180,18,,,#119-1');
}

// ── Scenario 2: manual order, block at position 2 → "#119-2" ─────────
{
  const filler = { id: 9, materialId: 'm1', formatId: 'f1', rows: [] };
  const blockA = {
    id: 1, materialId: 'm1', formatId: 'f1',
    rows: [ { l: '1200', g: '900', s: '2', koment: 'Rafte' },
            { l: '412',  g: '180', s: '1', koment: '' } ],
  };
  const blocks = [filler, blockA];
  const fns = makeFns(docStub, blocks, pricesStub);
  const queue = fns._buildImportQueueForGroup([blockA]);
  const out = fns._injectCodesIntoTxt(RAW, blockA, queue);
  const dati = getDati(out);
  console.log('Scenario 2 — manual, second section:');
  expectEq('line 1', dati[0],
    '1=,,1,CuttElab,Erion Gjokeja/119,,MDF Bardhe Shqeto 18mm,Rafte,1200,900,18,,,#119-2');
  expectEq('line 3 (empty koment)', dati[2],
    '3=,,1,CuttElab,Erion Gjokeja/119,,MDF Bardhe Shqeto 18mm,,412,180,18,,,#119-2');
}

// ── Scenario 3: PDF order — same unified layout + field 11 ───────────
{
  const blockA = {
    id: 1, materialId: 'm1', formatId: 'f1', _importJob: 'flavio vali/KZH',
    rows: [
      { l: '1200', g: '900', s: '2', koment: '',
        _importPart: 'Side Panel', _importCode: 'C1', _importCodeBack: 'C1B',
        _importCaseNumber: '7', _importJob: 'flavio vali/KZH' },
      { l: '412', g: '180', s: '1', koment: '',
        _importPart: 'Shelf', _importCode: 'C9', _importCodeBack: '',
        _importCaseNumber: '8', _importJob: 'flavio vali/KZH' },
    ],
  };
  const blocks = [blockA];
  const fns = makeFns(docStub, blocks, pricesStub);
  const queue = fns._buildImportQueueForGroup([blockA]);
  const out = fns._injectCodesIntoTxt(RAW, blockA, queue);
  const dati = getDati(out);
  console.log('Scenario 3 — PDF order (unified + field 11):');
  expectEq('line 1', dati[0],
    '1=,,1,CuttElab,flavio vali/KZH,7,MDF Bardhe Shqeto 18mm,Side Panel,1200,900,18,C1,C1B,#119-1');
  expectEq('line 3 (empty back barcode)', dati[2],
    '3=,,1,CuttElab,flavio vali/KZH,8,MDF Bardhe Shqeto 18mm,Shelf,412,180,18,C9,,#119-1');
}

// ── Scenario 4: PDF desc WITH a comma → stripped, field 11 stays last ─
{
  const blockA = {
    id: 1, materialId: 'm1', formatId: 'f1', _importJob: 'flavio vali/KZH',
    rows: [
      { l: '1200', g: '900', s: '2', koment: '',
        _importPart: 'Side, Panel', _importCode: 'C1', _importCodeBack: 'C1B',
        _importCaseNumber: '7', _importJob: 'flavio vali/KZH' },
      { l: '412', g: '180', s: '1', koment: '',
        _importPart: 'Shelf', _importCode: 'C9', _importCodeBack: 'C9B',
        _importCaseNumber: '8', _importJob: 'flavio vali/KZH' },
    ],
  };
  const blocks = [blockA];
  const fns = makeFns(docStub, blocks, pricesStub);
  const queue = fns._buildImportQueueForGroup([blockA]);
  const out = fns._injectCodesIntoTxt(RAW, blockA, queue);
  const dati = getDati(out);
  console.log('Scenario 4 — comma in PDF desc is stripped:');
  expectEq('comma stripped, 13 fields', dati[0],
    '1=,,1,CuttElab,flavio vali/KZH,7,MDF Bardhe Shqeto 18mm,Side Panel,1200,900,18,C1,C1B,#119-1');
}

// ── Scenario 5: export-time "#—-N" fixup (optimize-before-save case) ──
{
  const baked = [
    '[Dati]',
    'NumeroDati=3',
    '1=,,1,CuttElab,Alban Elezi,,Melamine e bardhe 16mm,Sirtar,444,444,16,,,#—-1',
    '2=,,1,CuttElab,Alban Elezi,,Melamine e bardhe 16mm,Kapak,555,555,16,,,#—-2',
    '3=,,1,CuttElab,flavio vali/KZH,7,MDF Bardhe Shqeto 18mm,Side Panel,1200,900,18,C1,C1B,#119-1',
  ].join('\r\n');
  const fns = makeFns(docStub, [], pricesStub);          // nr-fatura = '119'
  const fixed = fns._fixupManualSubLabels(baked).split('\r\n');
  console.log('Scenario 5 — export-time fatura fixup (field 11):');
  expectEq('placeholder #—-1 → #119-1', fixed[2],
    '1=,,1,CuttElab,Alban Elezi,,Melamine e bardhe 16mm,Sirtar,444,444,16,,,#119-1');
  expectEq('placeholder #—-2 → #119-2', fixed[3],
    '2=,,1,CuttElab,Alban Elezi,,Melamine e bardhe 16mm,Kapak,555,555,16,,,#119-2');
  expectEq('already-correct line untouched', fixed[4],
    '3=,,1,CuttElab,flavio vali/KZH,7,MDF Bardhe Shqeto 18mm,Side Panel,1200,900,18,C1,C1B,#119-1');

  // CRLF preserved through the fixup (no \r leak / loss).
  expectEq('CRLF line count preserved',
    String(fns._fixupManualSubLabels(baked).split('\r\n').length), '5');

  // Empty fatura input = no-op.
  const noFatura = {
    getElementById: (id) => id === 'nr-fatura' ? { value: '' } : { value: 'K' },
  };
  const fns2 = makeFns(noFatura, [], pricesStub);
  expectEq('no fatura yet → unchanged', fns2._fixupManualSubLabels(baked), baked);
}

// ── Scenario 6: comment added AFTER optimize → re-derived at export ──
// Reproduces the reported bug: optimize bakes the label while koment is
// empty (field 5 blank), the operator then types a comment, and export
// must re-derive field 5 from the now-current rows.  This is exactly what
// _rebakeBlockLabels does — re-inject from the pristine optimizer content
// with a queue rebuilt from the current rows.
{
  // Step 1: optimize-time bake with EMPTY komente.
  const blockEmpty = {
    id: 1, materialId: 'm1', formatId: 'f1',
    rows: [ { l: '1200', g: '900', s: '2', koment: '' },
            { l: '412',  g: '180', s: '1', koment: '' } ],
  };
  const fns1 = makeFns(docStub, [blockEmpty], pricesStub);
  const baked = fns1._injectCodesIntoTxt(
    RAW, blockEmpty, fns1._buildImportQueueForGroup([blockEmpty]));
  const bakedDati = getDati(baked);
  console.log('Scenario 6 — comment added after optimize:');
  expectEq('baked field 5 empty (the bug)', bakedDati[0],
    '1=,,1,CuttElab,Erion Gjokeja/119,,MDF Bardhe Shqeto 18mm,,1200,900,18,,,#119-1');

  // Step 2: operator types comments; export re-derives from the SAME raw.
  const blockNow = {
    id: 1, materialId: 'm1', formatId: 'f1',
    rows: [ { l: '1200', g: '900', s: '2', koment: 'Anesore' },
            { l: '412',  g: '180', s: '1', koment: 'Baza' } ],
  };
  const fns2 = makeFns(docStub, [blockNow], pricesStub);
  const rebaked = fns2._injectCodesIntoTxt(
    RAW, blockNow, fns2._buildImportQueueForGroup([blockNow]));
  const rebakedDati = getDati(rebaked);
  expectEq('rebaked line 1 field 5 = koment', rebakedDati[0],
    '1=,,1,CuttElab,Erion Gjokeja/119,,MDF Bardhe Shqeto 18mm,Anesore,1200,900,18,,,#119-1');
  expectEq('rebaked line 2 field 5 = koment', rebakedDati[1],
    '2=,,1,CuttElab,Erion Gjokeja/119,,MDF Bardhe Shqeto 18mm,Anesore,1200,900,18,,,#119-1');
  expectEq('rebaked line 3 field 5 = koment', rebakedDati[2],
    '3=,,1,CuttElab,Erion Gjokeja/119,,MDF Bardhe Shqeto 18mm,Baza,412,180,18,,,#119-1');
}

// ── Scenario 7: batched X-strip (rep>1) → unique barcode per piece ───
// Reproduces the Gjergji Lac 108 bug: the optimizer batches 2 identical
// 65-wide strips into `X,65,2` with one body of 4 U-cuts.  Before the fix
// only 4 references were assigned and the 2nd strip reprinted them; after,
// the opener is un-batched into 2 strips so all 8 pieces get distinct refs.
{
  const RAW_XBATCH = [
    '[Intestazione]',
    'Descrizione=Komid/Gjergj',
    'TipoMateriale=Komid/Gjergj_1',
    'Lunghezza=2800.000000', 'Larghezza=2070.000000', 'Spessore=18.000000',
    'AltPacco=90.000000', 'VelRotaz=3000', 'VelAvanz=32.000000',
    '[Righe]', 'NumeroRighe=4',
    '1=RX,10.000000,1,0.000000,0.000000,0.000000,0.000000',
    '2=X,65.000000,2,0.000000,0.000000,0.000000,0.000000',   // 2 identical strips
    '3=RU,10.000000,1,0.000000,0.000000,0.000000,0.000000',
    '4=U,464.000000,4,0.000000,0.000000,0.000000,0.000000',  // 4 pieces per strip
    '[Dati]', 'NumeroDati=1',
    '1=,,8,CuttElab,,8,464.00,65.00,18.00,,0,8',             // 8 pieces, one type
    '[Riferimenti]', '1=', '2=', '3=', '4=(1)',
  ].join('\r\n');

  const rows8 = [];
  for (let n = 1; n <= 8; n++) {
    rows8.push({ l: '464', g: '65', s: '1', _importPart: 'Toe',
      _importCodeBack: 'r33b' + String(n).padStart(4, '0'),
      _importJob: 'Komid/Gjergj' });
  }
  const blockX = { id: 1, materialId: 'm1', formatId: 'f1',
    _importJob: 'Komid/Gjergj', rows: rows8 };
  const fnsX = makeFns(docStub, [blockX], pricesStub);
  const outX = fnsX._injectCodesIntoTxt(
    RAW_XBATCH, blockX, fnsX._buildImportQueueForGroup([blockX]));
  const linesX = outX.split('\r\n');

  console.log('Scenario 7 — batched X-strip → unique barcode per piece:');

  // (a) The X,65,2 opener is un-batched into two X,65,1 openers.
  const openers2 = linesX.filter(l => /=X,65\.000000,2,/.test(l)).length;
  const openers1 = linesX.filter(l => /=X,65\.000000,1,/.test(l)).length;
  expectEq('no rep-2 X opener remains', String(openers2), '0');
  expectEq('two rep-1 X openers emitted', String(openers1), '2');

  // (b) [Riferimenti] references all 8 [Dati] entries exactly once.
  const rifStart = linesX.indexOf('[Riferimenti]');
  const refs = [];
  for (let i = rifStart + 1; i < linesX.length; i++) {
    const m = linesX[i].match(/^\d+=\((\d+)\)$/);
    if (m) refs.push(parseInt(m[1]));
  }
  expectEq('8 references assigned', String(refs.length), '8');
  expectEq('references are 1..8 each once',
    refs.slice().sort((a, b) => a - b).join(','), '1,2,3,4,5,6,7,8');

  // (c) The 8 expanded [Dati] lines carry 8 DISTINCT barcodes (field 10).
  const datiX = getDati(outX);
  const barcodes = datiX.map(l => l.split(',')[12]);  // field after T,front
  const uniqueBarcodes = new Set(barcodes);
  expectEq('8 distinct barcodes in [Dati]', String(uniqueBarcodes.size), '8');
  expectEq('barcodes are r33b0001..r33b0008',
    barcodes.slice().sort().join(','),
    'r33b0001,r33b0002,r33b0003,r33b0004,r33b0005,r33b0006,r33b0007,r33b0008');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
