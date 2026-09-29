// OpsSwipe proof. Replays the production requests that failed (saved in .opsswipe/replays) against
// this PR's running build and reports what each one returned now. Two steps, so the PR's code never
// runs next to the OIDC token:
//   node proof.mjs replay http://app:3000 replays > results.json   (in a container beside the app)
//   node proof.mjs report results.json                              (on the runner; signs with OIDC)
// OpsSwipe decides pass or fail from the results; the verdict printed here is only for the CI log.
// Zero dependencies.
import fs from 'node:fs';
import path from 'node:path';

export function loadSamples(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).samples || []);
}

// Fixed means: it failed in production (5xx) and this build answers 2xx. A 4xx or a redirect is a
// different error, not a fix.
export const fixed = (r) => r.was >= 500 && r.now >= 200 && r.now < 300;

async function waitUp(baseUrl) {
  for (let i = 0; i < 120; i++) {
    if (await fetch(baseUrl, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function replayAll(baseUrl, dir) {
  const samples = loadSamples(dir);
  if (samples.length) await waitUp(baseUrl);
  const results = [];
  for (const s of samples) {
    const init = { method: s.method, signal: AbortSignal.timeout(10000), redirect: 'manual' };
    if (s.body && s.method !== 'GET' && s.method !== 'HEAD') init.body = s.body;
    const now = await fetch(new URL(s.path, baseUrl), init).then((r) => r.status, () => 0);
    results.push({ method: s.method, path: s.path, was: s.status, now });
  }
  return results;
}

async function oidcToken() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new Error('add "permissions: id-token: write" to the workflow');
  const res = await fetch(url + '&audience=opsswipe', { headers: { Authorization: 'bearer ' + bearer } });
  return (await res.json()).value;
}

async function report(results) {
  // Most PRs aren't OpsSwipe fixes: nothing to replay is not a failure, and nothing to report.
  if (results.length === 0) {
    console.log('No production failures to replay in this PR: nothing for OpsSwipe to prove.');
    process.exit(0);
  }
  for (const r of results) console.log((fixed(r) ? 'FIXED ' : 'NOT FIXED ') + r.method + ' ' + r.path + ' was ' + r.was + ', now ' + r.now);
  const passed = results.filter(fixed).length;
  console.log(passed + '/' + results.length + ' failing production requests now answer 2xx');
  const testsPassed = process.env.TESTS_PASSED === 'true';
  const proofUrl = process.env.OPSSWIPE_PROOF_URL;
  if (proofUrl && process.env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const res = await fetch(proofUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (await oidcToken()) },
      body: JSON.stringify({
        headSha: event.pull_request.head.sha,
        results: results.map((r) => ({ method: r.method, path: r.path, now: r.now })),
        tests: { passed: testsPassed },
        runUrl: process.env.GITHUB_SERVER_URL + '/' + process.env.GITHUB_REPOSITORY + '/actions/runs/' + process.env.GITHUB_RUN_ID,
      }),
    });
    console.log('OpsSwipe answered ' + res.status + ': ' + (await res.text()));
  }
  process.exit(testsPassed && passed === results.length ? 0 : 1);
}

async function main() {
  const [mode, arg, dir] = process.argv.slice(2);
  if (mode === 'replay') {
    process.stdout.write(JSON.stringify(await replayAll(arg || 'http://127.0.0.1:3000', dir || '.opsswipe/replays')));
  } else if (mode === 'report') {
    await report(JSON.parse(fs.readFileSync(arg, 'utf8')));
  } else {
    // One step, for workflows added before the split: node proof.mjs http://127.0.0.1:3000
    await report(await replayAll(mode || 'http://127.0.0.1:3000', '.opsswipe/replays'));
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) main();
