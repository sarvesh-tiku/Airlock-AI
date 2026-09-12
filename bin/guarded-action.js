#!/usr/bin/env node
// Fail closed: run a command only if Airlock authorizes the action immediately beforehand.
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (separator < 3 || separator === args.length - 1) {
  console.error('Usage: node bin/guarded-action.js LEASE_ID ACTION RESOURCE [RESOURCE ...] -- COMMAND [ARG ...]');
  process.exit(2);
}
const [leaseId, action, ...resources] = args.slice(0, separator);
const [command, ...commandArgs] = args.slice(separator + 1);
try {
  const response = await fetch(`${process.env.AIRLOCK_URL || 'http://127.0.0.1:3000'}/api/gate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leaseId, action, resources })
  });
  const decision = await response.json();
  if (!response.ok || !decision.allowed) {
    console.error(`Airlock denied ${action}: ${decision.reason || decision.error}`);
    process.exit(1);
  }
  console.log(`Airlock authorized ${action} for ${decision.issueId}.`);
  const child = spawn(command, commandArgs, { stdio: 'inherit', shell: false });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
} catch (error) {
  console.error(`Airlock unavailable; command blocked: ${error.message}`);
  process.exit(1);
}
