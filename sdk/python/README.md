# Airlock Python client

Zero-dependency client for agents written in Python. Copy `airlock.py` next to your agent or `pip install -e sdk/python`.

```python
from airlock import Airlock, ActionDenied

airlock = Airlock()  # AIRLOCK_URL or http://127.0.0.1:3000
lease = airlock.create_lease("ENG-142", agent="my-agent", write_set=["auth/**"])

@airlock.guarded(lease.id, "open-pr", ["auth/session"])
def open_pull_request():
    ...  # runs only if the gate allows, checked at call time

try:
    open_pull_request()
except ActionDenied as denied:
    print(denied.decision.code, denied.decision.failing().detail)
```

CLI, same contract as the Node wrappers:

```bash
python -m airlock lease ENG-142 my-agent --write "auth/**"
python -m airlock gate LEASE_ID open-pr auth/session
python -m airlock run LEASE_ID open-pr auth/session -- gh pr create --draft
python -m airlock session LEASE_ID -- python agent.py     # SIGSTOP on invalidation, SIGCONT after re-plan
```

Tests spawn a real Airlock server: `python3 -m unittest discover -s sdk/python` from the repository root.
