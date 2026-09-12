# Airlock · two-minute demo

Everything in this run is real: real Linear issues in your workspace, a real comment you post in Linear, a real process paused by SIGSTOP.

## Pre-flight (10 minutes before recording)

1. **Fresh issues.** Run `npm run linear:seed`. It creates a new parent, policy, contract, task, and UI issue in Linear and prints the task id (for example `SAR-13`). Use that id below; never reuse a task you already demoed, because its policy issue already has the comment.
2. **Server.** `npm start`, then open http://127.0.0.1:3000. Confirm the top bar says SAMPLE DATA and no toast errors appear.
3. **Windows.** Arrange three: the Airlock dashboard (main), Linear open on the new *policy* issue ("Security policy: token storage"), and a terminal in the project folder. Record the dashboard and terminal; switch to Linear only for the comment.
4. **Import.** In the dashboard's Import box, enter the task id and click Import. The badge flips to LIVE LINEAR DATA and the graph shows four nodes: task, parent, constraint, dependency. Leave it here. Do **not** create the lease yet.
5. **Terminal.** Have this ready to paste (fill the lease id after step 2 of the script):

```bash
node bin/guarded-session.js LEASE_ID -- node -e "let i=0;setInterval(()=>console.log('agent step',++i,'editing auth/session'),1000)"
```

   That stand-in prints one line per second so the pause is visible on camera. If you have the Codex CLI, use `codex exec "implement the task"` instead. Say which it is.

6. **Reset the sample scenario** for the collision beat: it resets itself when you click Agent collision, nothing to do.

## Script

Times are targets. Speak the bold lines; the rest is what you do.

### 0:00 – 0:15 · The problem

Dashboard, graph panel in view.

**"A coding agent reads a ticket, plans, and starts working. Then a human changes a requirement on a parent issue, a security policy, or an API contract the ticket depends on. The agent's reasoning wasn't wrong. Its world became wrong underneath it. Airlock is a control plane that catches that moment."**

Point at the graph. **"This is a real Linear issue, its parent, the security policy that constrains it, and the API contract it depends on. Airlock derives a watch set from those links."**

### 0:15 – 0:35 · The context lease

Set write set `auth/session, database/tokens`, click **Lease imported issue**. Open the facts table.

**"Delegating the task issues a context lease: a versioned snapshot of the requirement, the constraints, the dependency, and the authority we delegated. Every fact has a source, an author, a timestamp, and a version hash. These are the facts under which this agent is authorized to proceed."**

Click **Copy lease id**, paste it into the terminal command, run it. The terminal shows `started pid …` and the agent lines start ticking. The lease card shows **▶ running**.

**"That's a real process running under the lease."**

### 0:35 – 0:50 · The gate passes

Action: Open draft PR. Click **Check action**.

**"Before any consequential action, Airlock re-reads every watched source from Linear and runs four independent checks: freshness, consistency, provenance, authority, plus concurrency with other agents. Five green. Not one score; four explicit answers."**

### 0:50 – 1:15 · The world changes

Switch to Linear, on the policy issue. Post the comment:

> Security review complete: refresh tokens must never be persisted. Use session cookies only.

Switch back. Click **Check action** again.

**"Security just changed the policy in Linear. Same action, same agent, same plan."**

The gate shows DENIED · STALE_CONTEXT · I1. The lease card shows the timeline: planned at, changed at, checked at. The diff shows the added constraint and "now contradicts." The terminal has stopped ticking and printed `PAUSED: context changed`. The pill reads **⏸ paused**.

**"Denied. The check at the top was correct. The action now would be wrong. That's time-of-check to time-of-use, and Airlock closes the window. The process itself is paused with SIGSTOP. And the invariant it enforced is named: no agent executes on invalidated context."**

### 1:15 – 1:40 · Re-plan, the right way

Click **Review & re-plan** without changing anything. Toast: refused.

**"You can't just re-plan. A human has to revise the task against the new decision."**

Switch to Linear, edit the task description to:

> Implement session-cookie authentication. Do not persist refresh tokens. Touch auth/session and database/tokens only to remove token storage.

Back to the dashboard. Click **Review & re-plan**. The lease becomes rev 2. Click **Check action**. Five green. The terminal prints `RESUMED under rev 2` and the lines tick again. Pill: **▶ running**.

**"Revision two, consistent with the new policy. The process resumes. And the audit table ties every decision to the exact revision and fact versions behind it: who knew what, decided what, acted when."**

### 1:40 – 2:00 · Two agents

Sidebar: **Agent collision**. Click **Start two agents**. Select Codex B, action Change API contract, **Check action**.

**"Multi-agent. A reads the API contract to build the UI. B is delegated to change that contract. Denied: B's write set intersects A's read set. Optimistic concurrency control, for agents."**

Click **Release lease** on Codex A. Check action for B again. Allowed.

**"Agents shouldn't just validate context before they reason. They should validate that the world they reasoned about is still the world they're about to act on. That's Airlock."**

## If something goes wrong

- **Import fails.** Check `.env` has the key and the server was restarted after editing it. `npm run linear:check` confirms auth.
- **Gate still allows after the comment.** Give Linear a second and click Check action again; the consequential gate syncs on every call.
- **Re-plan says "Revise the agent task."** Linear hasn't saved your edit yet, or you edited a different issue. The task description must differ from the one in the lease.
- **Terminal never pauses.** The guard polls every 2 s; wait one beat. It only pauses on lease invalidation, which happens on the Check action click, not on the comment itself.
- **Out of time.** Cut the collision beat. The drift loop is the thesis.

## Fallback: sample data only

If Linear is down, the same script works on the Requirement drift sample scenario. Use **Post decision** instead of commenting in Linear, and the **Use session cookies** preset instead of editing in Linear. Say so on camera.
