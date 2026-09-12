# Airlock

**Context integrity for coding agents working from Linear issues.**

> Agents shouldn't just validate context before they reason. They should validate that the world they reasoned about is still the world they're about to act on.

A coding agent reads a ticket, plans, and starts working. Then a human changes a requirement on a parent issue, a security policy, or an API contract the ticket depends on. The agent's reasoning was not wrong. Its world became wrong underneath it. That is a time-of-check to time-of-use (TOCTOU) problem, and when several agents share files it is a concurrency-control problem. Airlock treats it as one.

Built from scratch for the September 12, 2026 *Agents, Everywhere* hackathon (AI Tinkerers, with OpenAI). All `AIR-*` and `SEC-*` issues are fictional sample data.

## Run

Requires Node.js 22+. No package install, database, or credentials are needed for the sample workspace.

```bash
npm start      # http://127.0.0.1:3000
npm test       # 7 checks: drift, contradiction, propagation, collision, authority, provenance, live session pause/resume
```

## The core concept: a Context Lease

When an agent is delegated an issue, Airlock does not hand it a pile of text. It issues a **versioned context snapshot**:

```
Context Lease  AIR-103 · Codex · rev 1 · issued 11:42:03

  requirement   "Store OAuth refresh tokens in Postgres…"      AIR-103 description   PM              v fc0ea8a9
  constraint    "Ship SSO behind a feature flag…"              AIR-100 comment       PM              v 8b6e88c1
  constraint    "Refresh tokens may be persisted only when
                 encrypted at rest…"                           SEC-21 description    Security        v f8bb155b
  dependency    "POST /auth/session returns {user_id, token}"  AIR-138 description   Backend lead    v 17521974
  authority     may edit-files, run-tests, open-pr
                may NOT merge, deploy
                write auth/session, database/tokens            operator envelope     Operator        v 3c1e…

  watch set: AIR-103, AIR-100, SEC-21, AIR-138
```

Every fact carries **source, author, timestamp, version, and confidence**. The watch set is derived from the facts: the issue itself, its parent, issues linked as constraints, and issues it depends on. Those are the facts under which this agent was authorized to proceed.

## Validate at safety boundaries, not continuously

1. **At delegation.** Collect requirements, constraints, and dependencies; check them for contradictions; issue the lease.
2. **When something relevant changes.** A Linear webhook, a sync, or a demo decision lands. Airlock checks whether the change intersects any active lease's watch set. If it does, that lease is invalidated, the changed facts are diffed against the snapshot, and the change is **propagated to every dependent agent** at once. This is cache invalidation, not "ask the model to re-read everything."
3. **Immediately before a consequential action.** `open-pr`, `merge`, `deploy`, `modify-schema`, `change-api-contract`, `close-issue`. Airlock refreshes the sources and asks: is the context version now equal to the context version when the agent planned? If yes, execute. If no, deny and re-plan.

## Four independent checks, not one score

A single `context_correct = 0.83` hides why something failed. The gate returns five explicit results, and the first failure decides:

| Check | Question | How |
|---|---|---|
| **Freshness** | Did any watched source change since the snapshot? | Deterministic: `expected_version == current_version` per source |
| **Consistency** | Do the requirement and an active constraint contradict? | Deterministic heuristic (negation + shared terms; newest statement per source wins) plus optional model review |
| **Provenance** | Does every fact have a source, author, timestamp, and version? | Deterministic; unattributed facts are tolerated for light actions and block consequential ones |
| **Authority** | Is this action and resource inside the delegated envelope? | Deterministic; allow list, deny list, and path scope with `**` globs |
| **Concurrency** | Does another active lease's write set intersect my read or write set? | Deterministic; optimistic concurrency control across agents |

Model review (OpenAI Responses API, or any compatible gateway such as OpenRouter via `OPENAI_BASE_URL`) can **add** a contradiction finding or explain drift to a human. It can never turn a denial into an allow. It runs in the background after a lease is issued, and after any failure (no credits, timeout, bad key) Airlock skips model calls for a minute so a dead key never slows the gate. The top bar shows the real status of the last model call.

## Five invariants

Rather than proving each agent is "safe," Airlock maintains things that must always stay true, and every gate decision names the invariant it enforced:

| | Invariant | Gate code |
|---|---|---|
| I1 | No agent executes using invalidated or contradictory context. | `STALE_CONTEXT`, `INCONSISTENT_CONTEXT` |
| I2 | No agent silently exceeds its delegated authority. | `OUT_OF_SCOPE` |
| I3 | A human constraint propagates to every dependent active agent. | `PROPAGATION` event |
| I4 | Conflicting reads and writes cannot proceed unnoticed. | `AGENT_COLLISION` |
| I5 | Every consequential action is traceable to the context that authorized it. | audit record with every fact version; `WEAK_PROVENANCE` |

The audit log (`GET /api/audit`, and the Traceability panel) records, for each decision, the lease revision and the version of every fact behind it: who knew what, decided what, and acted when.

## Put a real agent under a lease

Two opt-in wrappers, both fail closed when Airlock is unreachable:

```bash
# Gate one consequential command. The command does not run if the gate denies.
node bin/guarded-action.js LEASE_ID open-pr auth/session -- gh pr create --draft --title "Session update"

# Run a long-lived agent process under the lease. On invalidation the process receives SIGSTOP
# and a "PAUSED: context changed" message; a clean re-plan sends SIGCONT. A released lease
# terminates it. A re-plan that still contradicts a constraint keeps it paused.
node bin/guarded-session.js LEASE_ID -- codex exec "implement AIR-103"

# Check-only exit status for other integrations.
node bin/airlock-gate.js LEASE_ID open-pr auth/session
```

Re-planning keeps the lease id stable and bumps its revision, so a wrapper polls one identifier for the life of the task. The previous snapshot goes into the lease's history.

The session guard also sends a best-effort heartbeat to `POST /api/sessions`, so the dashboard shows each guarded process next to its lease as **running**, **paused**, or **exited**. The heartbeat is informational only; enforcement is the signal the guard sends to the process.

## The dashboard

The control surface at `http://127.0.0.1:3000` shows the work graph drawn from the issue links (parent, constrained-by, depends-on) with changed sources highlighted; a guided stepper that tracks your progress through the scenario; each context lease with a planned-to-changed-to-checked timeline, its scopes, a diff of changed facts, and the full facts table with provenance; the pre-action gate with all five check results; the event trail; and the audit table. Guarded processes appear on their lease as they run, pause, and resume.

## The demo

**Requirement drift.** Delegate `AIR-103` (persist refresh tokens) to Codex. Gate *Open draft PR*: it passes. Post the security decision on `SEC-21`: refresh tokens must never be persisted. The lease is invalidated with a diff of exactly which fact changed and what it now contradicts. Gate again: `STALE_CONTEXT`, with the planned-at and changed-at timestamps. Try to re-plan without touching the ticket: refused. Revise the ticket to *keep* refresh tokens and re-plan: the lease is issued at rev 2 but the gate returns `INCONSISTENT_CONTEXT`. Revise it to session cookies: rev 3 passes. Post a contract change on `AIR-138` and watch it propagate to both `AIR-103` and `AIR-104`.

**Agent collision.** Codex A reads `auth/api-contract` to build the login UI. Codex B is delegated to change that contract. B's `change-api-contract` is denied with `AGENT_COLLISION` because B's write set intersects A's read set. Release A's lease and B proceeds.

## Connect Linear

Copy `.env.example` to `.env` and set `LINEAR_API_KEY`. Import an issue such as `ENG-123`. Airlock reads it, its parent, the issues that **block** it (dependencies), and issues marked **related** (constraint sources) through [Linear's GraphQL API](https://linear.app/developers/graphql). A consequential gate call refreshes all of them before deciding. Optionally set `LINEAR_WEBHOOK_SECRET` and point **Issue** and **Comment** webhooks at `/api/webhook/linear`; the receiver verifies the raw-body HMAC signature and rejects timestamps older than 60 seconds.

In live mode, decisions and revisions happen **in Linear**. The **Publish intervention in Linear** button explicitly posts an advisory comment listing the changed facts; nothing is written to Linear automatically. Credentials stay on the server and are never saved to the workspace state file.

## Limits, stated plainly

- The gate closes the check-to-action window only for tools routed through it. Linear and a Git host do not share a transaction: a remote change can still land after the refresh and before the guarded command commits.
- The session guard pauses a **process**. It works for any agent that runs as a child process (a CLI agent, a script). It cannot reach into a hosted agent session.
- The consistency heuristic is deliberately simple and explainable (negation plus shared terms, newest statement per source wins). It catches the obvious reversal; it will miss subtle contradictions and can false-positive on unusual phrasing. Model review narrows that gap but stays advisory.
- Read and write sets are declared by the operator, not discovered from a repository.
- Live Linear coverage is the selected issue plus one hop of parent, blocking, and related links.
- The control API is unauthenticated and listens on `127.0.0.1`. Do not expose it. Production use needs authentication, durable multi-process storage, deeper graph coverage, and reconciliation.

## Source map

`src/engine.js` — leases, facts, the five checks, invariants, audit. `src/semantic.js` — optional model consistency review and drift explanation. `src/linear.js` — issue graph reads and the intervention comment. `src/server.js` — gate, signed webhook, state, UI. `bin/` — the three wrappers. `public/` — the control surface. `test/` — engine and HTTP checks, including a real paused process. Runtime state lives in ignored `data/state.json`.
