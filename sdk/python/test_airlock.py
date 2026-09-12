"""Integration tests for the Python client against a real Airlock server.

Run from the repository root:  python3 -m unittest discover -s sdk/python
"""

from __future__ import annotations

import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from airlock import ActionDenied, Airlock, AirlockUnavailable  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
PORT = 34972
URL = f"http://127.0.0.1:{PORT}"


def process_state(pid: int) -> str:
    return subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()


class AirlockClientTests(unittest.TestCase):
    server: subprocess.Popen
    data_dir: str

    @classmethod
    def setUpClass(cls) -> None:
        cls.data_dir = tempfile.mkdtemp(prefix="airlock-py-")
        env = {**os.environ, "PORT": str(PORT), "AIRLOCK_DATA_DIR": cls.data_dir, "OPENAI_API_KEY": ""}
        cls.server = subprocess.Popen(["node", "src/server.js"], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            try:
                urllib.request.urlopen(f"{URL}/api/state", timeout=1)
                break
            except Exception:
                time.sleep(0.1)
        else:
            raise RuntimeError("Airlock server did not start")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.terminate()
        cls.server.wait(timeout=5)
        shutil.rmtree(cls.data_dir, ignore_errors=True)

    def setUp(self) -> None:
        self.client = Airlock(URL)
        self.client._request("POST", "/api/reset", {"scenario": "drift"})

    def test_lease_carries_typed_facts_with_provenance(self) -> None:
        lease = self.client.create_lease("AIR-103", "py-agent", write_set=["auth/session"])
        self.assertTrue(lease.active)
        self.assertEqual(sorted(lease.watches), ["AIR-100", "AIR-103", "AIR-138", "SEC-21"])
        self.assertEqual([f.kind for f in lease.facts], ["requirement", "constraint", "constraint", "constraint", "dependency", "authority"])
        self.assertTrue(all(f.version for f in lease.facts))
        self.assertEqual(lease.consistency, "consistent")

    def test_gate_and_decorator_follow_drift(self) -> None:
        lease = self.client.create_lease("AIR-103", "py-agent", write_set=["auth/session"])
        calls: list[str] = []

        @self.client.guarded(lease.id, "open-pr", ["auth/session"])
        def open_pr() -> str:
            calls.append("opened")
            return "ok"

        self.assertEqual(open_pr(), "ok")
        self.client._request("POST", "/api/decisions", {"issueId": "SEC-21", "body": "Refresh tokens must never be persisted."})
        with self.assertRaises(ActionDenied) as denied:
            open_pr()
        decision = denied.exception.decision
        self.assertEqual(decision.code, "STALE_CONTEXT")
        self.assertEqual(decision.invariant, "I1")
        self.assertEqual(decision.failing().name, "freshness")
        self.assertEqual(calls, ["opened"], "the wrapped function must not run after the denial")
        self.assertEqual(self.client.gate(lease.id, "merge", ["auth/session"]).code, "STALE_CONTEXT")

        with self.assertRaises(Exception):
            self.client.replan(lease.id)  # task not yet revised
        self.client._request("POST", "/api/issues/revise", {"issueId": "AIR-103", "description": "Use session cookies. Do not persist refresh tokens."})
        renewed = self.client.replan(lease.id)
        self.assertEqual(renewed.id, lease.id)
        self.assertEqual(renewed.revision, 2)
        self.assertEqual(open_pr(), "ok")
        self.assertEqual(self.client.gate(lease.id, "merge", ["auth/session"]).code, "OUT_OF_SCOPE")

    def test_session_guard_pauses_and_resumes_a_real_process(self) -> None:
        lease = self.client.create_lease("AIR-103", "py-agent", write_set=["auth/session"])
        guard = subprocess.Popen(
            [sys.executable, "-m", "airlock", "--url", URL, "session", lease.id, "--poll", "0.1", "--", sys.executable, "-c", "import time; time.sleep(60)"],
            cwd=pathlib.Path(__file__).parent, stderr=subprocess.PIPE, text=True,
        )
        try:
            line = guard.stderr.readline()
            self.assertIn("started pid", line)
            pid = int(line.split("started pid ")[1].split(";")[0])
            self.client._request("POST", "/api/decisions", {"issueId": "SEC-21", "body": "Refresh tokens must never be persisted."})
            self.assertIn("PAUSED", guard.stderr.readline())
            time.sleep(0.2)
            self.assertTrue(process_state(pid).startswith("T"), "child should be stopped")
            sessions = self.client.state()["sessions"]
            self.assertEqual(sessions[str(pid)]["state"], "paused")
            self.client._request("POST", "/api/issues/revise", {"issueId": "AIR-103", "description": "Use session cookies. Do not persist refresh tokens."})
            self.client.replan(lease.id)
            self.assertIn("RESUMED under rev 2", guard.stderr.readline())
            time.sleep(0.2)
            self.assertFalse(process_state(pid).startswith("T"), "child should be running again")
        finally:
            guard.kill()
            guard.wait(timeout=5)
            guard.stderr.close()

    def test_unreachable_airlock_is_a_denial(self) -> None:
        offline = Airlock("http://127.0.0.1:1", timeout=0.5)
        with self.assertRaises(AirlockUnavailable):
            offline.require("nope", "open-pr", ["auth/session"])


if __name__ == "__main__":
    unittest.main()
