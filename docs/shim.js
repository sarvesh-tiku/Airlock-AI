import * as E from './engine.js';
const KEY = 'airlock-playground-state';
const load = () => { try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && Array.isArray(s.audit) && s.leases.every(l => Array.isArray(l.facts))) return s; } catch {} return null; };
let state = load() || E.demoState();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };
const publicState = () => ({ ...state, sessions: {}, invariants: E.invariantReport(state), actions: { consequential: E.CONSEQUENTIAL_ACTIONS, light: E.LIGHT_ACTIONS }, linearConfigured: false, modelConfigured: false, modelStatus: null, playground: true });
const SERVER_ONLY = 'Not available in the static playground. Clone the repo and run npm start for live Linear, webhooks, model review, and the session guard.';

function handle(method, pathname, body) {
  if (method === 'GET') {
    if (pathname === '/api/state') return publicState();
    if (pathname === '/api/audit') return { audit: state.audit, invariants: E.invariantReport(state) };
    if (pathname === '/api/invariants') return { invariants: E.invariantReport(state), definitions: E.INVARIANTS };
    const m = pathname.match(/^\/api\/leases\/([0-9a-f-]{36})$/);
    if (m) { const lease = state.leases.find(l => l.id === m[1]); if (!lease) throw new Error('Unknown lease'); return lease; }
    throw new Error('Not found');
  }
  switch (pathname) {
    case '/api/reset': if (!['drift', 'collision'].includes(body.scenario)) throw new Error('Unknown scenario'); state = E.demoState(body.scenario); return { ok: true };
    case '/api/leases': return E.createLease(state, body);
    case '/api/decisions': return E.addDecision(state, body.issueId, body.body, body.author);
    case '/api/issues/revise': return E.reviseIssue(state, body.issueId, body.description);
    case '/api/gate': return E.gate(state, body);
    case '/api/leases/replan': return E.replanLease(state, body.leaseId);
    case '/api/leases/release': return E.releaseLease(state, body.leaseId);
    case '/api/sessions': return { ok: true };
    case '/api/linear/import': case '/api/linear/sync': case '/api/interventions/publish': throw new Error(SERVER_ONLY);
    default: throw new Error('Unknown endpoint');
  }
}

const realFetch = window.fetch.bind(window);
window.fetch = async (url, init = {}) => {
  const u = typeof url === 'string' ? url : url.url;
  const at = u.indexOf('/api/');
  if (at < 0) return realFetch(url, init);
  const pathname = u.slice(at).split('?')[0];
  try {
    const body = init.body ? JSON.parse(init.body) : {};
    const data = handle((init.method || 'GET').toUpperCase(), pathname, body);
    save();
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
};
