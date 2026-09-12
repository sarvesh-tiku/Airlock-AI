# Airlock

**What we built:** Airlock is a control plane for coding agents delegated from Linear. It answers one question: *when does previously correct context become unsafe to act on?* Each agent gets a **context lease**: a versioned snapshot of the requirement, the constraints, the dependencies, and the authority it was delegated, every fact with source, author, timestamp, and version. Airlock revalidates the lease at three safety boundaries: at delegation, when a watched source changes (webhook or sync), and immediately before a consequential action. A pre-action gate runs four independent checks (freshness, consistency, provenance, authority) plus optimistic concurrency control across agents, names the invariant it enforced, and writes an audit record with every fact version behind the decision. Two opt-in wrappers put a real process under a lease: one gates a single command, the other pauses a running agent with `SIGSTOP` when its context is invalidated and resumes it after a clean re-plan.

**Why this context matters:** Linear is where the decisions that invalidate in-progress work actually happen: a security comment on a policy issue, a contract change on a blocking issue, a revised parent. Airlock reads that graph, derives each agent's watch set from it, and propagates a single human decision to every dependent agent at once.

**Two-minute demo:**

1. **0:00–0:20:** Show `AIR-103` (persist refresh tokens) with its links: parent `AIR-100`, constrained by `SEC-21`, depends on `AIR-138`. Delegate it to Codex. Open the lease: six facts with provenance, a four-issue watch set, consistency check passed.
2. **0:20–0:40:** Gate *Open draft PR*: five green checks. Start `guarded-session` in a terminal on the lease. Post the security decision on `SEC-21`: never persist refresh tokens.
3. **0:40–1:05:** The lease is invalidated with a diff: one constraint added, and "AIR-103 now contradicts SEC-21." The terminal prints `PAUSED` and the process is stopped. Gate again: `STALE_CONTEXT · I1`, planned-at and changed-at timestamps. Re-plan without touching the ticket: refused.
4. **1:05–1:35:** Revise the ticket to *keep* refresh tokens, re-plan: rev 2 is issued but the gate returns `INCONSISTENT_CONTEXT`; the process stays paused. Revise to session cookies, re-plan: rev 3, five green checks, terminal prints `RESUMED`. Show the audit table: each decision tied to a revision and fact versions.
5. **1:35–2:00:** Switch to Agent collision. Codex A reads the API contract; Codex B is delegated to change it. B's `change-api-contract` is denied `AGENT_COLLISION · I4` because B's write set intersects A's read set. Release A; B proceeds. Close on the five invariants in the sidebar.

**Stack:** Node 22, no dependencies. Linear GraphQL API and signed webhooks. OpenAI Responses API for optional advisory consistency review and drift explanation (routable through OpenRouter via `OPENAI_BASE_URL`). Everything that decides allow/deny is deterministic.

**Submission checklist:** publish the source as a public GitHub repository, record the two-minute demo, and make a public social post tagging the event sponsors. The source is ready; these external steps require the team's accounts and media.
