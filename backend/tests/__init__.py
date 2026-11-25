"""Backend self-checks. Security state (sessions, sign-in limiter, audit log, vault key) lives in a temp dir per run."""
import os
import tempfile

_state = tempfile.mkdtemp(prefix="solardeck-test-state-")
for _key, _name in (("SESSIONS_FILE", "sessions.json"), ("LOGIN_FAILURES_FILE", "login_failures.json"),
                    ("AUDIT_LOG_FILE", "audit_log.jsonl"), ("VAULT_KEY_FILE", ".vault.key"),
                    ("SECURITY_FILE", "security.json")):
    os.environ.setdefault(_key, os.path.join(_state, _name))


def step_up(client, password: str = "pw") -> None:
    """Destructive endpoints need a step-up token bound to the current session; send it on every request."""
    r = client.post("/api/auth/step-up", json={"password": password})
    assert r.status_code == 200, r.text
    client.headers["X-Step-Up-Token"] = r.json()["step_up_token"]
