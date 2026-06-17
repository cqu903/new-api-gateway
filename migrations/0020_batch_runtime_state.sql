-- 0020: batch runtime state
-- analysis-batch 容器需要持久化"距上次全量对账时间"，用于决定每次 hourly wake
-- 是否多跑一次全量 usage_aggregates 重建（每日对账兜底 late arrival）。
-- 通用 key/value 结构，未来其他 batch 状态也可复用。

CREATE TABLE IF NOT EXISTS batch_runtime_state (
    state_key TEXT PRIMARY KEY,
    state_value JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO batch_runtime_state (state_key, state_value)
VALUES ('usage_aggregates_rebuild', '{"last_full_rebuild_at": null}'::jsonb)
ON CONFLICT (state_key) DO NOTHING;
