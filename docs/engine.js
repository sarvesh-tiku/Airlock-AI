import { createHash, randomUUID } from './crypto-shim.js';

// ---------------------------------------------------------------------------
// Airlock engine: context leases, four integrity checks, five invariants.
// Everything here is deterministic. Model output (src/semantic.js) can only
// add findings; it can never turn a denial into an allow.
// ---------------------------------------------------------------------------

const now = () => new Date().toISOString();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
const normPath = p => String(p).trim().replace(/\/?\*\*$/, '').replace(/\/+$/, '');
const overlaps = (a, b) => a.some(x => b.some(y => { const i = normPath(x), o = normPath(y); return i === o || i.startsWith(o + '/') || o.startsWith(i + '/'); }));

export const CONSEQUENTIAL_ACTIONS = ['open-pr', 'merge', 'deploy', 'modify-schema', 'change-api-contract', 'close-issue'];
export const LIGHT_ACTIONS = ['edit-files', 'run-tests', 'read'];
export const DEFAULT_ALLOWED = ['edit-files', 'run-tests', 'open-pr'];
export const DEFAULT_DENIED = ['merge', 'deploy'];
export const WEAK_CONFIDENCE = 0.6;

export const INVARIANTS = [
  { id: 'I1', title: 'No agent executes using invalidated or contradictory context.', codes: ['STALE_CONTEXT', 'INCONSISTENT_CONTEXT'] },
  { id: 'I2', title: 'No agent silently exceeds its delegated authority.', codes: ['OUT_OF_SCOPE'] },
  { id: 'I3', title: 'A human constraint propagates to every dependent active agent.', codes: ['PROPAGATION'] },
  { id: 'I4', title: 'Conflicting reads and writes cannot proceed unnoticed.', codes: ['AGENT_COLLISION'] },
  { id: 'I5', title: 'Every consequential action is traceable to the context that authorized it.', codes: ['WEAK_PROVENANCE'] }
];

const t0 = '2026-09-12T11:30:00.000Z';

export function demoState(scenario = 'drift') {
  const issues = scenario === 'collision' ? [
    { id: 'AIR-200', title: 'Move auth to session cookies', description: 'Parent rollout for the new session API.', parentId: null, creator: 'PM', updatedAt: t0, relations: [], comments: [] },
    { id: 'AIR-205', title: 'Session API contract', description: 'POST /auth/session returns { user_id, token }. Consumers treat token as opaque.', parentId: 'AIR-200', creator: 'Backend lead', updatedAt: t0, relations: [], comments: [] },
    { id: 'AIR-201', title: 'Change the session contract', description: 'Change the session API to return { user_id, session } instead of token. Write auth/api-contract.', parentId: 'AIR-200', creator: 'Backend lead', updatedAt: t0, relations: [], comments: [] },
    { id: 'AIR-202', title: 'Wire login UI to the session API', description: 'Consume the session API contract in frontend/auth. Reads auth/api-contract and auth/session-schema.', parentId: 'AIR-200', creator: 'Frontend lead', updatedAt: t0, relations: [{ type: 'dependsOn', issueId: 'AIR-205' }], comments: [] }
  ] : [
    { id: 'AIR-100', title: 'Enterprise SSO rollout', description: 'Project decision thread for authentication and session storage.', parentId: null, creator: 'PM', updatedAt: t0, relations: [], comments: [{ id: 'c-initial', body: 'Decision: ship SSO behind a feature flag. Auth work lands in the auth tree.', author: 'PM', at: t0 }] },
    { id: 'SEC-21', title: 'Security policy: token storage', description: 'Refresh tokens may be persisted only when encrypted at rest with the KMS-managed key.', parentId: null, creator: 'Security', updatedAt: t0, relations: [], comments: [] },
    { id: 'AIR-138', title: 'Session API contract', description: 'POST /auth/session returns { user_id, token }. Consumers treat token as opaque.', parentId: 'AIR-100', creator: 'Backend lead', updatedAt: t0, relations: [], comments: [] },
    { id: 'AIR-103', title: 'Persist OAuth refresh tokens', description: 'Store OAuth refresh tokens in Postgres so users remain signed in. Touch auth/session and database/tokens.', parentId: 'AIR-100', creator: 'PM', updatedAt: t0, relations: [{ type: 'constrainedBy', issueId: 'SEC-21' }, { type: 'dependsOn', issueId: 'AIR-138' }], comments: [] },
    { id: 'AIR-104', title: 'Build enterprise login UI', description: 'Use the session API from AIR-138 for the login UI. Touch frontend/login.', parentId: 'AIR-100', creator: 'PM', updatedAt: t0, relations: [{ type: 'dependsOn', issueId: 'AIR-138' }], comments: [] }
  ];
  return { mode: 'demo', scenario, issues, leases: [], audit: [], sessions: {}, events: [{ id: randomUUID(), at: now(), kind: 'info', message: `Loaded ${scenario === 'collision' ? 'agent collision' : 'requirement drift'} sample workspace.` }], lastCheck: null };
}

const find = (state, id) => state.issues.find(i => i.id === id);

export function sourceVersion(issue) {
  return digest({
    id: issue.id, title: issue.title, description: issue.description, parentId: issue.parentId,
    relations: [...(issue.relations || [])].sort((a, b) => (a.issueId + a.type).localeCompare(b.issueId + b.type)),
    comments: issue.comments.map(c => ({ id: c.id, body: c.body, at: c.at })).sort((a, b) => a.id.localeCompare(b.id))
  });
}

function event(state, kind, message, extra = {}) {
  state.events.unshift({ id: randomUUID(), at: now(), kind, message, ...extra });
  state.events = state.events.slice(0, 80);
}

// ----- Facts and provenance -------------------------------------------------

function confidence(author, at, field) {
  if (!author || /unknown/i.test(author)) return 0.4;
  if (!at) return 0.5;
  return field === 'description' ? 1 : 0.9;
}

function fact(kind, issue, field, text, extra = {}) {
  const author = extra.author ?? issue.creator ?? null;
  const at = extra.at ?? issue.updatedAt ?? null;
  return {
    id: `${kind}:${issue.id}:${extra.commentId || field}`, kind, text: String(text || '').trim(),
    source: { issueId: issue.id, field, commentId: extra.commentId || null, url: issue.url || null },
    author, at, version: digest(String(text || '').trim()), confidence: confidence(author, at, field)
  };
}

export function extractFacts(state, issueId, envelope) {
  const target = find(state, issueId);
  if (!target) throw new Error(`Issue ${issueId} does not exist`);
  const facts = [];
  const withComments = (kind, issue) => {
    facts.push(fact(kind, issue, 'description', issue.description));
    for (const c of issue.comments) facts.push(fact(kind, issue, 'comment', c.body, { commentId: c.id, author: c.author, at: c.at }));
  };
  withComments('requirement', target);
  const relations = target.relations || [];
  const constraintIssues = [target.parentId && find(state, target.parentId), ...relations.filter(r => r.type !== 'dependsOn').map(r => find(state, r.issueId))].filter(Boolean);
  for (const issue of constraintIssues) withComments('constraint', issue);
  for (const r of relations.filter(r => r.type === 'dependsOn')) { const issue = find(state, r.issueId); if (issue) withComments('dependency', issue); }
  facts.push({
    id: 'authority:operator:envelope', kind: 'authority',
    text: `May ${envelope.allowedActions.join(', ')}. May NOT ${envelope.deniedActions.join(', ') || 'anything beyond the allowed list'}. Write ${envelope.writeSet.join(', ') || '(nothing)'}. Read ${envelope.readSet.join(', ') || '(nothing)'}.`,
    source: { issueId: null, field: 'operator', commentId: null, url: null }, author: envelope.operator || 'Operator', at: now(),
    version: digest({ r: envelope.readSet, w: envelope.writeSet, a: envelope.allowedActions, d: envelope.deniedActions }), confidence: 1
  });
  return facts;
}

export function watchedIssues(state, issueId) {
  return [...new Set(extractFacts(state, issueId, { allowedActions: [], deniedActions: [], writeSet: [], readSet: [] }).map(f => f.source.issueId).filter(Boolean))];
}

// ----- Consistency ----------------------------------------------------------

const NEGATION = /\b(never|must not|mustn't|may not|do not|don't|cannot|can't|no longer|not|prohibited|forbidden|disallowed|forbid|banned?)\b/i;
const STOP = new Set(['the', 'that', 'this', 'with', 'from', 'only', 'when', 'they', 'them', 'their', 'have', 'been', 'will', 'shall', 'must', 'should', 'into', 'onto', 'uses', 'used', 'using', 'through', 'after', 'before', 'while', 'about', 'which', 'where', 'what', 'then', 'than', 'also', 'same', 'each', 'every', 'there', 'these', 'those', 'your', 'over', 'under', 'more', 'less', 'some', 'never', 'cannot', 'decision', 'touch', 'implement', 'review', 'complete']);
const tokens = text => new Set(String(text).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter(w => w.length >= 4 && !STOP.has(w)).map(w => w.slice(0, 5)));
const clip = text => text.length > 90 ? text.slice(0, 87) + '…' : text;

// The newest statement on a constraint source is treated as its current decision.
function currentConstraints(facts) {
  const bySource = new Map();
  for (const f of facts.filter(f => f.kind === 'constraint')) {
    const current = bySource.get(f.source.issueId);
    const isComment = f.source.field === 'comment';
    if (!current || (isComment && (current.source.field !== 'comment' || (f.at || '') >= (current.at || '')))) bySource.set(f.source.issueId, f);
  }
  return [...bySource.values()];
}

// A constraint only counts when it actually directs behavior; a neutral thread
// description ("Project decision thread for authentication…") is not a rule.
const MANDATE = /\b(must|always|required?|shall|should)\b/i;
const DIRECTIVE = /\b(must|never|should|may|only|do not|don't|cannot|can't|required?|always|prohibited|forbidden|allowed|disallowed|no longer|shall)\b/i;

export function heuristicConsistency(facts) {
  const findings = [];
  for (const req of facts.filter(f => f.kind === 'requirement')) {
    for (const con of currentConstraints(facts).filter(c => DIRECTIVE.test(c.text))) {
      const a = tokens(req.text), b = tokens(con.text);
      const shared = [...a].filter(x => b.has(x));
      if (shared.length < 2) continue;
      // A prohibition ("must never") clashes with an affirmative requirement; a mandate
      // ("must", "required") clashes with a negated one; a permission ("may … only when")
      // is not contradicted by a requirement that simply declines to use it.
      const conProhibits = NEGATION.test(con.text);
      const conMandates = !conProhibits && MANDATE.test(con.text);
      const reqNegated = NEGATION.test(req.text);
      if ((conProhibits && !reqNegated) || (conMandates && reqNegated)) {
        findings.push({ a: req.id, b: con.id, method: 'heuristic', shared, explanation: `${req.source.issueId} says "${clip(req.text)}" but ${con.source.issueId} says "${clip(con.text)}".` });
      }
    }
  }
  return findings;
}

export function assessLeaseConsistency(lease, modelFindings = null) {
  const heuristic = heuristicConsistency(lease.facts);
  const model = (modelFindings || []).map(f => ({ ...f, method: 'model' }));
  const findings = [...heuristic, ...model];
  lease.consistency = { status: findings.length ? 'contradiction' : 'consistent', findings, checkedAt: now(), methods: ['heuristic', ...(modelFindings ? ['model'] : [])] };
  return lease.consistency;
}

// ----- Leases ---------------------------------------------------------------

function envelopeOf({ readSet = [], writeSet = [], allowedActions = DEFAULT_ALLOWED, deniedActions = DEFAULT_DENIED, operator }) {
  if (!Array.isArray(readSet) || !Array.isArray(writeSet) || !Array.isArray(allowedActions) || !Array.isArray(deniedActions)) throw new Error('Read/write sets and action lists must be arrays');
  const denied = deniedActions.filter(a => !allowedActions.includes(a));
  return { readSet: readSet.map(normPath), writeSet: writeSet.map(normPath), allowedActions, deniedActions: denied, operator: operator || 'Operator' };
}

function snapshot(state, issueId, envelope) {
  const facts = extractFacts(state, issueId, envelope);
  const watches = Object.fromEntries([...new Set(facts.map(f => f.source.issueId).filter(Boolean))].map(id => [id, sourceVersion(find(state, id))]));
  return { facts, watches };
}

export function createLease(state, body) {
  const { issueId, agent } = body;
  if (!agent) throw new Error('Agent name is required');
  if (state.leases.some(l => l.issueId === issueId && l.agent === agent && l.status === 'active')) throw new Error('An active lease already exists for this agent and issue');
  const envelope = envelopeOf(body);
  const { facts, watches } = snapshot(state, issueId, envelope);
  const lease = {
    id: randomUUID(), issueId, agent, status: 'active', issuedAt: now(), revision: 1, ...envelope, facts, watches,
    targetDescription: find(state, issueId).description, changedSources: [], changedFacts: [], history: []
  };
  assessLeaseConsistency(lease);
  state.leases.push(lease);
  event(state, 'lease', `${agent} leased ${issueId} (rev 1) watching ${Object.keys(watches).join(' + ')}: ${facts.length} facts.`);
  if (lease.consistency.status === 'contradiction') event(state, 'blocked', `${agent}'s ${issueId} context is internally contradictory: ${lease.consistency.findings[0].explanation}`);
  return lease;
}

export function addDecision(state, issueId, body, author = 'Security') {
  const issue = find(state, issueId);
  if (!issue || !body?.trim()) throw new Error('A valid source issue and nonempty decision are required');
  const comment = { id: randomUUID(), body: body.trim(), author, at: now() };
  issue.comments.push(comment);
  event(state, 'decision', `${author} changed context on ${issueId}: ${comment.body}`);
  invalidateChangedLeases(state, `${author} on ${issueId}`);
  return comment;
}

export function replaceIssues(state, issues) {
  let changed = false;
  for (const incoming of issues) {
    const index = state.issues.findIndex(i => i.id === incoming.id);
    if (index >= 0) { if (sourceVersion(state.issues[index]) !== sourceVersion(incoming)) changed = true; state.issues[index] = incoming; }
    else { state.issues.push(incoming); changed = true; }
  }
  if (changed) invalidateChangedLeases(state, 'Linear sync');
  return changed;
}

export function reviseIssue(state, issueId, description) {
  const issue = find(state, issueId);
  if (!issue || !description?.trim()) throw new Error('A valid issue and revised description are required');
  issue.description = description.trim();
  issue.updatedAt = now();
  event(state, 'decision', `${issueId} was revised: ${clip(issue.description)}`);
  invalidateChangedLeases(state, `revision of ${issueId}`);
  return issue;
}

function diffFacts(before, after) {
  const prev = new Map(before.map(f => [f.id, f]));
  const next = new Map(after.map(f => [f.id, f]));
  const changes = [];
  for (const f of after) {
    if (f.kind === 'authority') continue;
    const old = prev.get(f.id);
    if (!old) changes.push({ type: 'added', id: f.id, kind: f.kind, source: f.source.issueId, author: f.author, at: f.at, text: f.text });
    else if (old.version !== f.version) changes.push({ type: 'modified', id: f.id, kind: f.kind, source: f.source.issueId, author: f.author, at: f.at, before: old.text, text: f.text });
  }
  for (const f of before) if (!next.has(f.id) && f.kind !== 'authority') changes.push({ type: 'removed', id: f.id, kind: f.kind, source: f.source.issueId, before: f.text });
  return changes;
}

export function invalidateChangedLeases(state, cause = 'a source change') {
  const hit = [];
  for (const lease of state.leases.filter(l => l.status === 'active')) {
    const changed = Object.entries(lease.watches).filter(([id, version]) => { const issue = find(state, id); return !issue || sourceVersion(issue) !== version; }).map(([id]) => id);
    if (!changed.length) continue;
    lease.status = 'invalid';
    lease.invalidatedAt = now();
    lease.changedSources = changed;
    try {
      const fresh = extractFacts(state, lease.issueId, lease);
      lease.changedFacts = diffFacts(lease.facts, fresh);
      // What the stale requirement now collides with, if anything.
      lease.drift = heuristicConsistency([...lease.facts.filter(f => f.kind === 'requirement'), ...fresh.filter(f => f.kind === 'constraint')]);
    } catch { lease.changedFacts = []; lease.drift = []; }
    hit.push(lease);
  }
  if (hit.length) {
    event(state, 'blocked', `${cause} propagated to ${hit.length} active lease${hit.length === 1 ? '' : 's'}: ${hit.map(l => `${l.agent}/${l.issueId}`).join(', ')}. Each is paused pending re-plan.`, { code: 'PROPAGATION', invariant: 'I3' });
  }
  return hit;
}

export function releaseLease(state, leaseId) {
  const lease = state.leases.find(l => l.id === leaseId);
  if (!lease) throw new Error('Unknown lease');
  lease.status = 'released';
  lease.releasedAt = now();
  event(state, 'lease', `${lease.agent} released ${lease.issueId}.`);
  return lease;
}

// Re-plan keeps the lease id stable and bumps the revision so wrappers can
// keep polling one identifier. The previous snapshot goes into history.
export function replanLease(state, leaseId) {
  const lease = state.leases.find(l => l.id === leaseId);
  if (!lease) throw new Error('Unknown lease');
  if (lease.status !== 'invalid') throw new Error('Only an invalidated lease needs re-planning');
  const target = find(state, lease.issueId);
  if (!target || target.description === lease.targetDescription) throw new Error('Revise the agent task against the new decision before issuing a fresh lease');
  lease.history.push({ revision: lease.revision, issuedAt: lease.issuedAt, invalidatedAt: lease.invalidatedAt, changedSources: lease.changedSources, watches: lease.watches, targetDescription: lease.targetDescription });
  const { facts, watches } = snapshot(state, lease.issueId, lease);
  Object.assign(lease, { status: 'active', issuedAt: now(), revision: lease.revision + 1, facts, watches, targetDescription: target.description, changedSources: [], changedFacts: [], drift: [], invalidatedAt: null });
  assessLeaseConsistency(lease);
  event(state, 'lease', `${lease.agent} reviewed updated context and re-planned ${lease.issueId} (rev ${lease.revision}).`);
  if (lease.consistency.status === 'contradiction') event(state, 'blocked', `${lease.agent}'s revised ${lease.issueId} still contradicts a constraint: ${lease.consistency.findings[0].explanation}`);
  return lease;
}

// ----- The gate -------------------------------------------------------------

export function gate(state, { leaseId, action, resources = [] }) {
  invalidateChangedLeases(state, 'a source change');
  const lease = state.leases.find(l => l.id === leaseId);
  if (!lease) throw new Error('Unknown lease');
  if (!action || !Array.isArray(resources)) throw new Error('Action and resources are required');
  const tier = CONSEQUENTIAL_ACTIONS.includes(action) ? 'consequential' : 'light';
  const checks = [];

  // 1. Freshness: expected_version == current_version for every watched source.
  if (lease.status === 'released') checks.push({ name: 'freshness', ok: false, code: 'STALE_CONTEXT', detail: 'Lease was released; no context authorizes this agent.' });
  else if (lease.status === 'invalid') {
    const latest = lease.changedFacts.filter(c => c.at).sort((a, b) => b.at.localeCompare(a.at))[0];
    checks.push({ name: 'freshness', ok: false, code: 'STALE_CONTEXT', detail: `Changed source: ${lease.changedSources.join(', ')}. Planned at ${lease.issuedAt}; ${latest ? `${latest.source} changed at ${latest.at} by ${latest.author}` : 'source changed after planning'}. Review the new decision and re-plan.` });
  } else checks.push({ name: 'freshness', ok: true, detail: `${Object.keys(lease.watches).length} watched sources match the rev ${lease.revision} snapshot.` });

  // 2. Consistency: active constraints must not contradict the requirement.
  const consistency = assessLeaseConsistency(lease, lease.consistency?.methods?.includes('model') ? lease.consistency.findings.filter(f => f.method === 'model') : null);
  checks.push(consistency.status === 'consistent'
    ? { name: 'consistency', ok: true, detail: `No contradiction among ${lease.facts.filter(f => f.kind !== 'authority').length} facts (${consistency.methods.join(' + ')}).` }
    : { name: 'consistency', ok: false, code: 'INCONSISTENT_CONTEXT', detail: consistency.findings[0].explanation });

  // 3. Provenance: every fact has a source, author, timestamp, and version.
  const weak = lease.facts.filter(f => f.confidence < WEAK_CONFIDENCE);
  checks.push(weak.length
    ? { name: 'provenance', ok: tier === 'light', code: 'WEAK_PROVENANCE', detail: `${weak.length} fact${weak.length === 1 ? '' : 's'} lack author or timestamp (${weak.map(f => f.id).join(', ')}). ${tier === 'light' ? 'Tolerated for a light action.' : 'A consequential action needs fully attributed context.'}` }
    : { name: 'provenance', ok: true, detail: `${lease.facts.length} facts carry source, author, timestamp, and version.` });

  // 4. Authority: action and resources inside the delegated envelope.
  const scope = ['read', 'run-tests'].includes(action) ? [...lease.readSet, ...lease.writeSet] : lease.writeSet;
  const actionAllowed = lease.allowedActions.includes(action) && !lease.deniedActions.includes(action);
  const resourcesAllowed = resources.every(r => overlaps([r], scope));
  checks.push(actionAllowed && resourcesAllowed
    ? { name: 'authority', ok: true, detail: `${action} on ${resources.join(', ') || '(no resources)'} is inside the envelope.` }
    : { name: 'authority', ok: false, code: 'OUT_OF_SCOPE', detail: !actionAllowed ? `${lease.agent} may not ${action}. Envelope: ${lease.allowedActions.join(', ')}; denied: ${lease.deniedActions.join(', ') || 'none'}.` : `Resources ${resources.filter(r => !overlaps([r], scope)).join(', ')} are outside ${lease.agent}'s ${scope.join(', ') || 'empty'} scope.` });

  // 5. Concurrency: optimistic concurrency control across active leases.
  const collision = state.leases.find(other => other.id !== lease.id && other.status === 'active' &&
    (overlaps(lease.writeSet, other.writeSet) || overlaps(lease.writeSet, other.readSet) || overlaps(lease.readSet, other.writeSet)));
  checks.push(collision
    ? { name: 'concurrency', ok: false, code: 'AGENT_COLLISION', detail: overlaps(lease.writeSet, collision.readSet)
        ? `${lease.agent}'s write set intersects ${collision.agent}'s read set (${collision.issueId}). ${collision.agent}'s world would change underneath it. Sequence the work or release one lease.`
        : overlaps(lease.writeSet, collision.writeSet)
          ? `${lease.agent}'s write set intersects ${collision.agent}'s write set (${collision.issueId}). Conflicting writes cannot proceed unnoticed. Sequence the work or release one lease.`
          : `${lease.agent}'s read set intersects ${collision.agent}'s write set (${collision.issueId}). ${lease.agent}'s world may already be changing underneath it. Sequence the work or release one lease.` }
    : { name: 'concurrency', ok: true, detail: `No other active lease overlaps ${lease.agent}'s read/write surface.` });

  const failed = checks.find(c => !c.ok);
  const code = failed?.code || 'ALLOW';
  const invariant = INVARIANTS.find(i => i.codes.includes(code))?.id || null;
  const result = {
    allowed: !failed, code, reason: failed ? failed.detail : `Authorized ${action} under ${lease.agent}'s rev ${lease.revision} context lease.`,
    tier, invariant, checks, issueId: lease.issueId, leaseId: lease.id, revision: lease.revision, agent: lease.agent, action, resources, at: now(),
    context: { watches: lease.watches, facts: lease.facts.map(f => ({ id: f.id, version: f.version })) }
  };
  state.lastCheck = result;
  state.audit.unshift({ id: randomUUID(), ...result });
  state.audit = state.audit.slice(0, 200);
  event(state, result.allowed ? 'allowed' : 'blocked', `${result.code}: ${result.reason}`, { code, invariant });
  return result;
}

export function invariantReport(state) {
  return INVARIANTS.map(inv => ({
    ...inv,
    enforced: state.audit.filter(a => inv.codes.includes(a.code)).length + state.events.filter(e => e.code && inv.codes.includes(e.code) && e.code === 'PROPAGATION').length,
    traced: inv.id === 'I5' ? state.audit.filter(a => a.allowed && a.tier === 'consequential').length : undefined
  }));
}
