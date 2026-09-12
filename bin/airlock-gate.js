#!/usr/bin/env node
// A coding agent invokes this immediately before an action it wants Airlock to authorize.
const [leaseId, action, ...resources] = process.argv.slice(2);
if (!leaseId || !action) {
  console.error('Usage: node bin/airlock-gate.js LEASE_ID ACTION [RESOURCE ...]');
  process.exit(2);
}
try {
  const response = await fetch(`${process.env.AIRLOCK_URL || 'http://127.0.0.1:3000'}/api/gate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leaseId, action, resources })
  });
  const decision = await response.json();
  if (!response.ok || !decision.allowed) {
    console.error(JSON.stringify(decision, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(decision, null, 2));
} catch (error) {
  console.error(`Airlock unavailable; action denied: ${error.message}`);
  process.exit(1);
}
