const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const time = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const ago = iso => { const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : time(iso); };
const ACTION_LABELS = { 'open-pr': 'Open draft PR', 'edit-files': 'Edit scoped files', 'run-tests': 'Run tests', read: 'Read files', merge: 'Merge PR', deploy: 'Deploy', 'modify-schema': 'Modify schema', 'change-api-contract': 'Change API contract', 'close-issue': 'Close issue' };
const PRESETS = {
  good: 'Implement session-cookie authentication. Do not persist refresh tokens. Touch auth/session and database/tokens only to remove token storage.',
  bad: 'Store OAuth refresh tokens in Postgres, encrypted at rest, so users remain signed in.'
};
let state;
let pending = false;
let toastTimer;

async function api(path, body) {
  const response = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
let signature = '';
const sig = s => JSON.stringify({ ...s, sessions: Object.values(s.sessions || {}).map(x => [x.pid, x.state]) });
async function refresh(force = true) {
  const next = await fetch('/api/state').then(r => r.json());
  const nextSig = sig(next);
  if (!force && nextSig === signature) return;
  state = next; signature = nextSig; render();
}
function toast(message, kind = 'error') {
  clearTimeout(toastTimer);
  $('toast').textContent = message; $('toast').className = `toast visible ${kind}`;
  toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 6000);
}
async function run(task) {
  if (pending) { console.warn('airlock: ignored click while a request is pending'); return; }
  pending = true; document.body.classList.add('busy');
  try { await task(); await refresh(); }
  catch (error) { toast(error.message); }
  finally { pending = false; document.body.classList.remove('busy'); }
}

// ---------- derived views ----------
const openLeases = () => state.leases.filter(l => l.status !== 'released');
function roles() {
  const dep = new Set(), con = new Set(), parents = new Set();
  for (const i of state.issues) { if (i.parentId) parents.add(i.parentId); for (const r of i.relations || []) (r.type === 'dependsOn' ? dep : con).add(r.issueId); }
  const map = {};
  for (const i of state.issues) map[i.id] = dep.has(i.id) ? 'dependency' : con.has(i.id) ? 'constraint' : parents.has(i.id) ? 'source' : 'task';
  return map;
}
function issueFlags() {
  const open = openLeases();
  const changed = new Set(open.flatMap(l => l.changedSources || []));
  const watched = new Set(open.flatMap(l => Object.keys(l.watches)));
  const leased = new Set(open.map(l => l.issueId));
  return { changed, watched, leased };
}

// ---------- graph ----------
function renderGraph() {
  const role = roles();
  const { changed, watched, leased } = issueFlags();
  const cols = { source: 0, constraint: 0, dependency: 1, task: 2 };
  const byCol = [[], [], []];
  for (const i of state.issues) byCol[cols[role[i.id]]].push(i);
  const NW = 200, NH = 60, GX = 54, GY = 24, PAD = 12, W = PAD * 2 + NW * 3 + GX * 2;
  const rows = Math.max(1, ...byCol.map(c => c.length));
  const H = PAD * 2 + rows * NH + (rows - 1) * GY;
  const pos = {};
  byCol.forEach((col, c) => {
    const total = col.length * NH + (col.length - 1) * GY;
    col.forEach((i, r) => { pos[i.id] = { x: PAD + c * (NW + GX), y: (H - total) / 2 + r * (NH + GY) }; });
  });
  const edge = (from, to, cls) => {
    const a = pos[from], b = pos[to];
    if (!a || !b) return '';
    const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2;
    if (x2 <= x1) return `<line class="edge ${cls}" x1="${a.x + NW / 2}" y1="${a.y + NH}" x2="${b.x + NW / 2}" y2="${b.y}"/>`;
    const mx = (x1 + x2) / 2;
    return `<path class="edge ${cls}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`;
  };
  let edges = '';
  for (const i of state.issues) {
    if (i.parentId) edges += edge(i.parentId, i.id, 'parent');
    for (const r of i.relations || []) edges += edge(r.issueId, i.id, r.type === 'dependsOn' ? 'dep' : 'constraint');
  }
  const nodes = state.issues.map(i => {
    const p = pos[i.id];
    const cls = ['node', role[i.id], changed.has(i.id) ? 'changed' : '', leased.has(i.id) ? 'leased' : '', watched.has(i.id) ? 'watched' : ''].join(' ');
    const title = i.title.length > 26 ? i.title.slice(0, 25) + '…' : i.title;
    return `<g class="${cls}" transform="translate(${p.x},${p.y})"><rect width="${NW}" height="${NH}" rx="9"/><text class="nid" x="14" y="21">${esc(i.id)}</text><text class="nrole" x="${NW - 14}" y="21" text-anchor="end">${esc(role[i.id])}</text><text class="ntitle" x="14" y="41">${esc(title)}</text>${watched.has(i.id) ? `<circle class="dot" cx="${NW - 10}" cy="${NH - 10}" r="3.5"/>` : ''}</g>`;
  }).join('');
  const svg = $('graph');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `<defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z"/></marker></defs>${edges}${nodes}`;
}

function renderIssueList() {
  const role = roles();
  const { changed, leased } = issueFlags();
  $('issueList').innerHTML = state.issues.map(i => {
    const last = i.comments.at(-1);
    return `<article class="issue ${esc(role[i.id])} ${changed.has(i.id) ? 'changed' : ''} ${leased.has(i.id) ? 'leased' : ''}"><div class="issue-head"><span class="iid">${esc(i.id)}</span><span class="chip ${esc(role[i.id])}">${esc(role[i.id])}</span>${changed.has(i.id) ? '<span class="chip changed">changed</span>' : ''}${i.url ? `<a class="ext" href="${esc(i.url)}" target="_blank" rel="noopener">↗</a>` : ''}</div><h3>${esc(i.title)}</h3><p>${esc(i.description)}</p>${last ? `<div class="latest"><b>${esc(last.author || '')}</b> · ${ago(last.at)} — ${esc(last.body)}</div>` : ''}</article>`;
  }).join('');
}

// ---------- stepper ----------
function steps() {
  const audit = state.audit || [];
  const leases = state.leases;
  const open = openLeases();
  if (state.mode === 'linear') {
    const lease = open[0];
    return [
      { label: 'Import an issue', done: true },
      { label: 'Lease it to an agent', done: !!lease, hint: 'Set a write set and click Lease imported issue.' },
      { label: 'Gate a consequential action', done: audit.some(a => a.allowed), hint: 'Check action: it should pass against fresh Linear state.' },
      { label: 'Change a watched issue in Linear', done: leases.some(l => l.status === 'invalid' || l.history?.length), hint: `Comment on ${Object.keys(lease?.watches || {}).filter(id => id !== lease?.issueId)[0] || 'a watched issue'} in Linear, then Check action again.` },
      { label: 'Revise the task in Linear, sync, re-plan', done: leases.some(l => l.revision > 1), hint: 'Edit the task description in Linear, click Sync, then Review & re-plan.' },
      { label: 'Gate passes at the new revision', done: audit.some(a => a.allowed && a.revision > 1), hint: 'Check action once more.' }
    ];
  }
  if (state.scenario === 'collision') {
    return [
      { label: 'Start two agents', done: open.length >= 2 || leases.length >= 2, hint: 'Codex A reads the API contract; Codex B is delegated to change it.' },
      { label: 'B tries to change the contract', done: audit.some(a => a.code === 'AGENT_COLLISION'), hint: "Select Codex B, action Change API contract, Check action. B's write set intersects A's read set." },
      { label: "Release A's lease", done: leases.some(l => l.agent === 'Codex A' && l.status === 'released'), hint: "Release Codex A's lease so its world can safely change." },
      { label: 'B proceeds', done: audit.some(a => a.allowed && a.agent === 'Codex B'), hint: 'Check action for Codex B again.' }
    ];
  }
  return [
    { label: 'Delegate AIR-103 to Codex', done: leases.length > 0, hint: 'Airlock snapshots six facts from four issues and issues a lease.' },
    { label: 'Gate: open draft PR', done: audit.some(a => a.allowed && a.revision === 1), hint: 'Check action. Five checks pass against the rev 1 snapshot.' },
    { label: 'Security decision lands on SEC-21', done: leases.some(l => l.status === 'invalid' || l.history?.length), hint: 'Post the decision. The lease is invalidated with a diff of what changed.' },
    { label: 'Gate again: denied, stale', done: audit.some(a => a.code === 'STALE_CONTEXT'), hint: 'Check action. STALE_CONTEXT with planned-at and changed-at times.' },
    { label: 'Revise the task and re-plan', done: leases.some(l => l.revision > 1), hint: 'Try the contradicting preset first: rev 2 is issued but still denied. Then use session cookies.' },
    { label: 'Gate passes at the new revision', done: audit.some(a => a.allowed && a.revision > 1), hint: 'Check action. Then post a contract change on AIR-138 to see propagation.' }
  ];
}
function renderStepper() {
  const list = steps();
  const current = list.findIndex(s => !s.done);
  $('stepper').innerHTML = list.map((s, i) => `<li class="${s.done ? 'done' : i === current ? 'current' : ''}"><span class="num">${s.done ? '✓' : i + 1}</span><span>${esc(s.label)}</span></li>`).join('');
  $('stepHint').textContent = current < 0 ? 'Scenario complete. Switch scenarios in the sidebar or import a Linear issue.' : list[current].hint;
}

// ---------- leases ----------
function factRow(f) {
  const weak = f.confidence < 0.6;
  return `<tr class="${esc(f.kind)}${weak ? ' weak' : ''}"><td><span class="kind">${esc(f.kind)}</span></td><td class="stmt">${esc(f.text)}</td><td>${f.source.issueId ? `${esc(f.source.issueId)} <small>${esc(f.source.field)}</small>` : '<small>operator</small>'}</td><td>${esc(f.author || '—')}${weak ? '<br><small class="warn">weak provenance</small>' : ''}</td><td>${time(f.at)}</td><td><code>${esc(f.version)}</code></td></tr>`;
}
function timeline(l) {
  const points = [{ cls: 'ok', label: `planned rev ${l.revision}`, at: l.issuedAt }];
  for (const c of (l.changedFacts || []).filter(c => c.at)) points.push({ cls: 'warn', label: `${c.source} changed · ${c.author || '?'}`, at: c.at });
  const last = (state.audit || []).find(a => a.leaseId === l.id);
  if (last) points.push({ cls: last.allowed ? 'ok' : 'deny', label: `checked · ${last.code}`, at: last.at });
  if (l.status === 'active' && points.length === 1) points.push({ cls: 'now', label: 'fresh now', at: new Date().toISOString() });
  points.sort((a, b) => a.at.localeCompare(b.at));
  return `<div class="toctou">${points.map(p => `<div class="tp ${p.cls}"><i></i><b>${esc(p.label)}</b><small>${time(p.at)}</small></div>`).join('<span class="tl"></span>')}</div>`;
}
function sessionPill(l) {
  const s = Object.values(state.sessions || {}).filter(s => s.leaseId === l.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!s) return '';
  const icon = { running: '▶', paused: '⏸', exited: '■', stale: '?' }[s.state] || '·';
  return `<span class="session ${esc(s.state)}" title="${esc(s.command)}">${icon} pid ${s.pid} ${esc(s.state)}</span>`;
}
function leaseCard(l, expanded) {
  const changes = (l.changedFacts || []).map(c => `<div class="diff ${esc(c.type)}"><b>${esc(c.type)}</b> ${esc(c.kind)} · ${esc(c.source || 'operator')}${c.before ? `<s>${esc(c.before)}</s>` : ''}${c.text ? `<span>${esc(c.text)}</span>` : ''}</div>`).join('');
  const drift = (l.drift || []).map(d => `<div class="diff conflict"><b>now contradicts</b> ${esc(d.explanation)}</div>`).join('');
  const contradiction = l.consistency?.status === 'contradiction' ? `<div class="diff conflict"><b>contradiction</b> ${esc(l.consistency.findings[0].explanation)} <i>(${esc(l.consistency.findings[0].method)})</i></div>` : '';
  const facts = ['requirement', 'constraint', 'dependency', 'authority'].flatMap(k => l.facts.filter(f => f.kind === k)).map(factRow).join('');
  return `<article class="lease ${esc(l.status)}">
    <header class="lease-head"><div class="lease-id"><span class="agent">${esc(l.agent)}</span><span class="sep">on</span><span class="issue">${esc(l.issueId)}</span><span class="rev">rev ${l.revision}</span></div><div class="lease-right">${sessionPill(l)}<span class="status ${esc(l.status)}">${esc(l.status)}</span></div></header>
    ${timeline(l)}
    <div class="scopes"><span><b>READ</b> ${esc(l.readSet.join(', ') || '—')}</span><span><b>WRITE</b> ${esc(l.writeSet.join(', ') || '—')}</span><span><b>WATCH</b> ${esc(Object.keys(l.watches).join(', '))}</span><span><b>MAY</b> ${esc(l.allowedActions.join(', '))}</span><span><b>MAY NOT</b> ${esc(l.deniedActions.join(', ') || '—')}</span></div>
    ${contradiction}${l.status === 'invalid' ? `<div class="changes"><b>Invalidated ${time(l.invalidatedAt)} by ${esc(l.changedSources.join(', '))}</b>${changes}${drift}</div>` : ''}
    <details ${expanded ? 'open' : ''}><summary>${l.facts.length} facts · consistency <b class="${esc(l.consistency?.status)}">${esc(l.consistency?.status || 'unknown')}</b>${l.history?.length ? ` · ${l.history.length} prior revision${l.history.length === 1 ? '' : 's'}` : ''}</summary><div class="table-wrap"><table class="facts"><thead><tr><th>Kind</th><th>Statement</th><th>Source</th><th>Author</th><th>Time</th><th>Version</th></tr></thead><tbody>${facts}</tbody></table></div></details>
    <footer class="lease-actions">${l.status === 'invalid' ? `<button class="button small primary" data-action="replan" data-id="${esc(l.id)}">Review & re-plan ↗</button>${state.mode === 'linear' ? `<button class="button small secondary" data-action="publish" data-id="${esc(l.id)}">Publish intervention in Linear ↗</button>` : ''}` : ''}<button class="link-button" data-action="release" data-id="${esc(l.id)}">Release lease</button><button class="link-button" data-copy="${esc(l.id)}">Copy lease id</button></footer>
  </article>`;
}

// ---------- main render ----------
function render() {
  const collision = state.scenario === 'collision';
  const live = state.mode === 'linear';
  const open = openLeases();
  const last = state.lastCheck;
  document.body.dataset.mode = state.mode;
  $('driftTab').classList.toggle('active', !collision && !live);
  $('collisionTab').classList.toggle('active', collision && !live);
  $('crumbScenario').textContent = live ? `Linear · ${state.issues[0]?.id || ''}` : collision ? 'Agent collision' : 'Requirement drift';
  $('modeBadge').textContent = live ? 'LIVE LINEAR DATA' : 'SAMPLE DATA';
  $('modeBadge').className = `mode-badge ${live ? 'live' : ''}`;
  $('modelBadge').hidden = !state.modelConfigured;
  $('modelBadge').textContent = !state.modelStatus ? 'MODEL KEY SET · UNTESTED' : state.modelStatus === 'ok' ? 'MODEL REVIEW ON' : `MODEL REVIEW OFF · ${state.modelStatus.toUpperCase()}`;
  $('modelBadge').className = `mode-badge ${state.modelStatus === 'ok' ? 'live' : ''}`;
  $('modelBadge').title = 'Model review is advisory. Deterministic checks decide allow/deny regardless.';
  $('activeCount').textContent = state.leases.filter(l => l.status === 'active').length;
  $('invalidCount').textContent = state.leases.filter(l => l.status === 'invalid').length;
  $('factCount').textContent = open.reduce((n, l) => n + l.facts.length, 0);
  const sessions = Object.values(state.sessions || {}).filter(s => s.state !== 'exited');
  $('sessionCount').textContent = sessions.length;
  $('sessionNote').textContent = sessions.some(s => s.state === 'paused') ? `${sessions.filter(s => s.state === 'paused').length} paused by SIGSTOP` : 'under session guard';
  $('gateMetric').textContent = last ? (last.allowed ? 'PASS' : 'DENY') : '—';
  $('gateMetric').className = last ? (last.allowed ? 'pass' : 'deny') : '';
  $('gateMetricNote').textContent = last ? `${last.code} · ${last.tier}` : 'most recent action';
  const { watched, changed } = issueFlags();
  $('sourceList').innerHTML = state.issues.map(i => `<div class="source-item"><i class="${changed.has(i.id) ? 'changed' : watched.has(i.id) ? 'watched' : ''}"></i><span><b>${esc(i.id)}</b><br>${esc(i.title)}</span></div>`).join('');
  $('invariantList').innerHTML = (state.invariants || []).map(inv => `<div class="invariant"><b>${esc(inv.id)}</b><span>${esc(inv.title)}</span><em>${inv.enforced} enforced${inv.traced !== undefined ? ` · ${inv.traced} traced` : ''}</em></div>`).join('');
  renderGraph();
  renderIssueList();
  renderStepper();
  $('leaseList').innerHTML = open.map((l, i) => leaseCard(l, open.length === 1 || l.status === 'invalid')).join('') || `<div class="empty-note">No agent holds a context lease yet. ${live ? 'Set a write set and lease the imported issue.' : collision ? 'Start two agents to see optimistic concurrency control.' : 'Delegate AIR-103 to Codex to snapshot its context.'}</div>`;
  $('startControls').innerHTML = live ? '<button id="startLive" class="button primary">Lease imported issue <span>→</span></button>' : collision ? '<button id="startPair" class="button primary">Start two agents <span>→</span></button>' : '<button id="startCodex" class="button primary">Delegate AIR-103 to Codex <span>→</span></button>';
  $('liveConfig').hidden = !live;
  $('decisionHelp').textContent = live ? '' : collision ? 'Agent B rewrites the API contract that Agent A is reading. The overlap surfaces at the action boundary, before the world changes underneath A.' : 'A security decision lands on SEC-21 after Codex has already read the old policy. Try AIR-138 to see a dependency change propagate to two agents.';
  $('decisionForm').hidden = live || collision;
  $('liveDecision').hidden = !live;
  const sources = state.issues.filter(i => !open.some(l => l.issueId === i.id));
  const prevSource = $('decisionSource').value;
  $('decisionSource').innerHTML = sources.map(i => `<option value="${esc(i.id)}">${esc(i.id)} · ${esc(i.title)}</option>`).join('');
  $('decisionSource').value = sources.some(i => i.id === prevSource) ? prevSource : sources.some(i => i.id === 'SEC-21') ? 'SEC-21' : sources[0]?.id || '';
  const needsRevision = !live && !collision && state.leases.some(l => l.status === 'invalid' || l.consistency?.status === 'contradiction');
  $('reviseForm').hidden = !needsRevision;
  if (needsRevision && !$('reviseText').value) $('reviseText').value = PRESETS.good;
  const prevLease = $('leaseSelect').value;
  $('leaseSelect').innerHTML = open.map(l => `<option value="${esc(l.id)}">${esc(l.agent)} · ${esc(l.issueId)} · rev ${l.revision} · ${esc(l.status)}</option>`).join('') || '<option value="">Start an agent first</option>';
  if (open.some(l => l.id === prevLease)) $('leaseSelect').value = prevLease;
  const actions = [...state.actions.consequential, ...state.actions.light];
  const scenarioKey = `${state.mode}:${state.scenario}`;
  const prevAction = $('actionSelect').dataset.scenario === scenarioKey ? $('actionSelect').value : '';
  $('actionSelect').dataset.scenario = scenarioKey;
  $('actionSelect').innerHTML = actions.map(a => `<option value="${esc(a)}">${esc(ACTION_LABELS[a] || a)} · ${state.actions.consequential.includes(a) ? 'consequential' : 'light'}</option>`).join('');
  $('actionSelect').value = actions.includes(prevAction) ? prevAction : collision ? 'change-api-contract' : 'open-pr';
  const lease = open.find(l => l.id === $('leaseSelect').value) || open[0];
  if (lease && !$('resourceInput').dataset.touched) $('resourceInput').value = lease.writeSet[0] || '';
  $('guardSnippet').textContent = `node bin/guarded-session.js ${lease ? lease.id : 'LEASE_ID'} -- codex exec "implement ${lease ? lease.issueId : 'AIR-103'}"`;
  $('gateResult').className = 'gate-result ' + (!last ? 'empty' : last.allowed ? 'allow' : 'deny');
  $('gateResult').innerHTML = last ? `<div class="verdict"><strong>${last.allowed ? '✓ AUTHORIZED' : '⊘ DENIED'}</strong><span class="code">${esc(last.code)}</span>${last.invariant ? `<span class="inv">${esc(last.invariant)}</span>` : ''}<span class="who">${esc(last.agent)} · ${esc(last.action)} · rev ${last.revision}</span></div><p>${esc(last.reason)}</p><div class="checks">${(last.checks || []).map(c => `<div class="check ${c.ok ? 'ok' : 'fail'}"><b>${c.ok ? '✓' : '✕'} ${esc(c.name)}</b><span>${esc(c.detail)}</span></div>`).join('')}</div>${last.analysis ? `<p class="analysis"><b>Model analysis</b> ${esc(last.analysis)}</p>` : ''}` : 'No action has been checked yet.';
  $('eventList').innerHTML = state.events.map(e => `<div class="event ${esc(e.kind)}"><i></i><div><p>${esc(e.message)}</p><small>${time(e.at)}${e.invariant ? ` · ${esc(e.invariant)}` : ''}</small></div></div>`).join('');
  $('auditTable').querySelector('tbody').innerHTML = (state.audit || []).slice(0, 12).map(a => `<tr class="${a.allowed ? 'allow' : 'deny'}"><td>${time(a.at)}</td><td>${esc(a.agent)}</td><td>${esc(a.action)}<br><small>${esc(a.resources.join(', '))} · ${esc(a.tier)}</small></td><td>${a.revision}</td><td><b>${esc(a.code)}</b>${a.invariant ? `<br><small>${esc(a.invariant)}</small>` : ''}</td><td><small>${esc(Object.entries(a.context.watches).map(([k, v]) => `${k}@${v}`).join(' '))}</small></td></tr>`).join('') || '<tr><td colspan="6" class="empty-cell">No gate decisions recorded yet.</td></tr>';
}

// ---------- wiring ----------
$('driftTab').onclick = () => run(() => api('reset', { scenario: 'drift' }));
$('collisionTab').onclick = () => run(() => api('reset', { scenario: 'collision' }));
$('startControls').onclick = event => run(async () => {
  if (!event.target.closest('button')) return;
  if (state.mode === 'linear') {
    const issue = state.issues[0];
    const paths = id => $(id).value.split(',').map(s => s.trim()).filter(Boolean);
    const writeSet = paths('writeScope');
    if (!writeSet.length) throw new Error('Enter at least one scoped resource for the live issue');
    return api('leases', { issueId: issue.id, agent: $('agentName').value.trim() || 'Codex', readSet: paths('readScope'), writeSet });
  }
  if (state.scenario === 'collision') {
    if (!state.leases.some(l => l.agent === 'Codex A' && l.status !== 'released')) await api('leases', { issueId: 'AIR-202', agent: 'Codex A', readSet: ['auth/api-contract', 'auth/session-schema'], writeSet: ['frontend/auth'] });
    if (!state.leases.some(l => l.agent === 'Codex B' && l.status !== 'released')) await api('leases', { issueId: 'AIR-201', agent: 'Codex B', readSet: ['auth/requirements'], writeSet: ['auth/api-contract'], allowedActions: ['edit-files', 'run-tests', 'open-pr', 'change-api-contract'] });
  } else await api('leases', { issueId: 'AIR-103', agent: 'Codex', readSet: ['auth/session'], writeSet: ['auth/session', 'database/tokens'] });
});
$('leaseList').onclick = event => {
  const copy = event.target.closest('button[data-copy]');
  if (copy) { navigator.clipboard?.writeText(copy.dataset.copy).then(() => toast('Lease id copied', 'ok')).catch(() => toast(copy.dataset.copy, 'ok')); return; }
  run(async () => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    await api(button.dataset.action === 'publish' ? 'interventions/publish' : 'leases/' + button.dataset.action, { leaseId: button.dataset.id });
  });
};
$('decisionSource').onchange = () => { if ($('decisionSource').value === 'AIR-138') $('decisionText').value = 'Contract change: POST /auth/session now returns { user_id, session }. The token field is removed.'; };
$('decisionForm').onsubmit = event => { event.preventDefault(); run(() => api('decisions', { issueId: $('decisionSource').value, body: $('decisionText').value, author: $('decisionSource').value.startsWith('SEC') ? 'Security' : $('decisionSource').value === 'AIR-138' ? 'Backend lead' : 'PM' })); };
$('reviseForm').onclick = event => { const preset = event.target.closest('button[data-preset]'); if (preset) $('reviseText').value = PRESETS[preset.dataset.preset]; };
$('reviseForm').onsubmit = event => { event.preventDefault(); run(() => api('issues/revise', { issueId: 'AIR-103', description: $('reviseText').value })); };
$('leaseSelect').onchange = () => { const lease = state.leases.find(l => l.id === $('leaseSelect').value); if (lease) { $('resourceInput').value = lease.writeSet[0] || ''; delete $('resourceInput').dataset.touched; } };
$('resourceInput').oninput = () => { $('resourceInput').dataset.touched = '1'; };
$('gateForm').onsubmit = event => { event.preventDefault(); run(async () => {
  const lease = state.leases.find(l => l.id === $('leaseSelect').value);
  if (!lease) throw new Error('Start an agent first');
  const resources = $('resourceInput').value.split(',').map(s => s.trim()).filter(Boolean);
  await api('gate', { leaseId: lease.id, action: $('actionSelect').value, resources });
}); };
$('syncButton').onclick = () => run(() => api('linear/sync', {}));
$('importForm').onsubmit = event => { event.preventDefault(); run(() => api('linear/import', { issueId: $('issueIdInput').value })); };
refresh().catch(error => toast(error.message));
// Keep live process pills and "ago" labels fresh without hammering the server.
setInterval(() => { if (!pending && !document.hidden && !document.activeElement?.matches('input,textarea,select')) refresh(false).catch(() => {}); }, 4000);
