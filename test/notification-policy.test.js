import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { previousFailures, refreshFailed, notificationPolicy } from '../scripts/notification-policy.js';

const successful = [{ name: 'test', conclusion: 'success' }, { name: 'update', conclusion: 'success' }];
const failed = [{ name: 'test', conclusion: 'success' }, {
  name: 'update', conclusion: 'success', steps: [{ name: 'Commit fresh results', conclusion: 'failure' }]
}];
const refreshOk = [{ name: 'refresh', conclusion: 'success', steps: [
  { name: 'Tolerated refresh failure', conclusion: 'skipped' }] }];
const refreshTolerated = [{ name: 'refresh', conclusion: 'success', steps: [
  { name: 'Run npm test', conclusion: 'success' }, { name: 'Tolerated refresh failure', conclusion: 'success' }] }];
const current = { id: 20, run_number: 20, head_branch: 'main', workflow_id: 1 };
function run(id, extra = {}) {
  return { id, run_number: id, event: 'schedule', status: 'completed', conclusion: 'success', ...extra };
}
function history(runs, jobs) {
  const calls = [];
  return { calls, request: async (endpoint) => {
    calls.push(endpoint);
    if (endpoint.endsWith('/runs/20')) return current;
    if (endpoint.includes('/workflows/1/runs?')) return { workflow_runs: runs };
    const id = Number(endpoint.match(/\/runs\/(\d+)\/jobs/)[1]);
    assert.match(endpoint, /filter=latest/);
    return { jobs: jobs[id] };
  } };
}
const options = { repository: 'owner/repo', runId: '20' };

test('first and second failures are tolerated; third and later failures alert; success resets', async () => {
  for (const [jobs, expected] of [
    [{ 19: successful }, 0],
    [{ 19: failed, 18: successful }, 1],
    [{ 19: failed, 18: failed }, 2],
    [{ 19: successful, 18: failed }, 0]
  ]) {
    const fixture = history([run(19), run(18)], jobs);
    assert.equal(await previousFailures({ ...options, request: fixture.request }), expected);
  }
  assert.equal(await previousFailures({ ...options, request: history([], {}).request }), 0);
});

test('counts actual test failures, setup failures, push failures, and timeouts despite tolerated conclusions', () => {
  assert.equal(refreshFailed(failed), true);
  assert.equal(refreshFailed([{ name: 'test', conclusion: 'failure' }, { name: 'update', conclusion: 'skipped' }]), true);
  assert.equal(refreshFailed([{ name: 'update', conclusion: 'timed_out' }]), true);
  assert.equal(refreshFailed([{ name: 'update', conclusion: 'success', steps: [{ conclusion: 'failure' }] }]), true);
  assert.equal(refreshFailed(successful), false);
  assert.equal(refreshFailed(refreshOk), false);
  assert.equal(refreshFailed(refreshTolerated), true);
  assert.equal(refreshFailed([{ name: 'refresh', conclusion: 'failure' }]), true);
  assert.throws(() => refreshFailed([]), /missing/);
});

test('single-job history counts tolerated failures and mixes with older three-job history', async () => {
  const fixture = history([run(19), run(18), run(17)], { 19: refreshTolerated, 18: refreshTolerated, 17: failed });
  assert.equal(await previousFailures({ ...options, request: fixture.request }), 2);
  const reset = history([run(19), run(18)], { 19: refreshOk, 18: refreshTolerated });
  assert.equal(await previousFailures({ ...options, request: reset.request }), 0);
});

test('ignores PRs, current reruns, and newer runs; includes manual refreshes', async () => {
  const fixture = history([run(21), run(20), run(19, { event: 'pull_request' }),
    run(18, { event: 'workflow_dispatch' }), run(17)], { 18: failed, 17: failed });
  assert.equal(await previousFailures({ ...options, request: fixture.request }), 2);
  assert.equal(fixture.calls.filter((call) => call.includes('/jobs?')).length, 2);
  assert.ok(fixture.calls.some((call) => call.includes('branch=main')));
});

test('cancelled and unfinished runs do not establish three consecutive failures', async () => {
  for (const extra of [{ conclusion: 'cancelled' }, { status: 'in_progress', conclusion: null }]) {
    const fixture = history([run(19, extra), run(18)], { 18: failed });
    assert.equal(await previousFailures({ ...options, request: fixture.request }), 0);
    assert.equal(fixture.calls.length, 2);
  }
});

test('paginates past PR history and bounds history requests', async () => {
  const prs = Array.from({ length: 100 }, () => run(19, { event: 'pull_request' }));
  const fixture = history([run(18), run(17)], { 18: failed, 17: failed });
  const request = (endpoint) => new URL(endpoint, 'https://api.github.com').searchParams.get('page') === '1' ?
    { workflow_runs: prs } : fixture.request(endpoint);
  assert.equal(await previousFailures({ ...options, request }), 2);
  await assert.rejects(previousFailures({ ...options, request: async (endpoint) =>
    endpoint.endsWith('/runs/20') ? current : { workflow_runs: prs } }), /300 workflow runs/);
});

test('writes the workflow tolerance output and summary, and rejects unavailable history', async () => {
  await fs.mkdir('temp', { recursive: true });
  const directory = await fs.mkdtemp(path.join('temp', 'notification-test-'));
  try {
    const env = { GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '20', GITHUB_TOKEN: 'fixture-token',
      GITHUB_OUTPUT: path.join(directory, 'output'), GITHUB_STEP_SUMMARY: path.join(directory, 'summary') };
    for (const [jobs, expected] of [[{ 19: successful }, true], [{ 19: failed, 18: failed }, false]]) {
      const fixture = history([run(19), run(18)], jobs);
      await fs.writeFile(env.GITHUB_OUTPUT, '');
      await notificationPolicy({ env, fetchImpl: async (url, config) => {
        assert.equal(config.headers.Authorization, 'Bearer fixture-token');
        assert.ok(config.signal instanceof AbortSignal);
        return { ok: true, json: () => fixture.request(url.replace('https://api.github.com', '')) };
      } });
      assert.equal(await fs.readFile(env.GITHUB_OUTPUT, 'utf8'), 'tolerate=' + expected + '\n');
    }
    assert.match(await fs.readFile(env.GITHUB_STEP_SUMMARY, 'utf8'), /successful refresh resets/);
    await assert.rejects(notificationPolicy({ env, fetchImpl: async () => ({ ok: false, status: 403 }) }), /HTTP 403/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
