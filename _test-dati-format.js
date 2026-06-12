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
  console.log('Scenario 1 — manual order:');
  expectEq('line 1', dati[0],
    '1=,,1,CuttElab,Erion Gjokeja/119,,MDF Bardhe Shqeto 18mm,,1200,900,18,Pasqyre patura e pasqyres mbrapa,#119-1,');
  expectEq('line 2', dati[1],
    '2=,,1,CuttElab,Erion Gjokeja/119,,MDF Bardhe Shqeto 18mm,,1200,900,18,Pasqyre patura e pasqyres mbrapa,#119-1,');
  expectEq('line 3', dati[2],
    '3=,,1,CuttElab,Erion Gjokeja/119,,MDF Bardhe Shqeto 18mm,,412,180,18,Gola inkaso,#119-1,');
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
    '1=,,1,CuttElab,Erion Gjokeja/119,,MDF Bardhe Shqeto 18mm,,1200,900,18,Rafte,#119-2,');
  expectEq('line 3 (empty koment)', dati[2],
    '3=,,1,CuttElab,Erion Gjokeja/119,,MDF Bardhe Shqeto 18mm,,412,180,18,,#119-2,');
}

// ── Scenario 3: PDF order — byte-identical legacy layout ─────────────
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
  console.log('Scenario 3 — PDF order (legacy layout, untouched):');
  expectEq('line 1', dati[0],
    '1=,,1,CuttElab,flavio vali/KZH,7,MDF Bardhe Shqeto 18mm,Side Panel,1200,900,18,C1,C1B');
  expectEq('line 3', dati[2],
    '3=,,1,CuttElab,flavio vali/KZH,8,MDF Bardhe Shqeto 18mm,Shelf,412,180,18,C9,');
}

// ── Scenario 4: MIXED order (one PDF row anywhere) → legacy everywhere ─
{
  const pdfBlock = {
    id: 5, materialId: 'm1', formatId: 'f1',
    rows: [ { l: '600', g: '300', s: '1', _importPart: 'X', _importCaseNumber: '1' } ],
  };
  const manualBlock = {
    id: 1, materialId: 'm1', formatId: 'f1',
    rows: [ { l: '1200', g: '900', s: '2', koment: 'Rafte' },
            { l: '412',  g: '180', s: '1', koment: 'Gola' } ],
  };
  const blocks = [manualBlock, pdfBlock];
  const fns = makeFns(docStub, blocks, pricesStub);
  const queue = fns._buildImportQueueForGroup([manualBlock]);
  const out = fns._injectCodesIntoTxt(RAW, manualBlock, queue);
  const dati = getDati(out);
  console.log('Scenario 4 — mixed order stays legacy:');
  expectEq('line 1', dati[0],
    '1=,,1,CuttElab,Erion Gjokeja/119,,MDF Bardhe Shqeto 18mm,Rafte,1200,900,18,,');
}

// ── Scenario 5: export-time "#—-N" fixup (optimize-before-save case) ──
{
  const baked = [
    '[Dati]',
    'NumeroDati=3',
    '1=,,1,CuttElab,Alban Elezi,,Melamine e bardhe 16mm,,444,444,16,123,#—-1,',
    '2=,,1,CuttElab,Alban Elezi,,Melamine e bardhe 16mm,,555,555,16,9999,#—-2,',
    '3=,,1,CuttElab,flavio vali/KZH,7,MDF Bardhe Shqeto 18mm,Side Panel,1200,900,18,C1,C1B',
  ].join('\r\n');
  const fns = makeFns(docStub, [], pricesStub);          // nr-fatura = '119'
  const fixed = fns._fixupManualSubLabels(baked).split('\r\n');
  console.log('Scenario 5 — export-time fatura fixup:');
  expectEq('placeholder #—-1 → #119-1', fixed[2],
    '1=,,1,CuttElab,Alban Elezi,,Melamine e bardhe 16mm,,444,444,16,123,#119-1,');
  expectEq('placeholder #—-2 → #119-2', fixed[3],
    '2=,,1,CuttElab,Alban Elezi,,Melamine e bardhe 16mm,,555,555,16,9999,#119-2,');
  expectEq('PDF line untouched', fixed[4],
    '3=,,1,CuttElab,flavio vali/KZH,7,MDF Bardhe Shqeto 18mm,Side Panel,1200,900,18,C1,C1B');

  // Already-correct labels stay; empty fatura input = no-op.
  const good = '5=,,1,CuttElab,X,,M,,10,10,16,d,#127-3,';
  expectEq('already-correct label unchanged', fns._fixupManualSubLabels(good), good);
  const noFatura = {
    getElementById: (id) => id === 'nr-fatura' ? { value: '' } : { value: 'K' },
  };
  const fns2 = makeFns(noFatura, [], pricesStub);
  expectEq('no fatura yet → unchanged', fns2._fixupManualSubLabels(baked), baked);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
