import json
from datetime import datetime, timezone
from unittest.mock import patch, MagicMock

from batch_scheduler import (
    _sleep_until_next_interval,
    _write_last_full_rebuild_at,
    run_batch_scheduler,
    run_full_batch_with_daily_reconcile,
)


def test_sleep_until_next_interval_3min_boundary():
    now = datetime(2026, 6, 9, 10, 15, 30, tzinfo=timezone.utc)

    assert _sleep_until_next_interval(now, 180) == 150.0


def test_sleep_until_next_interval_3min_on_boundary_sleeps_full_interval():
    now = datetime(2026, 6, 9, 10, 15, 0, tzinfo=timezone.utc)

    assert _sleep_until_next_interval(now, 180) == 180.0


def test_sleep_until_next_interval_hourly_falls_back_to_hour_boundary():
    """interval=3600 should match the legacy seconds_until_next_hour behavior."""
    now = datetime(2026, 6, 9, 10, 15, 30, tzinfo=timezone.utc)

    assert _sleep_until_next_interval(now, 3600) == 2670.0


def test_run_batch_scheduler_rollup_mode_calls_rebuild_recent():
    sleep_calls = []
    runs = []

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    def fake_connect(dsn: str):
        assert dsn == "postgres://example"
        return FakeConnection()

    def fake_run_fn(conn, *, window_hours):
        runs.append({"conn": conn, "window_hours": window_hours})
        return {"usage_aggregate_rows": 7}

    now = datetime(2026, 6, 9, 10, 15, 30, tzinfo=timezone.utc)
    run_batch_scheduler(
        "postgres://example",
        interval_seconds=180,
        run_fn=fake_run_fn,
        run_fn_kwargs={"window_hours": 3},
        connect=fake_connect,
        now_fn=lambda: now,
        sleep_fn=sleep_calls.append,
        log_fn=lambda message: None,
        max_runs=1,
    )

    assert sleep_calls == [150.0]
    assert len(runs) == 1
    assert runs[0]["conn"].__class__.__name__ == "FakeConnection"
    assert runs[0]["window_hours"] == 3


def test_run_full_batch_with_daily_reconcile_triggers_full_on_first_run():
    now = datetime(2026, 6, 9, 10, 15, 30, tzinfo=timezone.utc)
    captured = {}

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    def fake_run_offline_batch(conn, full_rebuild_aggregates=False):
        captured["full_rebuild_aggregates"] = full_rebuild_aggregates
        return {"fingerprints_processed": 0, "baselines_written": 0, "usage_aggregate_rows": 0}

    write_calls = []
    with patch("batch_scheduler.run_offline_batch", side_effect=fake_run_offline_batch), \
         patch("batch_scheduler._read_last_full_rebuild_at", return_value=None), \
         patch(
             "batch_scheduler._write_last_full_rebuild_at",
             side_effect=lambda conn, when: write_calls.append(when),
         ):
        run_full_batch_with_daily_reconcile(
            "postgres://example",
            connect=lambda dsn: FakeConnection(),
            now_fn=lambda: now,
            sleep_fn=lambda s: None,
            log_fn=lambda m: None,
            max_runs=1,
        )

    assert captured["full_rebuild_aggregates"] is True
    # Timestamp written from batch_started_at, not post-batch time.
    assert write_calls == [now]


def test_run_full_batch_with_daily_reconcile_skips_full_within_24h():
    now = datetime(2026, 6, 9, 10, 15, 30, tzinfo=timezone.utc)
    last = datetime(2026, 6, 9, 8, 15, 30, tzinfo=timezone.utc)  # 2 hours ago
    captured = {}

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    def fake_run_offline_batch(conn, full_rebuild_aggregates=False):
        captured["full_rebuild_aggregates"] = full_rebuild_aggregates
        return {"fingerprints_processed": 0, "baselines_written": 0, "usage_aggregate_rows": 0}

    write_mock = MagicMock()
    with patch("batch_scheduler.run_offline_batch", side_effect=fake_run_offline_batch), \
         patch("batch_scheduler._read_last_full_rebuild_at", return_value=last), \
         patch("batch_scheduler._write_last_full_rebuild_at", write_mock):
        run_full_batch_with_daily_reconcile(
            "postgres://example",
            connect=lambda dsn: FakeConnection(),
            now_fn=lambda: now,
            sleep_fn=lambda s: None,
            log_fn=lambda m: None,
            max_runs=1,
        )

    assert captured["full_rebuild_aggregates"] is False
    assert write_mock.call_count == 0


def test_run_full_batch_with_daily_reconcile_triggers_full_after_24h():
    now = datetime(2026, 6, 9, 10, 15, 30, tzinfo=timezone.utc)
    last = datetime(2026, 6, 8, 9, 15, 30, tzinfo=timezone.utc)  # 25 hours ago
    captured = {}

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    def fake_run_offline_batch(conn, full_rebuild_aggregates=False):
        captured["full_rebuild_aggregates"] = full_rebuild_aggregates
        return {"fingerprints_processed": 0, "baselines_written": 0, "usage_aggregate_rows": 0}

    write_calls = []
    with patch("batch_scheduler.run_offline_batch", side_effect=fake_run_offline_batch), \
         patch("batch_scheduler._read_last_full_rebuild_at", return_value=last), \
         patch(
             "batch_scheduler._write_last_full_rebuild_at",
             side_effect=lambda conn, when: write_calls.append(when),
         ):
        run_full_batch_with_daily_reconcile(
            "postgres://example",
            connect=lambda dsn: FakeConnection(),
            now_fn=lambda: now,
            sleep_fn=lambda s: None,
            log_fn=lambda m: None,
            max_runs=1,
        )

    assert captured["full_rebuild_aggregates"] is True
    assert write_calls == [now]


def test_run_full_batch_with_daily_reconcile_does_not_write_timestamp_on_failure():
    now = datetime(2026, 6, 9, 10, 15, 30, tzinfo=timezone.utc)

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    write_mock = MagicMock()
    with patch("batch_scheduler.run_offline_batch", side_effect=RuntimeError("boom")), \
         patch("batch_scheduler._read_last_full_rebuild_at", return_value=None), \
         patch("batch_scheduler._write_last_full_rebuild_at", write_mock):
        # Should not raise — the exception is logged inside the loop.
        run_full_batch_with_daily_reconcile(
            "postgres://example",
            connect=lambda dsn: FakeConnection(),
            now_fn=lambda: now,
            sleep_fn=lambda s: None,
            log_fn=lambda m: None,
            max_runs=1,
        )

    assert write_mock.call_count == 0


def test_run_full_batch_with_daily_reconcile_applies_wake_offset():
    """wake_offset_seconds 加到 sleep 时间上, 避开 analysis-rollup 的整点唤醒."""
    sleep_calls = []
    now = datetime(2026, 6, 9, 10, 15, 30, tzinfo=timezone.utc)

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    with patch("batch_scheduler.run_offline_batch"), \
         patch("batch_scheduler._read_last_full_rebuild_at", return_value=None), \
         patch("batch_scheduler._write_last_full_rebuild_at"):
        run_full_batch_with_daily_reconcile(
            "postgres://example",
            connect=lambda dsn: FakeConnection(),
            now_fn=lambda: now,
            sleep_fn=sleep_calls.append,
            log_fn=lambda m: None,
            max_runs=1,
            wake_offset_seconds=90,
        )

    # _sleep_until_next_interval(10:15:30, 3600) = 2670.0 (to 11:00:00)
    # + 90 offset = 2760.0 (to 11:01:30, avoiding rollup wake at :00/:03/...)
    assert sleep_calls == [2760.0]


def test_write_last_full_rebuild_at_passes_valid_json_to_jsonb_column():
    """Regression: %s::jsonb 需要合法 JSON 文本. 直接传 isoformat() 字符串会报
    'invalid input syntax for type json' (token '-06' is invalid). 必须用
    json.dumps() 把字符串包成 JSON string literal."""
    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_conn.cursor.return_value = mock_cursor

    when = datetime(2026, 6, 17, 9, 12, 30, tzinfo=timezone.utc)
    _write_last_full_rebuild_at(mock_conn, when)

    assert mock_cursor.execute.call_count == 1
    args = mock_cursor.execute.call_args.args[1]
    sql_arg, state_key_arg = args
    # state_value 那个占位符必须是合法 JSON 字符串字面量, 即 "\"2026-06-17T...\""
    assert sql_arg == json.dumps(when.isoformat())
    assert state_key_arg == "usage_aggregates_rebuild"
    # 烧一下 json.loads 验证合法 JSON, 防止回归
    parsed = json.loads(sql_arg)
    assert parsed == when.isoformat()
    # commit 被调用一次
    assert mock_conn.commit.call_count == 1
