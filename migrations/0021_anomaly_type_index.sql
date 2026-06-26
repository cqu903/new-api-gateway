-- 支撑异常列表「按 anomaly_type 筛选 + 时间排序」查询，与现有
-- (status,created_at) / (username,created_at) / (token,created_at) 索引对称。
CREATE INDEX IF NOT EXISTS idx_usage_anomalies_type_created
    ON usage_anomalies(anomaly_type, created_at DESC);
