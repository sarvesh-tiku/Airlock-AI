"""Airlock client for Python agents.

Airlock is a control plane that binds a coding agent's actions to a versioned
context lease. This module lets a Python agent (LangGraph, CrewAI, a plain
script, anything) take part in that contract:

    from airlock import Airlock, ActionDenied

    airlock = Airlock()                      # AIRLOCK_URL or http://127.0.0.1:3000
    lease = airlock.create_lease("ENG-142", agent="my-agent", write_set=["auth/**"])

    @airlock.guarded(lease.id, "open-pr", ["auth/session"])
    def open_pull_request():
        ...                                  # only runs if the gate allows

    airlock.guard_session(lease.id, ["python", "agent.py"])   # SIGSTOP on invalidation

Everything here is thin: the decisions are made by the Airlock server. The
client never turns a denial into an allow, and it fails closed when Airlock
cannot be reached.

The module has no third-party dependencies.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from functools import wraps
from typing import Any, Callable, Iterable, Sequence

__all__ = [
    "Airlock",
    "AirlockError",
    "AirlockUnavailable",
    "ActionDenied",
    "Check",
    "Decision",
    "Fact",
    "Lease",
    "CONSEQUENTIAL_ACTIONS",
    "LIGHT_ACTIONS",
]

DEFAULT_URL = os.environ.get("AIRLOCK_URL", "http://127.0.0.1:3000")
CONSEQUENTIAL_ACTIONS = ("open-pr", "merge", "deploy", "modify-schema", "change-api-contract", "close-issue")
LIGHT_ACTIONS = ("edit-files", "run-tests", "read")


# --------------------------------------------------------------------------- errors


class AirlockError(RuntimeError):
    """Base class for client errors."""


class AirlockUnavailable(AirlockError):
    """Airlock could not be reached. Callers must treat this as a denial."""


class ActionDenied(AirlockError):
    """The gate refused the action. ``decision`` carries the full result."""

    def __init__(self, decision: "Decision"):
        super().__init__(f"Airlock denied {decision.action}: {decision.reason}")
        self.decision = decision


# --------------------------------------------------------------------------- models


@dataclass(frozen=True)
class Check:
    """One of the gate's independent checks."""

    name: str
    ok: bool
    detail: str
    code: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Check":
        return cls(name=data["name"], ok=bool(data["ok"]), detail=data.get("detail", ""), code=data.get("code"))


@dataclass(frozen=True)
class Decision:
    """The result of a gate call. ``allowed`` is the only field that authorizes anything."""

    allowed: bool
    code: str
    reason: str
    tier: str
    invariant: str | None
    checks: tuple[Check, ...]
    issue_id: str
    lease_id: str
    revision: int
    agent: str
    action: str
    resources: tuple[str, ...]
    at: str
    analysis: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Decision":
        return cls(
            allowed=bool(data["allowed"]),
            code=data["code"],
            reason=data.get("reason", ""),
            tier=data.get("tier", "consequential"),
            invariant=data.get("invariant"),
            checks=tuple(Check.from_dict(c) for c in data.get("checks", [])),
            issue_id=data["issueId"],
            lease_id=data["leaseId"],
            revision=int(data.get("revision", 1)),
            agent=data.get("agent", ""),
            action=data.get("action", ""),
            resources=tuple(data.get("resources", [])),
            at=data.get("at", ""),
            analysis=data.get("analysis"),
        )

    def failing(self) -> Check | None:
        """The first failing check, which is the one that decided."""
        return next((c for c in self.checks if not c.ok), None)


@dataclass(frozen=True)
class Fact:
    """A single attributed statement inside a lease."""

    id: str
    kind: str
    text: str
    source_issue: str | None
    source_field: str
    author: str | None
    at: str | None
    version: str
    confidence: float

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Fact":
        source = data.get("source") or {}
        return cls(
            id=data["id"],
            kind=data["kind"],
            text=data.get("text", ""),
            source_issue=source.get("issueId"),
            source_field=source.get("field", ""),
            author=data.get("author"),
            at=data.get("at"),
            version=data.get("version", ""),
            confidence=float(data.get("confidence", 0)),
        )


@dataclass
class Lease:
    """A versioned context snapshot for one agent on one issue."""

    id: str
    issue_id: str
    agent: str
    status: str
    revision: int
    watches: dict[str, str]
    read_set: list[str]
    write_set: list[str]
    allowed_actions: list[str]
    denied_actions: list[str]
    facts: list[Fact] = field(default_factory=list)
    consistency: str = "unknown"
    changed_sources: list[str] = field(default_factory=list)
    drift: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Lease":
        return cls(
            id=data["id"],
            issue_id=data["issueId"],
            agent=data["agent"],
            status=data["status"],
            revision=int(data.get("revision", 1)),
            watches=dict(data.get("watches", {})),
            read_set=list(data.get("readSet", [])),
            write_set=list(data.get("writeSet", [])),
            allowed_actions=list(data.get("allowedActions", [])),
            denied_actions=list(data.get("deniedActions", [])),
            facts=[Fact.from_dict(f) for f in data.get("facts", [])],
            consistency=(data.get("consistency") or {}).get("status", "unknown"),
            changed_sources=list(data.get("changedSources", [])),
            drift=[d.get("explanation", "") for d in data.get("drift", [])],
        )

    @property
    def active(self) -> bool:
        return self.status == "active"

    def facts_of(self, kind: str) -> list[Fact]:
        return [f for f in self.facts if f.kind == kind]


# --------------------------------------------------------------------------- client


class Airlock:
    """HTTP client for the Airlock control plane."""

    def __init__(self, base_url: str = DEFAULT_URL, timeout: float = 8.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    # -- transport -----------------------------------------------------------

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(
            f"{self.base_url}{path}", data=data, method=method, headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as error:
            try:
                payload = json.loads(error.read() or b"{}")
            except ValueError:
                payload = {}
            raise AirlockError(payload.get("error") or f"HTTP {error.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise AirlockUnavailable(str(error)) from None

    # -- workspace -----------------------------------------------------------

    def state(self) -> dict[str, Any]:
        return self._request("GET", "/api/state")

    def audit(self) -> list[dict[str, Any]]:
        return self._request("GET", "/api/audit").get("audit", [])

    def invariants(self) -> list[dict[str, Any]]:
        return self._request("GET", "/api/invariants").get("invariants", [])

    # -- leases --------------------------------------------------------------

    def lease(self, lease_id: str) -> Lease:
        return Lease.from_dict(self._request("GET", f"/api/leases/{lease_id}"))

    def create_lease(
        self,
        issue_id: str,
        agent: str,
        read_set: Iterable[str] = (),
        write_set: Iterable[str] = (),
        allowed_actions: Iterable[str] | None = None,
        denied_actions: Iterable[str] | None = None,
        operator: str | None = None,
    ) -> Lease:
        body: dict[str, Any] = {
            "issueId": issue_id,
            "agent": agent,
            "readSet": list(read_set),
            "writeSet": list(write_set),
        }
        if allowed_actions is not None:
            body["allowedActions"] = list(allowed_actions)
        if denied_actions is not None:
            body["deniedActions"] = list(denied_actions)
        if operator:
            body["operator"] = operator
        return Lease.from_dict(self._request("POST", "/api/leases", body))

    def release(self, lease_id: str) -> Lease:
        return Lease.from_dict(self._request("POST", "/api/leases/release", {"leaseId": lease_id}))

    def replan(self, lease_id: str) -> Lease:
        """Issue the next revision. Raises AirlockError until the task has been revised."""
        return Lease.from_dict(self._request("POST", "/api/leases/replan", {"leaseId": lease_id}))

    # -- the gate ------------------------------------------------------------

    def gate(self, lease_id: str, action: str, resources: Iterable[str] = ()) -> Decision:
        """Ask the gate. Returns the decision without raising."""
        return Decision.from_dict(
            self._request("POST", "/api/gate", {"leaseId": lease_id, "action": action, "resources": list(resources)})
        )

    def require(self, lease_id: str, action: str, resources: Iterable[str] = ()) -> Decision:
        """Ask the gate and raise ActionDenied unless it allows. Unreachable Airlock also raises."""
        decision = self.gate(lease_id, action, resources)
        if not decision.allowed:
            raise ActionDenied(decision)
        return decision

    def guarded(self, lease_id: str, action: str, resources: Iterable[str] = ()) -> Callable:
        """Decorator: the wrapped function runs only when the gate allows, checked at call time."""
        resources = list(resources)

        def decorator(function: Callable) -> Callable:
            @wraps(function)
            def wrapper(*args: Any, **kwargs: Any) -> Any:
                self.require(lease_id, action, resources)
                return function(*args, **kwargs)

            return wrapper

        return decorator

    def run_guarded(self, lease_id: str, action: str, resources: Sequence[str], argv: Sequence[str]) -> int:
        """Run a command only if the gate authorizes the action immediately beforehand."""
        try:
            decision = self.require(lease_id, action, resources)
        except ActionDenied as denied:
            print(f"Airlock denied {action}: {denied.decision.reason}", file=sys.stderr)
            return 1
        except AirlockUnavailable as error:
            print(f"Airlock unavailable; command blocked: {error}", file=sys.stderr)
            return 1
        print(f"Airlock authorized {action} for {decision.issue_id} (rev {decision.revision}).", file=sys.stderr)
        return subprocess.call(list(argv))

    # -- session guard -------------------------------------------------------

    def _heartbeat(self, lease_id: str, pid: int, command: str, state: str) -> None:
        try:
            self._request("POST", "/api/sessions", {"leaseId": lease_id, "pid": pid, "command": command, "state": state})
        except AirlockError:
            pass  # informational only; enforcement is the signal below

    def guard_session(self, lease_id: str, argv: Sequence[str], poll_seconds: float = 2.0) -> int:
        """Run a long-lived agent process under a lease.

        When the lease is invalidated the process receives SIGSTOP. When the lease is
        re-planned cleanly it receives SIGCONT. A released lease, or an Airlock that
        stays unreachable, terminates the process. Returns the process exit code.
        """
        try:
            lease = self.lease(lease_id)
        except AirlockError as error:
            print(f"[airlock] cannot verify lease before start; refusing to run: {error}", file=sys.stderr)
            return 1
        if not lease.active:
            print(f"[airlock] lease is {lease.status}; refusing to start", file=sys.stderr)
            return 1
        if lease.consistency == "contradiction":
            print("[airlock] lease context is contradictory; refusing to start", file=sys.stderr)
            return 1

        process = subprocess.Popen(list(argv))
        command = " ".join(argv)
        revision = lease.revision
        paused = False
        failures = 0
        announced_contradiction = None
        print(
            f"[airlock] session for {lease.agent} on {lease.issue_id} (rev {revision}) started pid {process.pid}; "
            f"polling every {poll_seconds:g}s",
            file=sys.stderr,
        )
        self._heartbeat(lease_id, process.pid, command, "running")

        def forward(signum: int, _frame: Any) -> None:
            process.send_signal(signum)

        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, forward)

        try:
            while process.poll() is None:
                time.sleep(poll_seconds)
                if process.poll() is not None:
                    break
                try:
                    current = self.lease(lease_id)
                    failures = 0
                except AirlockError as error:
                    failures += 1
                    if failures >= 3:
                        print(f"[airlock] Airlock unreachable ({error}); terminating session", file=sys.stderr)
                        process.terminate()
                    continue

                if current.status == "released":
                    print("[airlock] lease released; terminating session", file=sys.stderr)
                    process.terminate()
                    continue
                self._heartbeat(lease_id, process.pid, command, "paused" if paused else "running")

                if current.status == "invalid" and not paused:
                    paused = True
                    process.send_signal(signal.SIGSTOP)
                    self._heartbeat(lease_id, process.pid, command, "paused")
                    why = current.drift[0] if current.drift else "Re-plan before continuing."
                    print(f"[airlock] PAUSED: context changed ({', '.join(current.changed_sources)}). {why}", file=sys.stderr)
                elif current.active and paused and current.revision > revision:
                    if current.consistency == "contradiction":
                        if announced_contradiction != current.revision:
                            announced_contradiction = current.revision
                            print(f"[airlock] still paused: rev {current.revision} contradicts a constraint", file=sys.stderr)
                        continue
                    paused = False
                    revision = current.revision
                    process.send_signal(signal.SIGCONT)
                    self._heartbeat(lease_id, process.pid, command, "running")
                    print(f"[airlock] RESUMED under rev {revision}. Re-read the task before acting.", file=sys.stderr)
        finally:
            if process.poll() is None:
                process.wait()
            self._heartbeat(lease_id, process.pid, command, "exited")
        return process.returncode or 0


# --------------------------------------------------------------------------- CLI


def _split_command(argv: list[str]) -> tuple[list[str], list[str]]:
    if "--" not in argv:
        return argv, []
    index = argv.index("--")
    return argv[:index], argv[index + 1 :]


def main(argv: Sequence[str] | None = None) -> int:
    """``python -m airlock`` entry point."""
    raw = list(sys.argv[1:] if argv is None else argv)
    head, command = _split_command(raw)
    parser = argparse.ArgumentParser(prog="airlock", description="Airlock context-lease client")
    parser.add_argument("--url", default=DEFAULT_URL, help="Airlock base URL (default: AIRLOCK_URL or localhost:3000)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    gate = sub.add_parser("gate", help="check an action; exit 0 if allowed, 1 if denied")
    gate.add_argument("lease")
    gate.add_argument("action")
    gate.add_argument("resources", nargs="*")

    run = sub.add_parser("run", help="run COMMAND (after --) only if the gate allows")
    run.add_argument("lease")
    run.add_argument("action")
    run.add_argument("resources", nargs="*")

    session = sub.add_parser("session", help="run COMMAND (after --) under the lease; pause on invalidation")
    session.add_argument("lease")
    session.add_argument("--poll", type=float, default=float(os.environ.get("AIRLOCK_POLL_MS", "2000")) / 1000)

    lease_cmd = sub.add_parser("lease", help="create a lease")
    lease_cmd.add_argument("issue")
    lease_cmd.add_argument("agent")
    lease_cmd.add_argument("--read", default="", help="comma-separated read set")
    lease_cmd.add_argument("--write", default="", help="comma-separated write set")
    lease_cmd.add_argument("--allow", default="", help="comma-separated allowed actions")

    show = sub.add_parser("show", help="print a lease")
    show.add_argument("lease")

    args = parser.parse_args(head)
    client = Airlock(args.url)
    csv = lambda value: [v.strip() for v in value.split(",") if v.strip()]  # noqa: E731

    try:
        if args.cmd == "gate":
            decision = client.gate(args.lease, args.action, args.resources)
            print(json.dumps(decision.__dict__, default=lambda o: o.__dict__, indent=2))
            return 0 if decision.allowed else 1
        if args.cmd == "run":
            if not command:
                parser.error("run needs a command after --")
            return client.run_guarded(args.lease, args.action, args.resources, command)
        if args.cmd == "session":
            if not command:
                parser.error("session needs a command after --")
            return client.guard_session(args.lease, command, args.poll)
        if args.cmd == "lease":
            lease = client.create_lease(
                args.issue, args.agent, csv(args.read), csv(args.write), csv(args.allow) or None
            )
            print(lease.id)
            return 0
        if args.cmd == "show":
            lease = client.lease(args.lease)
            print(f"{lease.agent} on {lease.issue_id} rev {lease.revision} [{lease.status}] consistency={lease.consistency}")
            for fact in lease.facts:
                print(f"  {fact.kind:<11} {fact.source_issue or 'operator':<8} {fact.author or '-':<12} v{fact.version}  {fact.text[:80]}")
            return 0
    except AirlockUnavailable as error:
        print(f"Airlock unavailable; treating as denied: {error}", file=sys.stderr)
        return 1
    except AirlockError as error:
        print(f"Airlock error: {error}", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    sys.exit(main())
