#!/usr/bin/env node
// Run a long-lived agent process under a context lease. Airlock is polled at a
// safety cadence; when the lease is invalidated the process is stopped with
// SIGSTOP, and when the lease is re-planned it resumes with SIGCONT. A released
// lease or an unreachable Airlock terminates the process (fail closed).
//
//   node bin/guarded-session.js LEASE_ID -- codex exec "implement AIR-103"
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (separator !== 1 || separator === args.length - 1) {
  console.error('Usage: node bin/guarded-session.js LEASE_ID -- COMMAND [ARG ...]');
  process.exit(2);
}
const leaseId = args[0];
const [command, ...commandArgs] = args.slice(separator + 1);
const base = process.env.AIRLOCK_URL || 'http://127.0.0.1:3000';
const interval = Number(process.env.AIRLOCK_POLL_MS || 2000);
const log = message => console.error(`[airlock] ${message}`);

async function fetchLease() {
  const response = await fetch(`${base}/api/leases/${leaseId}`, { signal: AbortSignal.timeout(Math.max(1000, interval)) });
  if (!response.ok) throw new Error(`lease lookup ${response.status}`);
  return response.json();
}

let lease;
try { lease = await fetchLease(); } catch (error) { log(`cannot verify lease before start; refusing to run: ${error.message}`); process.exit(1); }
if (lease.status !== 'active') { log(`lease is ${lease.status}; refusing to start ${command}`); process.exit(1); }
if (lease.consistency?.status === 'contradiction') { log(`lease context is contradictory: ${lease.consistency.findings[0]?.explanation}; refusing to start`); process.exit(1); }

const child = spawn(command, commandArgs, { stdio: 'inherit', shell: false });
const commandLine = [command, ...commandArgs].join(' ');
// Best-effort heartbeat so the dashboard can show this process; never affects enforcement.
const report = state => fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leaseId, pid: child.pid, command: commandLine, state }), signal: AbortSignal.timeout(1500) }).catch(() => {});
let paused = false;
let failures = 0;
let revision = lease.revision;
log(`session for ${lease.agent} on ${lease.issueId} (rev ${revision}) started pid ${child.pid}; polling every ${interval}ms`);
report('running');

const timer = setInterval(async () => {
  try {
    const current = await fetchLease();
    failures = 0;
    if (current.status === 'released') { log('lease released; terminating session'); child.kill('SIGTERM'); return; }
    report(paused ? 'paused' : 'running');
    if (current.status === 'invalid' && !paused) {
      paused = true; child.kill('SIGSTOP'); report('paused');
      log(`PAUSED: context changed (${current.changedSources.join(', ')}). ${current.drift?.[0]?.explanation || 'Re-plan before continuing.'}`);
    } else if (current.status === 'active' && paused && current.revision > Math.abs(revision)) {
      if (current.consistency?.status === 'contradiction') {
        if (revision !== -current.revision) { revision = -current.revision; log(`still paused: rev ${current.revision} contradicts a constraint (${current.consistency.findings[0]?.explanation})`); }
        return;
      }
      paused = false; revision = current.revision; child.kill('SIGCONT'); report('running');
      log(`RESUMED under rev ${revision}. Re-read the task before acting.`);
    }
  } catch (error) {
    failures += 1;
    if (failures >= 3) { log(`Airlock unreachable (${error.message}); terminating session`); child.kill('SIGTERM'); }
  }
}, interval);

child.on('error', error => { log(error.message); clearInterval(timer); process.exitCode = 1; });
child.on('exit', (code, signal) => { clearInterval(timer); process.exitCode = signal ? 1 : code ?? 1; report('exited'); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(sig); });
