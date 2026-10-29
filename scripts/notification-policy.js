import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const refreshEvents = new Set(['schedule', 'workflow_dispatch']);
const failedConclusions = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);

// A tolerated failure leaves the job green, so the workflow records it in this step; test/update are the
// job names from before the refresh ran as a single job and still appear in older run history.
const toleratedStep = 'Tolerated refresh failure';

// Inspect jobs and steps: a tolerated failure has a successful workflow conclusion.
export function refreshFailed(jobs) {
  const relevant = jobs.filter((job) => ['refresh', 'test', 'update'].includes(job.name));
  if (!relevant.length) throw new Error('Refresh jobs missing from run history');
  return relevant.some((job) => failedConclusions.has(job.conclusion) ||
    job.steps?.some((step) => failedConclusions.has(step.conclusion) ||
      (step.name === toleratedStep && step.conclusion === 'success')));
}

export async function previousFailures({ request, repository, runId }) {
  const base = '/repos/' + repository + '/actions';
  const current = await request(base + '/runs/' + runId);
  let streak = 0;
  // Bounded pagination accommodates intervening PR runs without counting them.
  for (let page = 1; page <= 3; page++) {
    const query = new URLSearchParams({ branch: current.head_branch, per_page: '100', page: String(page) });
    const result = await request(base + '/workflows/' + current.workflow_id + '/runs?' + query);
    const runs = result.workflow_runs.filter((run) => run.run_number < current.run_number &&
      refreshEvents.has(run.event)).sort((a, b) => b.run_number - a.run_number);
    for (const run of runs) {
      // A cancelled or unfinished run is not evidence of another failure.
      if (run.status !== 'completed' || run.conclusion === 'cancelled') return streak;
      const { jobs } = await request(base + '/runs/' + run.id + '/jobs?filter=latest&per_page=100');
      if (!refreshFailed(jobs)) return streak;
      if (++streak === 2) return streak;
    }
    if (result.workflow_runs.length < 100) return streak;
  }
  throw new Error('Could not establish failure streak within 300 workflow runs');
}

export async function notificationPolicy({ env = process.env, fetchImpl = fetch } = {}) {
  const request = async (endpoint) => {
    const response = await fetchImpl('https://api.github.com' + endpoint, {
      headers: { Authorization: 'Bearer ' + env.GITHUB_TOKEN, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error('GitHub history API returned HTTP ' + response.status);
    return response.json();
  };
  const streak = await previousFailures({ request, repository: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID });
  await fs.appendFile(env.GITHUB_OUTPUT, 'tolerate=' + (streak < 2) + '\n');
  const message = 'Previous consecutive refresh failures: ' + streak +
    (streak < 2 ? '. This run will tolerate a failure without a failure notification.' :
      '. A failure in this run will trigger the normal GitHub failure notification.');
  console.log(message);
  await fs.appendFile(env.GITHUB_STEP_SUMMARY, '## Notification policy\n\n' + message +
    '\n\nFailed steps and diagnostics remain visible. A successful refresh resets the streak.\n');
  return streak;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  notificationPolicy().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
