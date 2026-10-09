// Test a Firestore ruleset SOURCE against cases via the Firebase Rules API
// (no deploy). Usage: node rules_test.js <rulesFile|--deployed>
const { execSync } = require('child_process');
const fs = require('fs');
const TOKEN = execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
const H = { Authorization: 'Bearer ' + TOKEN, 'x-goog-user-project': 'incoservice-4e196', 'Content-Type': 'application/json' };
const API = 'https://firebaserules.googleapis.com/v1/projects/incoservice-4e196';
(async () => {
  let content;
  if (process.argv[2] === '--deployed') {
    const rel = await (await fetch(API + '/releases/cloud.firestore', { headers: H })).json();
    const rs = await (await fetch('https://firebaserules.googleapis.com/v1/' + rel.rulesetName, { headers: H })).json();
    content = rs.source.files[0].content;
    console.log('Testing DEPLOYED ruleset', rel.rulesetName);
  } else {
    content = fs.readFileSync(process.argv[2], 'utf8');
    console.log('Testing source file', process.argv[2]);
  }
  const auth = { uid: 'u1', token: { email: 'albanisela@gmail.com', email_verified: true } };
  const P = c => `/databases/(default)/documents/${c}`;
  const cases = [
    ['create porosite_trash (signed in)', 'create', 'porosite_trash/200', auth],
    ['read   porosite_trash (signed in)', 'get',    'porosite_trash/200', auth],
    ['create paint_sessions (signed in)', 'create', 'paint_sessions/abc', auth],
    ['update paint_sessions (signed in)', 'update', 'paint_sessions/abc', auth],
    ['create workers (signed in)',        'create', 'workers/w1', auth],
    ['create porosite_trash (ANON)',      'create', 'porosite_trash/200', null],
    ['create paint_sessions (ANON)',      'create', 'paint_sessions/abc', null],
    ['write  porosite (signed in)',       'update', 'porosite/200', auth],
    ['write  unknown_coll (signed in)',   'create', 'unknown_coll/x', auth],
    ['delete paint_sessions (signed in)', 'delete', 'paint_sessions/abc', auth],
    ['delete porosite (signed in)',       'delete', 'porosite/200', auth],
    ['read   workers (signed in)',        'list',   'workers/w1', auth],
  ];
  const testCases = cases.map(([, method, path, a]) => ({
    expectation: 'ALLOW',
    request: { auth: a, path: P(path), method },
    resource: { data: {} },
  }));
  const res = await (await fetch(API + ':test', { method: 'POST', headers: H,
    body: JSON.stringify({ source: { files: [{ name: 'firestore.rules', content }] }, testSuite: { testCases } }) })).json();
  if (!res.testResults) { console.log(JSON.stringify(res).slice(0, 800)); return; }
  res.testResults.forEach((r, i) => console.log(`  ${r.state === 'SUCCESS' ? 'ALLOW' : 'DENY '}  ${cases[i][0]}`));
})().catch(e => { console.error(e); process.exit(1); });
