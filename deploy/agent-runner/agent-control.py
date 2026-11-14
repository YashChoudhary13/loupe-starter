#!/usr/bin/env python3
"""Qimati agent control (D170): the Canada server's voice on Loupe's /enhance page.

Every ten seconds it tells Loupe what the server is doing (Claude and Codex limits, the runner's state, the tail
of its log) and carries out the few fixed requests the page may send back: pause, resume, try now, and the two
sign-ins. It never runs text from Loupe as a command; a sign-in code is written to the waiting `claude auth login`
and nowhere else.

  agent-control.py            run for ever (systemd unit qimati-agent-control)
  agent-control.py --limits   print the limits once as JSON (the runner asks after a pass)

Standard library only. Reads /etc/qimati-agent/runner.env through systemd's EnvironmentFile.
"""
import base64, datetime, fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time, urllib.error, urllib.request

HOME = os.path.expanduser("~")
WORK_DIR = os.environ.get("WORK_DIR", os.path.join(HOME, "agent-batches"))
STATE_DIR = os.environ.get("STATE_DIR", os.path.join(WORK_DIR, ".state"))
RUNNER = os.environ.get("RUNNER_NAME", "canada-1")
BASE = os.environ.get("LOUPE_BASE_URL", "").rstrip("/")
SECRET = os.environ.get("AGENT_SECRET", "")
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
CODEX_BIN = os.environ.get("CODEX_BIN", "codex")
# The image seats, in the order the page names them: codex-1, codex-2. (~/.codex-3 is not an image seat.)
CODEX_HOMES = [os.path.expanduser(h) for h in os.environ.get("CODEX_HOMES", "~/.codex:~/.codex-2").split(":") if h]
LOG_FILE = os.path.join(WORK_DIR, "runner.log")
TICK, LIMITS_EVERY, LOGIN_TIMEOUT = 10, 120, 900
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-_]|\r")


def say(line):
    with open(LOG_FILE, "a") as f:
        f.write(f"{datetime.datetime.now(datetime.timezone.utc):%Y-%m-%dT%H:%M:%SZ} {line}\n")


def state_path(name):
    return os.path.join(STATE_DIR, name)


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def get_json(url, headers):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def epoch(value):
    if isinstance(value, (int, float)) and value > 0:
        return float(value)
    if isinstance(value, str):
        try:
            return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def window(seat, key, used, resets):
    e = epoch(resets)
    seat[key] = round(used) if isinstance(used, (int, float)) else None
    seat[key + "_resets_epoch"] = e
    seat[key + "_resets"] = datetime.datetime.fromtimestamp(e, datetime.timezone.utc).isoformat() if e else None


# ---------------------------------------------------------------------------------------------- limits

def claude_limits():
    seat = {"name": "Claude", "signed_in": False, "five_hour": None, "week": None, "error": None}
    cred = (load(os.path.join(HOME, ".claude", ".credentials.json")) or {}).get("claudeAiOauth") or {}
    if not cred.get("accessToken"):
        seat["error"] = "Needs a sign-in"
        return seat
    # 2026-11-14: the login file was rewritten with no refresh token and every batch failed until a new sign-in.
    fresh = float(cred.get("expiresAt") or 0) / 1000 > time.time()
    seat["signed_in"] = bool(cred.get("refreshToken")) or fresh
    if not seat["signed_in"]:
        seat["error"] = "The sign-in ran out and cannot renew itself"
        return seat
    if not fresh:
        return seat  # Claude Code renews the token the next time it runs; the numbers come back then
    try:
        d = get_json("https://api.anthropic.com/api/oauth/usage", {
            "Authorization": "Bearer " + cred["accessToken"], "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-cli"})
        window(seat, "five_hour", (d.get("five_hour") or {}).get("utilization"), (d.get("five_hour") or {}).get("resets_at"))
        window(seat, "week", (d.get("seven_day") or {}).get("utilization"), (d.get("seven_day") or {}).get("resets_at"))
    except urllib.error.HTTPError as e:
        if e.code == 401 and not cred.get("refreshToken"):
            seat["signed_in"], seat["error"] = False, "The sign-in was refused"
    except Exception:
        pass  # a network blip: keep the seat, show no numbers
    return seat


_codex_refreshed = {}


def codex_limits(index, home, refresh=True):
    seat = {"name": f"codex-{index + 1}", "signed_in": False, "five_hour": None, "week": None, "error": None, "account": None}
    tokens = (load(os.path.join(home, "auth.json")) or {}).get("tokens") or {}
    if not tokens.get("access_token"):
        seat["error"] = "Needs a sign-in"
        return seat
    try:
        part = tokens["id_token"].split(".")[1]
        seat["account"] = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))).get("email")
    except Exception:
        pass
    try:
        d = get_json("https://chatgpt.com/backend-api/wham/usage", {
            "Authorization": "Bearer " + tokens["access_token"], "chatgpt-account-id": tokens.get("account_id", ""), "User-Agent": "codex_cli_rs"})
        seat["signed_in"] = True
        limit = d.get("rate_limit") or {}
        for key, name in (("five_hour", "primary_window"), ("week", "secondary_window")):
            w = limit.get(name) or {}
            window(seat, key, w.get("used_percent"), w.get("reset_at"))
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            # A stale token: one small Codex call renews it. At most once an hour per seat.
            if refresh and time.time() - _codex_refreshed.get(home, 0) > 3600:
                _codex_refreshed[home] = time.time()
                try:
                    subprocess.run([CODEX_BIN, "exec", "--ignore-user-config", "--skip-git-repo-check", "ok"], env={**os.environ, "CODEX_HOME": home},
                                   cwd=HOME, capture_output=True, timeout=90)
                except Exception:
                    pass
                return codex_limits(index, home, refresh=False)
            seat["error"] = "The sign-in ran out"
        else:
            seat["signed_in"], seat["error"] = True, f"Limits not readable (HTTP {e.code})"
    except Exception:
        seat["signed_in"], seat["error"] = True, "Limits not readable just now"
    return seat


def read_limits():
    limits = {"at": time.time(), "claude": claude_limits(), "codex": [codex_limits(i, h) for i, h in enumerate(CODEX_HOMES)]}
    by_account = {}
    for seat in limits["codex"]:
        if seat["account"]:
            by_account.setdefault(seat["account"], []).append(seat)
    for seats in by_account.values():  # two homes on one account are one limit, not two (it happened in October)
        for seat in seats[1:]:
            seat["error"] = f"Same account as {seats[0]['name']}: one limit, not two"
    return limits


# ---------------------------------------------------------------------------------------------- sign-in

class Login:
    """One sign-in at a time, run under a terminal of its own so the tool behaves as it does for a person."""

    def __init__(self, target, argv, env):
        self.target, self.state, self.url, self.code, self.message = target, "starting", None, None, None
        self.started, self.done_at, self.buffer = time.time(), None, ""
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(HOME)
            os.execvpe(argv[0], argv, env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 4000, 0, 0))  # wide, so the link is never wrapped
        self.exit = None

    def pump(self):
        while self.exit is None:
            try:
                ready, _, _ = select.select([self.fd], [], [], 0)
                if not ready:
                    break
                chunk = os.read(self.fd, 65536)
            except OSError:
                chunk = b""
            if not chunk:
                break
            self.buffer = (self.buffer + ANSI.sub("", chunk.decode("utf-8", "replace")))[-20000:]
        if self.exit is None:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.exit = os.waitstatus_to_exitcode(status)

    def send(self, text):
        os.write(self.fd, text.encode())

    def stop(self):
        if self.exit is None:
            try:
                os.kill(self.pid, signal.SIGTERM)
                os.waitpid(self.pid, 0)
            except OSError:
                pass
            self.exit = -1
        try:
            os.close(self.fd)
        except OSError:
            pass

    def finish(self, ok, message):
        self.state, self.message, self.done_at = ("ok" if ok else "failed"), message, time.time()
        self.stop()
        say(f"sign-in for {self.target}: {'done' if ok else 'did not go through'}")

    def last_line(self):
        lines = [l.strip() for l in self.buffer.splitlines() if l.strip() and "http" not in l]
        return lines[-1][:200] if lines else None

    def view(self):
        return {"target": self.target, "state": self.state, "url": self.url, "code": self.code, "message": self.message}


def claude_signed_in():
    try:
        out = subprocess.run([CLAUDE_BIN, "auth", "status"], capture_output=True, text=True, timeout=30, cwd=HOME).stdout
        return json.loads(out).get("loggedIn") is True
    except Exception:
        return False


def codex_signed_in(home):
    try:
        return subprocess.run([CODEX_BIN, "login", "status"], env={**os.environ, "CODEX_HOME": home}, capture_output=True, timeout=30, cwd=HOME).returncode == 0
    except Exception:
        return False


def step_login(login):
    """Moves a running sign-in along. Returns True when the limits should be read again."""
    if login.state in ("ok", "failed"):
        return False
    login.pump()
    if time.time() - login.started > LOGIN_TIMEOUT:
        login.finish(False, "The sign-in was not finished in 15 minutes. Start again.")
        return False
    if login.state == "starting":
        urls = re.findall(r"https://[^\s\"'<>]+", login.buffer)
        if login.target == "claude":
            url = next((u for u in urls if "oauth" in u or "claude" in u or "anthropic" in u), None)
            if url:
                login.url, login.state = url, "awaiting_code"
        else:
            code = re.search(r"\b[A-Z0-9]{4,5}-[A-Z0-9]{4,6}\b", login.buffer)
            if urls and code:
                login.url, login.code, login.state = urls[0], code.group(0), "awaiting_code"
    if login.exit is not None:
        home = None if login.target == "claude" else CODEX_HOMES[int(login.target.split("-")[1]) - 1]
        ok = claude_signed_in() if home is None else codex_signed_in(home)
        login.finish(ok, None if ok else (login.last_line() or "The sign-in tool stopped. Start again."))
        return ok
    return False


# ---------------------------------------------------------------------------------------------- the loop

def runner_state(limits, hold, paused):
    if paused:
        return "paused"
    if limits["claude"]["signed_in"] is False or (hold and hold.get("reason") == "login"):
        return "login"
    if os.path.exists(state_path("current")):
        return "working"
    if hold and hold.get("reason") == "limit":
        return "limit"
    return "idle"


def log_tail(lines=60):
    try:
        with open(LOG_FILE, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - 16000))
            return "\n".join(f.read().decode("utf-8", "replace").splitlines()[-lines:])
    except OSError:
        return ""


def main():
    os.makedirs(STATE_DIR, exist_ok=True)
    limits, login, results, next_limits = None, None, [], 0
    while True:
        started = time.time()
        try:
            if login and step_login(login):
                next_limits = 0
                try:
                    os.remove(state_path("hold"))  # the sign-in is back: the queue may go on at once
                except OSError:
                    pass
            if login and login.done_at and time.time() - login.done_at > (60 if login.state == "ok" else 600):
                login = None
            if started >= next_limits:
                limits, next_limits = read_limits(), started + LIMITS_EVERY
                tmp = state_path("limits.json.tmp")
                with open(tmp, "w") as f:
                    json.dump(limits, f)
                os.replace(tmp, state_path("limits.json"))
            hold = load(state_path("hold"))
            if hold and float(hold.get("until") or 0) <= time.time():
                hold = None
            paused = os.path.exists(state_path("paused"))
            try:
                with open(state_path("current")) as f:
                    label = f.read().strip() or None
            except OSError:
                label = None
            if hold and hold.get("reason") == "login":
                limits["claude"]["signed_in"] = False
                limits["claude"]["error"] = limits["claude"]["error"] or "The last run was refused: sign in again"
            public = lambda seat: {k: v for k, v in seat.items() if not k.endswith("_epoch")}
            status = {
                "state": runner_state(limits, hold, paused), "paused": paused,
                "hold_until": datetime.datetime.fromtimestamp(hold["until"], datetime.timezone.utc).isoformat() if hold and hold.get("reason") == "limit" else None,
                "hold_reason": (hold or {}).get("note"), "job": {"label": label},
                "claude": public(limits["claude"]), "codex": [public(s) for s in limits["codex"]],
                "login": login.view() if login else None,
            }
            body = json.dumps({"runner": RUNNER, "status": status, "log": log_tail(), "results": results}).encode()
            req = urllib.request.Request(BASE + "/api/agent/runner", data=body, method="POST", headers={
                "Authorization": "Bearer " + SECRET, "Content-Type": "application/json", "User-Agent": "qimati-agent-runner"})
            with urllib.request.urlopen(req, timeout=20) as r:
                commands = json.load(r).get("commands") or []
            results = []
            for c in commands:
                ok, text = True, "Done."
                kind, payload = c.get("kind"), c.get("payload") or {}
                try:
                    if kind == "pause":
                        open(state_path("paused"), "w").close(); say("paused from Loupe: nothing new starts until Resume")
                    elif kind == "resume":
                        if os.path.exists(state_path("paused")):
                            os.remove(state_path("paused")); say("resumed from Loupe")
                    elif kind == "try_now":
                        if os.path.exists(state_path("hold")):
                            os.remove(state_path("hold"))
                        next_limits = 0; say("asked from Loupe to try now")
                    elif kind in ("claude_login_start", "codex_login_start"):
                        if login:
                            login.stop()
                        if kind == "claude_login_start":
                            login = Login("claude", [CLAUDE_BIN, "auth", "login", "--claudeai"], {**os.environ, "BROWSER": "/bin/false"})
                        else:
                            seat = str(payload.get("seat", ""))
                            if not re.fullmatch(r"codex-[1-9]", seat) or int(seat[-1]) > len(CODEX_HOMES):
                                raise ValueError("There is no such Codex seat.")
                            login = Login(seat, [CODEX_BIN, "login", "--device-auth"], {**os.environ, "CODEX_HOME": CODEX_HOMES[int(seat[-1]) - 1]})
                        say(f"sign-in for {login.target} started from Loupe")
                    elif kind == "claude_login_code":
                        code = str(payload.get("code", ""))
                        if not (login and login.target == "claude" and login.state == "awaiting_code"):
                            raise ValueError("No Claude sign-in is waiting for a code. Start the sign-in again.")
                        if not re.fullmatch(r"[A-Za-z0-9_-]{8,200}(#[A-Za-z0-9_-]{8,200})?", code):
                            raise ValueError("That does not look like the code from the sign-in page.")
                        login.send(code + "\r"); login.state = "checking"
                    elif kind == "login_cancel":
                        if login:
                            login.stop(); say(f"sign-in for {login.target} cancelled"); login = None
                    else:
                        raise ValueError("Unknown request.")
                except Exception as e:  # the answer goes back to the page; the code itself is never echoed
                    ok, text = False, str(e)[:200]
                results.append({"id": c.get("id"), "ok": ok, "result": text})
        except Exception as e:
            print(f"tick failed: {type(e).__name__}: {str(e)[:200]}", file=sys.stderr, flush=True)
        time.sleep(max(1, (3 if login and login.state in ("starting", "checking") else TICK) - (time.time() - started)))


if __name__ == "__main__":
    if "--limits" in sys.argv:
        print(json.dumps(read_limits()))
    else:
        if not BASE or not SECRET:
            sys.exit("LOUPE_BASE_URL and AGENT_SECRET are required")
        main()
