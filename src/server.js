import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { demoState, createLease, addDecision, reviseIssue, replaceIssues, gate, releaseLease, replanLease, assessLeaseConsistency, invariantReport, CONSEQUENTIAL_ACTIONS, LIGHT_ACTIONS, INVARIANTS } from './engine.js';
import { fetchIssueGraph, refreshGraph, publishIntervention } from './linear.js';
import { explainDrift, assessConsistency, modelConfigured, modelStatus } from './semantic.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateFile = path.join(process.env.AIRLOCK_DATA_DIR || path.join(root, 'data'), 'state.json');
const port = Number(process.env.PORT || 3000);
let state = loadState();
let queue = Promise.resolve();
const delivered = new Set();

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    // Older state files predate typed facts; start fresh rather than serve half-formed leases.
    if (Array.isArray(saved.audit) && saved.leases.every(l => Array.isArray(l.facts))) { saved.sessions ||= {}; return saved; }
  } catch {}
  return demoState();
}

function save() {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(stateFile + '.tmp', stateFile);
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256_000) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  return { raw, body: raw.length ? JSON.parse(raw.toString('utf8')) : {} };
}

function verifyWebhook(req, raw, body) {
  const secret = process.env.LINEAR_WEBHOOK_SECRET;
  if (!secret || !Number.isFinite(body.webhookTimestamp) || Math.abs(Date.now() - body.webhookTimestamp) > 60_000) return false;
  const signature = req.headers['linear-signature'];
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

async function sync() {
  if (state.mode !== 'linear') return;
  const fresh = await refreshGraph(state.issues);
  replaceIssues(state, fresh);
}

// Model consistency review runs in the background after the deterministic snapshot is issued.
// It can only add findings, and it is discarded if the lease moved on before it returned.
function withModelReview(lease) {
  const revision = lease.revision;
  assessConsistency(lease.facts).then(findings => {
    if (!findings || lease.revision !== revision || lease.status === 'released') return;
    queue = queue.then(() => {
      const before = lease.consistency?.status;
      assessLeaseConsistency(lease, findings);
      if (findings.length && before !== 'contradiction') state.events.unshift({ id: `m-${Date.now()}`, at: new Date().toISOString(), kind: 'blocked', message: `Model review found a contradiction in ${lease.agent}'s ${lease.issueId} context: ${findings[0].explanation}` });
      save();
    }).catch(() => {});
  }).catch(() => {});
  return lease;
}

function sessionsView() {
  const out = {};
  for (const [pid, s] of Object.entries(state.sessions || {})) {
    const age = Date.now() - Date.parse(s.updatedAt);
    if (s.state === 'exited' && age > 60_000) continue;
    out[pid] = { ...s, state: s.state !== 'exited' && age > 12_000 ? 'stale' : s.state };
  }
  return out;
}

function publicState() {
  return { ...state, sessions: sessionsView(), invariants: invariantReport(state), actions: { consequential: CONSEQUENTIAL_ACTIONS, light: LIGHT_ACTIONS }, linearConfigured: !!process.env.LINEAR_API_KEY, modelConfigured: modelConfigured(), modelStatus: modelStatus() };
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET') {
    if (url.pathname === '/api/state') return json(res, 200, publicState());
    if (url.pathname === '/api/audit') return json(res, 200, { audit: state.audit, invariants: invariantReport(state) });
    if (url.pathname === '/api/invariants') return json(res, 200, { invariants: invariantReport(state), definitions: INVARIANTS });
    const leaseMatch = url.pathname.match(/^\/api\/leases\/([0-9a-f-]{36})$/);
    if (leaseMatch) {
      const lease = state.leases.find(l => l.id === leaseMatch[1]);
      return lease ? json(res, 200, lease) : json(res, 404, { error: 'Unknown lease' });
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!['index.html', 'app.js', 'style.css'].includes(name)) return json(res, 404, { error: 'Not found' });
    const mime = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html';
    const content = fs.readFileSync(path.join(root, 'public', name));
    res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'", 'X-Content-Type-Options': 'nosniff' });
    return res.end(content);
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: 'Use application/json' });
  const { raw, body } = await readBody(req);
  if (url.pathname === '/api/webhook/linear') {
    if (!verifyWebhook(req, raw, body)) return json(res, 401, { error: 'Invalid signature or timestamp' });
    const delivery = req.headers['linear-delivery'];
    if (delivery && delivered.has(delivery)) return json(res, 200, { ok: true, duplicate: true });
    await sync();
    if (delivery) { delivered.add(delivery); if (delivered.size > 500) delivered.delete(delivered.values().next().value); }
    save();
    return json(res, 200, { ok: true });
  }
  let result;
  switch (url.pathname) {
    case '/api/reset':
      if (!['drift', 'collision'].includes(body.scenario)) throw new Error('Unknown scenario');
      state = demoState(body.scenario); result = { ok: true }; break;
    case '/api/linear/import': {
      const identifier = String(body.issueId || process.env.LINEAR_ISSUE_ID || '').trim();
      if (!/^[A-Za-z][A-Za-z0-9]*-[0-9]+$/.test(identifier)) throw new Error('Enter a Linear issue identifier such as ENG-123');
      const issues = await fetchIssueGraph(identifier);
      state = { mode: 'linear', scenario: 'drift', issues, leases: [], audit: [], sessions: {}, events: [{ id: 'import', at: new Date().toISOString(), kind: 'info', message: `Imported ${identifier} with ${issues.length - 1} linked source issue${issues.length === 2 ? '' : 's'} from Linear.` }], lastCheck: null };
      result = { issues: issues.map(i => i.id) }; break;
    }
    case '/api/linear/sync': await sync(); result = { ok: true }; break;
    case '/api/sessions': {
      const pid = Number(body.pid);
      if (!Number.isInteger(pid) || !body.leaseId || !['running', 'paused', 'exited'].includes(body.state)) throw new Error('pid, leaseId, and state are required');
      const lease = state.leases.find(l => l.id === body.leaseId);
      if (!lease) throw new Error('Unknown lease');
      const previous = state.sessions[pid];
      state.sessions[pid] = { pid, leaseId: lease.id, agent: lease.agent, issueId: lease.issueId, command: String(body.command || '').slice(0, 200), state: body.state, startedAt: previous?.startedAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
      if (!previous || previous.state !== body.state) state.events.unshift({ id: `s-${pid}-${Date.now()}`, at: new Date().toISOString(), kind: body.state === 'paused' ? 'blocked' : body.state === 'running' ? 'allowed' : 'info', message: `${lease.agent}'s process ${pid} is ${body.state}${body.command ? ` (${String(body.command).slice(0, 60)})` : ''}.` });
      result = state.sessions[pid]; break;
    }
    case '/api/leases': result = withModelReview(createLease(state, body)); break;
    case '/api/decisions':
      if (state.mode !== 'demo') throw new Error('Post a decision in Linear, then sync; demo decisions cannot edit a real workspace');
      result = addDecision(state, body.issueId, body.body, body.author); break;
    case '/api/issues/revise':
      if (state.mode !== 'demo') throw new Error('Revise the task in Linear, then sync');
      result = reviseIssue(state, body.issueId, body.description); break;
    case '/api/gate': {
      if (CONSEQUENTIAL_ACTIONS.includes(body.action)) await sync();
      result = gate(state, body);
      if (result.code === 'STALE_CONTEXT') result.analysis = await explainDrift(state, state.leases.find(l => l.id === result.leaseId));
      break;
    }
    case '/api/leases/replan': await sync(); result = withModelReview(replanLease(state, body.leaseId)); break;
    case '/api/leases/release': result = releaseLease(state, body.leaseId); break;
    case '/api/interventions/publish': {
      if (state.mode !== 'linear') throw new Error('Publish is available only in Linear mode');
      const lease = state.leases.find(l => l.id === body.leaseId);
      if (!lease || lease.status !== 'invalid') throw new Error('Choose an invalidated lease');
      await sync();
      const issue = state.issues.find(i => i.id === lease.issueId);
      const source = (lease.changedSources || []).map(id => state.issues.find(i => i.id === id)).filter(Boolean);
      const message = `Airlock: context lease for ${lease.agent} (rev ${lease.revision}) invalidated.\n\nChanged source: ${source.map(i => i.url || i.id).join(', ')}.\n\n${lease.changedFacts.map(c => `- ${c.type} ${c.kind} from ${c.source}: ${c.text || c.before}`).join('\n')}\n\nThe agent's planned action should be re-validated against the new issue context before continuing. This is an advisory comment; Airlock pauses only processes run under its session guard.`;
      result = { commentId: await publishIntervention(issue, message) };
      state.events.unshift({ id: result.commentId, at: new Date().toISOString(), kind: 'decision', message: `Published intervention on ${issue.id}.` });
      break;
    }
    default: return json(res, 404, { error: 'Unknown endpoint' });
  }
  save();
  return json(res, 200, result);
}

const server = http.createServer((req, res) => {
  const operation = queue.then(() => route(req, res)).catch(error => {
    if (!res.headersSent) json(res, 400, { error: error.message });
  });
  queue = operation;
});

server.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(`Airlock ready at http://${process.env.HOST || '127.0.0.1'}:${port}`);
});
