"""
loupe-worker run --kinds sync,identify --daemon        (daytime: answer Identify within seconds)
loupe-worker run --kinds sync,embed --until-empty       (nightly: bring the index up to date)

Configuration from the environment (or worker/.env):
  LOUPE_BASE_URL   https://loupe.qimati-eng.site
  WORKER_SECRET    the same value as WORKER_SECRET on the server
  WORKER_ID        a name for this machine, e.g. yash-laptop
  LOUPE_LOCAL_ROOT where originals are kept, e.g. D:\\loupe
  LOUPE_WEIGHTS    path to siglip2_so400m_512_visual.safetensors (default: worker/weights/)
"""
from __future__ import annotations

import argparse
import logging
import os
import platform
import signal
import sys
import time

from dotenv import load_dotenv

from . import __version__
from .api import LoupeApi, LoupeApiError
from .jobs import run_job
from .store import LocalStore

log = logging.getLogger("loupe-worker")
HEARTBEAT_SECONDS = 30


def env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if value is None or not value.strip():
        print(f"{name} is not set. See worker/README.md.", file=sys.stderr)
        sys.exit(2)
    return value.strip()


def main(argv: list[str] | None = None) -> int:
    load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))
    parser = argparse.ArgumentParser(prog="loupe-worker")
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="claim and process jobs")
    run.add_argument("--kinds", default="sync,identify", help="comma-separated: sync, embed, identify")
    run.add_argument("--daemon", action="store_true", help="keep polling until stopped")
    run.add_argument("--until-empty", action="store_true", help="stop when the queue has nothing for these kinds")
    run.add_argument("--poll", type=float, default=3.0, help="seconds between empty polls")
    run.add_argument("--device", default="cuda", choices=["cuda", "cpu"])
    run.add_argument("--threads", type=int, default=None, help="torch CPU threads (CPU fallback)")
    run.add_argument("--claim-delay", type=float, default=0.0, help="seconds to wait before claiming (lets a GPU worker win)")
    run.add_argument("--max-jobs", type=int, default=0, help="stop after this many jobs (0 = no limit)")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    kinds = [k.strip() for k in args.kinds.split(",") if k.strip()]
    api = LoupeApi(env("LOUPE_BASE_URL"), env("WORKER_SECRET"), env("WORKER_ID", platform.node()))
    store = LocalStore(env("LOUPE_LOCAL_ROOT"))

    vision = None
    if any(k in ("embed", "identify") for k in kinds):
        from .vision import Vision, default_weights_path

        weights = default_weights_path()
        if not weights.exists():
            print(f"weights not found at {weights}; run get-weights.py first.", file=sys.stderr)
            return 2
        vision = Vision(weights, device=args.device, threads=args.threads)
        log.info("model ready on %s in %.1fs", vision.device, vision.load_seconds)

    device = vision.device if vision else "none"
    stop = False

    def on_signal(*_):
        nonlocal stop
        stop = True
        log.info("stopping after the current job")

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    last_heartbeat = 0.0
    done = 0
    while not stop:
        now = time.time()
        if now - last_heartbeat >= HEARTBEAT_SECONDS:
            try:
                api.heartbeat(device, kinds, __version__)
                last_heartbeat = now
            except LoupeApiError as exc:
                log.warning("heartbeat: %s", exc)
                if not exc.retryable:
                    return 2
                time.sleep(args.poll)
                continue
        try:
            if args.claim_delay:
                time.sleep(args.claim_delay)
            job = api.claim(kinds)
        except LoupeApiError as exc:
            log.warning("claim: %s", exc)
            if not exc.retryable:
                return 2
            time.sleep(max(args.poll, 5))
            continue
        if job is None:
            if args.until_empty or not args.daemon:
                log.info("queue empty for %s; %d job(s) done", ",".join(kinds), done)
                return 0
            time.sleep(args.poll)
            continue
        run_job(job, api, store, vision)
        done += 1
        if args.max_jobs and done >= args.max_jobs:
            log.info("stopping after %d job(s)", done)
            return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
