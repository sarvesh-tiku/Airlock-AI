#!/usr/bin/env node
// Build the static GitHub Pages playground into docs/ from the real sources.
// The engine is the same file as the server uses; only the Node crypto import
// is swapped for a browser shim, and a fetch shim answers /api/* in-page.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs');
fs.mkdirSync(out, { recursive: true });
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const write = (p, s) => fs.writeFileSync(path.join(out, p), s);

// 1. Engine: identical logic, browser crypto.
const engine = read('src/engine.js');
if (!engine.includes("from 'node:crypto'")) throw new Error('engine import shape changed; update build-pages.mjs');
write('engine.js', engine.replace("from 'node:crypto'", "from './crypto-shim.js'"));
write('crypto-shim.js', `// Browser stand-ins for the two node:crypto calls the engine makes.
// Version hashes here are FNV-1a based: fine for change detection in a playground.
export const randomUUID = () => crypto.randomUUID();
function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
export function createHash() {
  let data = '';
  return { update(value) { data += String(value); return this; }, digest() { return fnv1a(data, 0x811c9dc5) + fnv1a(data, 0x01000193) + fnv1a(data, 0xdeadbeef); } };
}
`);

// 2. Fetch shim: the server's demo-mode routes, in the page, persisted to localStorage.
write('shim.js', `import * as E from './engine.js';
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
    const m = pathname.match(/^\\/api\\/leases\\/([0-9a-f-]{36})$/);
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
`);

// 3. UI: same app.js and style.css; index.html gets relative paths, the shim, and a banner.
write('app.js', read('public/app.js'));
write('style.css', read('public/style.css') + `
/* playground */
.playground-banner{background:#111b2a;color:#d9e1ed;font-size:12px;padding:10px 40px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.playground-banner b{color:#ecaa56;font:700 10px 'Space Grotesk',sans-serif;letter-spacing:.14em}
.playground-banner a{color:#8fb0ff;text-decoration:underline}
@media(max-width:820px){.playground-banner{padding:10px 16px}}
`);
let html = read('public/index.html')
  .replace('href="/style.css"', 'href="./style.css"')
  .replace('<script src="/app.js" type="module"></script>', '<script src="./shim.js" type="module"></script>\n  <script src="./app.js" type="module"></script>')
  .replace('<title>Airlock · Context integrity for coding agents</title>', '<title>Airlock playground · Context integrity for coding agents</title>')
  .replace('<header class="topbar">', '<div class="playground-banner"><b>STATIC PLAYGROUND</b><span>Sample data only, running the real gate engine in your browser. Live Linear import, signed webhooks, model review, and pausing a real process need the server: <a href="https://github.com/sarvesh-tiku/airlock">clone the repo</a> and run <code>npm start</code>.</span></div>\n      <header class="topbar">')
  .replace('placeholder="e.g. SAR-8"', 'placeholder="needs the server"');
if (!html.includes('playground-banner') || !html.includes('./shim.js')) throw new Error('index.html shape changed; update build-pages.mjs');
write('index.html', html);
write('.nojekyll', '');
console.log('docs/ built from src/engine.js and public/*:', fs.readdirSync(out).join(', '));
