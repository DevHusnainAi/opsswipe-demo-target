// OpsSwipe proof. Replays the production requests that failed (saved in .opsswipe/replays)
// against this PR's running build, then reports the result to OpsSwipe with a GitHub OIDC token.
// Zero dependencies. Usage: node .opsswipe/proof.mjs http://127.0.0.1:3000
import fs from 'node:fs';
import path from 'node:path';

export function loadSamples(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).samples || []);
}

export async function replayAll(baseUrl, dir) {
  const results = [];
  for (const s of loadSamples(dir)) {
    const init = { method: s.method, signal: AbortSignal.timeout(10000) };
    if (s.body && s.method !== 'GET' && s.method !== 'HEAD') init.body = s.body;
    const status = await fetch(new URL(s.path, baseUrl), init).then((r) => r.status, () => 0);
    results.push({ method: s.method, path: s.path, was: s.status, now: status, passed: status >= 200 && status < 500 });
  }
  return { passed: results.filter((r) => r.passed).length, total: results.length, results };
}

async function oidcToken() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new Error('add "permissions: id-token: write" to the workflow');
  const res = await fetch(url + '&audience=opsswipe', { headers: { Authorization: 'bearer ' + bearer } });
  return (await res.json()).value;
}

async function main() {
  const r = await replayAll(process.argv[2] || 'http://127.0.0.1:3000', '.opsswipe/replays');
  // Most PRs aren't OpsSwipe fixes: nothing to replay is not a failure, and nothing to report.
  if (r.total === 0) {
    console.log('No production failures to replay in this PR: nothing for OpsSwipe to prove.');
    process.exit(0);
  }
  for (const x of r.results) console.log((x.passed ? 'PASS ' : 'FAIL ') + x.method + ' ' + x.path + ' was ' + x.was + ', now ' + x.now);
  console.log(r.passed + '/' + r.total + ' failing production requests now pass');
  const testsPassed = process.env.TESTS_PASSED === 'true';
  const proofUrl = process.env.OPSSWIPE_PROOF_URL;
  if (proofUrl && process.env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const body = JSON.stringify({
      headSha: event.pull_request.head.sha,
      replay: { passed: r.passed, total: r.total },
      tests: { passed: testsPassed },
      runUrl: process.env.GITHUB_SERVER_URL + '/' + process.env.GITHUB_REPOSITORY + '/actions/runs/' + process.env.GITHUB_RUN_ID,
    });
    const res = await fetch(proofUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (await oidcToken()) },
      body,
    });
    console.log('OpsSwipe answered ' + res.status + ': ' + (await res.text()));
  }
  process.exit(testsPassed && r.total > 0 && r.passed === r.total ? 0 : 1);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) main();
