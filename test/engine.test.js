import test from 'node:test';
import assert from 'node:assert/strict';
import { demoState, createLease, addDecision, reviseIssue, gate, replanLease, releaseLease, sourceVersion, heuristicConsistency, invariantReport } from '../src/engine.js';

test('a decision on a constraint issue invalidates the child lease; re-plan needs a revised task and keeps the lease id', () => {
  const state = demoState();
  const lease = createLease(state, { issueId: 'AIR-103', agent: 'Codex', readSet: ['auth/session'], writeSet: ['auth/session', 'database/tokens'] });
  assert.deepEqual(Object.keys(lease.watches).sort(), ['AIR-100', 'AIR-103', 'AIR-138', 'SEC-21']);
  assert.deepEqual(lease.facts.map(f => f.kind), ['requirement', 'constraint', 'constraint', 'constraint', 'dependency', 'authority']);
  assert.equal(gate(state, { leaseId: lease.id, action: 'open-pr', resources: ['auth/session'] }).allowed, true);
  addDecision(state, 'SEC-21', 'Refresh tokens must never be persisted. Use session cookies.');
  assert.equal(lease.status, 'invalid');
  assert.deepEqual(lease.changedSources, ['SEC-21']);
  assert.equal(lease.changedFacts.length, 1);
  assert.equal(lease.changedFacts[0].type, 'added');
  assert.equal(lease.drift.length, 1, 'drift explanation names the new contradiction');
  const denied = gate(state, { leaseId: lease.id, action: 'open-pr', resources: ['auth/session'] });
  assert.equal(denied.code, 'STALE_CONTEXT');
  assert.equal(denied.invariant, 'I1');
  assert.equal(denied.checks.find(c => c.name === 'freshness').ok, false);
  assert.throws(() => replanLease(state, lease.id), /Revise the agent task/);
  reviseIssue(state, 'AIR-103', 'Use session cookies; do not persist refresh tokens.');
  const renewed = replanLease(state, lease.id);
  assert.equal(renewed.id, lease.id);
  assert.equal(renewed.revision, 2);
  assert.equal(renewed.history.length, 1);
  assert.equal(gate(state, { leaseId: renewed.id, action: 'open-pr', resources: ['auth/session'] }).allowed, true);
});

test('a revision that still contradicts the constraint is issued but denied at the gate', () => {
  const state = demoState();
  const lease = createLease(state, { issueId: 'AIR-103', agent: 'Codex', readSet: [], writeSet: ['auth/session'] });
  addDecision(state, 'SEC-21', 'Refresh tokens must never be persisted.');
  reviseIssue(state, 'AIR-103', 'Store refresh tokens in Postgres, encrypted at rest.');
  replanLease(state, lease.id);
  assert.equal(lease.consistency.status, 'contradiction');
  assert.equal(lease.consistency.findings[0].method, 'heuristic');
  const result = gate(state, { leaseId: lease.id, action: 'open-pr', resources: ['auth/session'] });
  assert.equal(result.code, 'INCONSISTENT_CONTEXT');
  assert.equal(result.checks.find(c => c.name === 'freshness').ok, true);
  assert.equal(heuristicConsistency(lease.facts).length, 1);
});

test('a constraint change propagates to every dependent active lease, including via a dependency link', () => {
  const state = demoState();
  const a = createLease(state, { issueId: 'AIR-103', agent: 'Codex', readSet: [], writeSet: ['auth/session'] });
  const b = createLease(state, { issueId: 'AIR-104', agent: 'Codex UI', readSet: [], writeSet: ['frontend/login'] });
  addDecision(state, 'SEC-21', 'Never persist refresh tokens.');
  assert.equal(a.status, 'invalid');
  assert.equal(b.status, 'active', 'AIR-104 does not watch SEC-21');
  addDecision(state, 'AIR-138', 'Contract now returns { user_id, session }.', 'Backend lead');
  assert.equal(b.status, 'invalid');
  assert.deepEqual(b.changedSources, ['AIR-138']);
  assert.ok(state.events.some(e => e.code === 'PROPAGATION' && e.message.includes('Codex UI/AIR-104')));
  assert.equal(invariantReport(state).find(i => i.id === 'I3').enforced, 2);
});

test('a write/read collision blocks a contract change until the reader releases its lease', () => {
  const state = demoState('collision');
  const reader = createLease(state, { issueId: 'AIR-202', agent: 'Codex A', readSet: ['auth/api-contract', 'auth/session-schema'], writeSet: ['frontend/auth'] });
  const writer = createLease(state, { issueId: 'AIR-201', agent: 'Codex B', readSet: ['auth/requirements'], writeSet: ['auth/api-contract'], allowedActions: ['edit-files', 'open-pr', 'change-api-contract'] });
  const result = gate(state, { leaseId: writer.id, action: 'change-api-contract', resources: ['auth/api-contract'] });
  assert.equal(result.code, 'AGENT_COLLISION');
  assert.equal(result.invariant, 'I4');
  assert.match(result.reason, /write set intersects Codex A's read set/);
  releaseLease(state, reader.id);
  assert.equal(gate(state, { leaseId: writer.id, action: 'change-api-contract', resources: ['auth/api-contract'] }).allowed, true);
});

test('authority: unlisted or denied actions and out-of-scope paths are refused; globs are honored', () => {
  const state = demoState();
  const lease = createLease(state, { issueId: 'AIR-103', agent: 'Codex', writeSet: ['auth/**'], readSet: [] });
  assert.equal(gate(state, { leaseId: lease.id, action: 'merge', resources: [] }).code, 'OUT_OF_SCOPE');
  assert.equal(gate(state, { leaseId: lease.id, action: 'close-issue', resources: [] }).code, 'OUT_OF_SCOPE');
  assert.equal(gate(state, { leaseId: lease.id, action: 'edit-files', resources: ['billing/schema'] }).code, 'OUT_OF_SCOPE');
  assert.equal(gate(state, { leaseId: lease.id, action: 'edit-files', resources: ['auth/session/store.ts'] }).code, 'ALLOW');
  const issue = state.issues[0];
  issue.comments.push({ id: 'c-later', body: 'Other decision', author: 'PM', at: '2026-09-12T11:00:00Z' });
  const hash = sourceVersion(issue);
  issue.comments.reverse();
  assert.equal(sourceVersion(issue), hash);
});

test('provenance: an unattributed fact is tolerated for light actions and blocks consequential ones', () => {
  const state = demoState();
  state.issues.find(i => i.id === 'AIR-100').comments.push({ id: 'c-anon', body: 'Undocumented note', author: 'Unknown', at: null });
  const lease = createLease(state, { issueId: 'AIR-103', agent: 'Codex', readSet: [], writeSet: ['auth/session'] });
  assert.equal(lease.facts.find(f => f.id === 'constraint:AIR-100:c-anon').confidence, 0.4);
  assert.equal(gate(state, { leaseId: lease.id, action: 'edit-files', resources: ['auth/session'] }).code, 'ALLOW');
  const result = gate(state, { leaseId: lease.id, action: 'open-pr', resources: ['auth/session'] });
  assert.equal(result.code, 'WEAK_PROVENANCE');
  assert.equal(result.invariant, 'I5');
  assert.equal(state.audit.length, 2);
  assert.equal(state.audit[0].context.facts.length, lease.facts.length, 'audit records every fact version behind the decision');
});

test('consistency: a neutral parent description without directive language is not treated as a contradicting constraint', () => {
  const state = demoState();
  state.issues.find(i => i.id === 'AIR-100').comments = [];
  state.issues.find(i => i.id === 'AIR-103').description = 'Implement session-cookie authentication. Do not persist refresh tokens. Touch auth/session.';
  const lease = createLease(state, { issueId: 'AIR-103', agent: 'Codex', readSet: [], writeSet: ['auth/session'] });
  assert.equal(lease.consistency.status, 'consistent');
  addDecision(state, 'AIR-100', 'Decision: session storage must never use refresh tokens; persist nothing.');
  reviseIssue(state, 'AIR-103', 'Persist refresh tokens for session storage.');
  replanLease(state, lease.id);
  assert.equal(lease.consistency.status, 'contradiction', 'a directive comment still counts');
});
