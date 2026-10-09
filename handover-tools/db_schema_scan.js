// READ-ONLY schema scan of the live Firestore DB via REST (gcloud user token).
// Prints collection counts + union of field paths with types. Never prints values.
const { execSync } = require('child_process');
const TOKEN = execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
const P = 'incoservice-4e196';
const H = { Authorization: 'Bearer ' + TOKEN, 'x-goog-user-project': P, 'Content-Type': 'application/json' };
const BASE = `https://firestore.googleapis.com/v1/projects/${P}/databases/(default)`;

function typeOf(v) { return Object.keys(v)[0].replace('Value', ''); }
// Walk a Firestore Value; collect "path: type" with arrays as [] and maps as .
function walk(v, path, acc, depthCap = 7) {
  const t = typeOf(v);
  const add = (p, ty) => { const s = acc.get(p) || new Set(); s.add(ty); acc.set(p, s); };
  if (t === 'map') {
    add(path || '(root)', 'map');
    if (path.split('.').length > depthCap) return;
    const f = (v.mapValue && v.mapValue.fields) || {};
    for (const k of Object.keys(f)) {
      // Collapse dynamic keys (ids) so the schema stays readable.
      const kk = /^(fmt_|mat_|t_|klt_|\d+$)/.test(k) ? '<id>' : k;
      walk(f[k], path ? path + '.' + kk : kk, acc, depthCap);
    }
  } else if (t === 'array') {
    add(path, 'array');
    for (const el of ((v.arrayValue && v.arrayValue.values) || [])) walk(el, path + '[]', acc, depthCap);
  } else add(path, t);
}
async function listAll(coll) {
  const docs = []; let pageToken = '';
  do {
    const r = await fetch(`${BASE}/documents/${coll}?pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`, { headers: H });
    const j = await r.json();
    if (j.error) throw new Error(coll + ': ' + j.error.message);
    docs.push(...(j.documents || []));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return docs;
}
(async () => {
  const db = await (await fetch(BASE, { headers: H })).json();
  console.log('DATABASE:', JSON.stringify({ name: db.name, locationId: db.locationId, type: db.type,
    concurrencyMode: db.concurrencyMode, pitr: db.pointInTimeRecoveryEnablement, deleteProtection: db.deleteProtectionState,
    appEngineIntegrationMode: db.appEngineIntegrationMode, edition: db.databaseEdition, versionRetentionPeriod: db.versionRetentionPeriod }));
  const lc = await (await fetch(`${BASE}/documents:listCollectionIds`, { method: 'POST', headers: H, body: JSON.stringify({ pageSize: 100 }) })).json();
  const colls = lc.collectionIds || [];
  console.log('ROOT COLLECTIONS:', colls.join(', '));
  const idx = await (await fetch(`${BASE}/collectionGroups/-/indexes`, { headers: H })).json();
  console.log('COMPOSITE INDEXES:', JSON.stringify((idx.indexes || []).map(i => ({ coll: i.name.split('/collectionGroups/')[1].split('/')[0], fields: i.fields, state: i.state }))));
  for (const c of colls) {
    const docs = await listAll(c);
    const acc = new Map();
    const ids = docs.map(d => d.name.split('/').pop());
    for (const d of docs) walk({ mapValue: { fields: d.fields || {} } }, '', acc);
    // Sub-collections of the first few docs
    const subs = new Set();
    for (const d of docs.slice(0, 5)) {
      const s = await (await fetch(`https://firestore.googleapis.com/v1/${d.name}:listCollectionIds`, { method: 'POST', headers: H, body: '{}' })).json();
      (s.collectionIds || []).forEach(x => subs.add(x));
    }
    const sizes = docs.map(d => JSON.stringify(d.fields || {}).length);
    console.log(`\n=== ${c}  (${docs.length} docs; id samples: ${ids.slice(0, 4).map(i => /^[0-9]+$|^(global|formats|materials|tenies|porosite)$|^fatura_/.test(i) ? i : i.replace(/[^_]/g, (ch, k) => k < 4 ? ch : '•')).join(' | ')}; max JSON ~${Math.max(0, ...sizes)} chars${subs.size ? '; SUBCOLLECTIONS: ' + [...subs].join(',') : ''})`);
    for (const [p, t] of [...acc.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (p === '(root)') continue;
      console.log('  ' + p + ' : ' + [...t].join('|'));
    }
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
