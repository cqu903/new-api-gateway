"""跨进程 stream 契约常量：stage / stream 名 / 消费组名。

与 Go 端 internal/jobs/streams.go 同名同值——靠两侧契约测试 + e2e 守一致。
见 CONTEXT.md → analysis job contract、ADR-0003。
"""

STAGE_CORE = "core"
STAGE_ENRICHMENT = "enrichment"

STREAM_CORE = "analysis.core"
STREAM_ENRICHMENT = "analysis.enrichment"

GROUP_CORE = "analysis-core-workers"
GROUP_ENRICHMENT = "analysis-enrichment-workers"

STREAM_BY_STAGE = {
    STAGE_CORE: STREAM_CORE,
    STAGE_ENRICHMENT: STREAM_ENRICHMENT,
}
GROUP_BY_STAGE = {
    STAGE_CORE: GROUP_CORE,
    STAGE_ENRICHMENT: GROUP_ENRICHMENT,
}
