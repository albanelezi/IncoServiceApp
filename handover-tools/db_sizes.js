// READ-ONLY: approximate Firestore stored size of order docs + kanban column counts.
const { execSync } = require('child_process');
const TOKEN = execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
const P = 'incoservice-4e196';
const H = { Authorization: 'Bearer ' + TOKEN, 'x-goog-user-project': P };
const BASE = `https://firestore.googleapis.com/v1/projects/${P}/databases/(default)/documents`;
const plain = v => {
  const t = Object.keys(v)[0], x = v[t];
  if (t === 'mapValue') { const o = {}; for (const [k, y] of Object.entries(x.fields || {})) o[k] = plain(y); return o; }
  if (t === 'arrayValue') return (x.values || []).map(plain);
  if (t === 'integerValue') return Number(x);
  return x;
};
// Firestore size rules: string = bytes+1, number 8, bool 1, null 1, map/array = sum, field name bytes+1.
const fsSize = v => {
  if (v === null) return 1;
  if (typeof v === 'string') return Buffer.byteLength(v) + 1;
  if (typeof v === 'number') return 8;
  if (typeof v === 'boolean') return 1;
  if (Array.isArray(v)) return v.reduce((s, x) => s + fsSize(x), 0);
  if (typeof v === 'object') return Object.entries(v).reduce((s, [k, x]) => s + Buffer.byteLength(k) + 1 + fsSize(x), 0);
  return 8;
};
async function all(coll) {
  const out = []; let pt = '';
  do {
    const j = await (await fetch(`${BASE}/${coll}?pageSize=300${pt ? '&pageToken=' + pt : ''}`, { headers: H })).json();
    out.push(...(j.documents || [])); pt = j.nextPageToken || '';
  } while (pt);
  return out;
}
(async () => {
  const orders = await all('porosite');
  const sizes = orders.map(d => {
    const o = plain({ mapValue: { fields: d.fields } });
    const panelsBytes = (o.blocks || []).reduce((s, b) => s + fsSize(b.panels || []), 0);
    return { kb: fsSize(o) / 1024, panelsKb: panelsBytes / 1024, blocks: (o.blocks || []).length };
  }).sort((a, b) => b.kb - a.kb);
  const avg = sizes.reduce((s, x) => s + x.kb, 0) / sizes.length;
  console.log('orders:', sizes.length, 'avg KB:', avg.toFixed(0), 'top5 KB (panels KB, sections):',
    sizes.slice(0, 5).map(s => `${s.kb.toFixed(0)} (${s.panelsKb.toFixed(0)}, ${s.blocks})`).join(' | '));
  console.log('orders > 500 KB:', sizes.filter(s => s.kb > 500).length, '; > 800 KB:', sizes.filter(s => s.kb > 800).length);
  const kb = await all('kanban');
  const cols = {};
  kb.forEach(d => { const c = (d.fields.col || {}).stringValue || '?'; cols[c] = (cols[c] || 0) + 1; });
  console.log('kanban cols:', JSON.stringify(cols));
  const ph = {};
  kb.forEach(d => { const p = d.fields.phases && d.fields.phases.mapValue && d.fields.phases.mapValue.fields; const n = p ? Object.keys(p).length : 0; ph[n] = (ph[n] || 0) + 1; });
  console.log('kanban.phases key counts:', JSON.stringify(ph));
  const ctr = await (await fetch(`${BASE}/counters/porosite`, { headers: H })).json();
  console.log('counters/porosite.next =', ctr.fields && ctr.fields.next && ctr.fields.next.integerValue);
  const ids = orders.map(d => Number(d.name.split('/').pop())).filter(Number.isFinite);
  console.log('order id range:', Math.min(...ids), '-', Math.max(...ids));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
