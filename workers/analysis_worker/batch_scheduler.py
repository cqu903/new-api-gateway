import os
import time
from datetime import datetime, timezone

from offline import rebuild_usage_aggregates_recent, run_offline_batch


FULL_RECONCILE_INTERVAL_SECONDS = 24 * 60 * 60  # 24 hours
STATE_KEY = "usage_aggregates_rebuild"


def _default_log(message: str) -> None:
    print(message, flush=True)


def _sleep_until_next_interval(now: datetime, interval_seconds: int) -> float:
    """Sleep time so wake lands on interval boundary (e.g., 3-min boundary at :00/:03/:06/...)."""
    epoch = now.timestamp()
    next_boundary = (int(epoch) // interval_seconds + 1) * interval_seconds
    return max(0.0, next_boundary - epoch)


def run_batch_scheduler(
    dsn: str,
    *,
    interval_seconds: int,
    run_fn,
    run_fn_kwargs: dict | None = None,
    connect=None,
    now_fn=lambda: datetime.now(timezone.utc),
    sleep_fn=time.sleep,
    log_fn=_default_log,
    max_runs: int | None = None,
) -> None:
    """Generic scheduler: every interval_seconds, call run_fn(conn, **run_fn_kwargs).

    Sleeps so wakes align to interval boundaries. Used for both high-freq rollup
    (3 minutes) and hourly batch.
    """
    if not dsn:
        raise SystemExit("POSTGRES_DSN is required for analysis batch scheduler")
    if connect is None:
        import psycopg
        connect = psycopg.connect

    run_fn_kwargs = run_fn_kwargs or {}
    runs = 0
    while True:
        sleep_seconds = _sleep_until_next_interval(now_fn(), interval_seconds)
        log_fn(f"scheduler sleeping {sleep_seconds:.0f}s until next run")
        sleep_fn(sleep_seconds)

        started_at = now_fn().isoformat()
        try:
            with connect(dsn) as conn:
                result = run_fn(conn, **run_fn_kwargs)
            log_fn(f"run complete at {started_at}: {result}")
        except Exception as exc:  # pragma: no cover - defensive runtime logging
            log_fn(f"run failed at {started_at}: {exc!r}")

        runs += 1
        if max_runs is not None and runs >= max_runs:
            return


def _read_last_full_rebuild_at(conn) -> datetime | None:
    """Read last_full_rebuild_at from batch_runtime_state. Returns None if missing or NULL."""
    cursor = conn.cursor()
    cursor.execute(
        "SELECT state_value->>'last_full_rebuild_at' FROM batch_runtime_state WHERE state_key = %s",
        (STATE_KEY,),
    )
    row = cursor.fetchone()
    if not row or not row[0]:
        return None
    return datetime.fromisoformat(row[0])


def _write_last_full_rebuild_at(conn, when: datetime) -> None:
    cursor = conn.cursor()
    cursor.execute(
        """
        UPDATE batch_runtime_state
        SET state_value = jsonb_set(state_value, '{last_full_rebuild_at}', %s::jsonb),
            updated_at = now()
        WHERE state_key = %s
        """,
        (when.isoformat(), STATE_KEY),
    )
    conn.commit()


def run_full_batch_with_daily_reconcile(
    dsn: str,
    *,
    connect=None,
    now_fn=lambda: datetime.now(timezone.utc),
    sleep_fn=time.sleep,
    log_fn=_default_log,
    max_runs: int | None = None,
) -> None:
    """Hourly batch (baselines + IsolationForest). Once every 24h (or on first
    run when last_full_rebuild_at IS NULL), also runs full usage_aggregates
    reconciliation before baselines/IF."""
    if not dsn:
        raise SystemExit("POSTGRES_DSN is required for analysis batch scheduler")
    if connect is None:
        import psycopg
        connect = psycopg.connect

    runs = 0
    while True:
        sleep_seconds = _sleep_until_next_interval(now_fn(), 3600)
        log_fn(f"batch sleeping {sleep_seconds:.0f}s until next hourly run")
        sleep_fn(sleep_seconds)

        started_at = now_fn().isoformat()
        try:
            with connect(dsn) as conn:
                last = _read_last_full_rebuild_at(conn)
                now = now_fn()
                full = (last is None) or ((now - last).total_seconds() >= FULL_RECONCILE_INTERVAL_SECONDS)
                if full:
                    log_fn("running full usage_aggregates reconciliation before baselines/IF")
                result = run_offline_batch(conn, full_rebuild_aggregates=full)
                if full:
                    _write_last_full_rebuild_at(conn, now_fn())
            log_fn(f"batch complete at {started_at}: {result}")
        except Exception as exc:  # pragma: no cover - defensive runtime logging
            log_fn(f"batch failed at {started_at}: {exc!r}")

        runs += 1
        if max_runs is not None and runs >= max_runs:
            return


def main() -> int:
    dsn = os.environ.get("POSTGRES_DSN", "").strip()
    mode = os.environ.get("BATCH_MODE", "full").strip()

    if mode == "rollup":
        interval_seconds = int(os.environ.get("ROLLUP_INTERVAL_SECONDS", "180"))
        window_hours = int(os.environ.get("ROLLUP_WINDOW_HOURS", "3"))
        run_batch_scheduler(
            dsn,
            interval_seconds=interval_seconds,
            run_fn=rebuild_usage_aggregates_recent,
            run_fn_kwargs={"window_hours": window_hours},
        )
    elif mode == "full":
        run_full_batch_with_daily_reconcile(dsn)
    else:
        raise SystemExit(f"Unknown BATCH_MODE={mode!r}, expected 'rollup' or 'full'")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
