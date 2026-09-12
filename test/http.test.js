import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';

const base = 'http://127.0.0.1:34971';
const cwd = path.resolve(import.meta.dirname, '..');
async function post(route, body) {
  const response = await fetch(base + '/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (predicate()) return true; await sleep(40); }
  return false;
}

test('HTTP control plane enforces drift, contradiction, and collision; the session guard pauses and resumes a live process', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'airlock-test-'));
  const server = spawn(process.execPath, ['src/server.js'], { cwd, env: { ...process.env, PORT: '34971', AIRLOCK_DATA_DIR: dataDir, LINEAR_WEBHOOK_SECRET: 'test-secret', OPENAI_API_KEY: '' }, stdio: 'ignore' });
  let guard;
  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try { ready = (await fetch(base + '/api/state')).ok; if (ready) break; } catch {}
      await sleep(50);
    }
    assert.equal(ready, true);
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Keep agents inside/);
    assert.equal((await fetch(base + '/app.js')).status, 200);
    const invariants = await (await fetch(base + '/api/invariants')).json();
    assert.equal(invariants.definitions.length, 5);

    const webhookBody = JSON.stringify({ webhookTimestamp: Date.now(), type: 'Comment' });
    const signature = createHmac('sha256', 'test-secret').update(webhookBody).digest('hex');
    assert.equal((await fetch(base + '/api/webhook/linear', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Linear-Signature': '0'.repeat(64) }, body: webhookBody })).status, 401);
    assert.equal((await fetch(base + '/api/webhook/linear', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Linear-Signature': signature, 'Linear-Delivery': 'test-delivery' }, body: webhookBody })).status, 200);

    await post('reset', { scenario: 'drift' });
    const lease = (await post('leases', { issueId: 'AIR-103', agent: 'Codex', readSet: ['auth/session'], writeSet: ['auth/session'] })).data;
    assert.equal(lease.facts.length, 6);
    assert.equal((await fetch(`${base}/api/leases/${lease.id}`)).status, 200);
    assert.equal((await post('gate', { leaseId: lease.id, action: 'open-pr', resources: ['auth/session'] })).data.code, 'ALLOW');

    // Session guard: a live process under the lease.
    const guardOutput = [];
    guard = spawn(process.execPath, ['bin/guarded-session.js', lease.id, '--', process.execPath, '-e', 'setInterval(() => {}, 1000)'], { cwd, env: { ...process.env, AIRLOCK_URL: base, AIRLOCK_POLL_MS: '100' }, stdio: ['ignore', 'ignore', 'pipe'] });
    guard.stderr.on('data', chunk => guardOutput.push(chunk.toString()));
    assert.equal(await waitFor(() => guardOutput.join('').includes('started pid')), true, guardOutput.join(''));
    const childPid = Number(guardOutput.join('').match(/started pid (\d+)/)[1]);
    const stateOf = pid => execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();

    await post('decisions', { issueId: 'SEC-21', body: 'Refresh tokens must never be persisted. Use session cookies.' });
    const stale = (await post('gate', { leaseId: lease.id, action: 'open-pr', resources: ['auth/session'] })).data;
    assert.equal(stale.code, 'STALE_CONTEXT');
    assert.equal(stale.checks.length, 5);
    assert.equal(await waitFor(() => guardOutput.join('').includes('PAUSED')), true, guardOutput.join(''));
    assert.equal(await waitFor(() => stateOf(childPid).startsWith('T')), true, 'child process is stopped');

    const deniedCommand = spawnSync(process.execPath, ['bin/guarded-action.js', lease.id, 'open-pr', 'auth/session', '--', process.execPath, '-e', "process.stdout.write('EXECUTED')"], { cwd, env: { ...process.env, AIRLOCK_URL: base }, encoding: 'utf8' });
    assert.equal(deniedCommand.status, 1);
    assert.equal(deniedCommand.stdout.includes('EXECUTED'), false);
    assert.equal((await post('leases/replan', { leaseId: lease.id })).status, 400);

    await post('issues/revise', { issueId: 'AIR-103', description: 'Store refresh tokens in Postgres, encrypted at rest.' });
    const contradictory = (await post('leases/replan', { leaseId: lease.id })).data;
    assert.equal(contradictory.revision, 2);
    assert.equal(contradictory.consistency.status, 'contradiction');
    assert.equal((await post('gate', { leaseId: lease.id, action: 'open-pr', resources: ['auth/session'] })).data.code, 'INCONSISTENT_CONTEXT');
    await sleep(250);
    assert.equal(stateOf(childPid).startsWith('T'), true, 'contradictory re-plan keeps the session paused');

    await post('issues/revise', { issueId: 'AIR-103', description: 'Use session cookies. Do not persist refresh tokens.' });
    const renewed = (await post('leases/replan', { leaseId: lease.id })).data;
    assert.equal(renewed.id, lease.id);
    assert.equal(renewed.revision, 3);
    assert.equal((await post('gate', { leaseId: lease.id, action: 'open-pr', resources: ['auth/session'] })).data.code, 'ALLOW');
    assert.equal(await waitFor(() => guardOutput.join('').includes('RESUMED under rev 3')), true, guardOutput.join(''));
    assert.equal(await waitFor(() => !stateOf(childPid).startsWith('T')), true, 'child process resumed');
    const allowedCommand = spawnSync(process.execPath, ['bin/guarded-action.js', lease.id, 'open-pr', 'auth/session', '--', process.execPath, '-e', "process.stdout.write('EXECUTED')"], { cwd, env: { ...process.env, AIRLOCK_URL: base }, encoding: 'utf8' });
    assert.equal(allowedCommand.status, 0);
    assert.match(allowedCommand.stdout, /EXECUTED/);
    await post('leases/release', { leaseId: lease.id });
    assert.equal(await waitFor(() => guardOutput.join('').includes('lease released')), true);

    const audit = await (await fetch(base + '/api/audit')).json();
    assert.ok(audit.audit.length >= 5);
    assert.ok(audit.audit.every(a => a.revision && a.context.facts.length));

    await post('reset', { scenario: 'collision' });
    const reader = (await post('leases', { issueId: 'AIR-202', agent: 'Codex A', readSet: ['auth/api-contract', 'auth/session-schema'], writeSet: ['frontend/auth'] })).data;
    const writer = (await post('leases', { issueId: 'AIR-201', agent: 'Codex B', readSet: ['auth/requirements'], writeSet: ['auth/api-contract'], allowedActions: ['edit-files', 'open-pr', 'change-api-contract'] })).data;
    assert.equal((await post('gate', { leaseId: writer.id, action: 'change-api-contract', resources: ['auth/api-contract'] })).data.code, 'AGENT_COLLISION');
    await post('leases/release', { leaseId: reader.id });
    assert.equal((await post('gate', { leaseId: writer.id, action: 'change-api-contract', resources: ['auth/api-contract'] })).data.code, 'ALLOW');
  } finally {
    guard?.kill('SIGKILL');
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
