from contract import (
    GROUP_CORE,
    GROUP_ENRICHMENT,
    STAGE_CORE,
    STAGE_ENRICHMENT,
    STREAM_CORE,
    STREAM_ENRICHMENT,
)

# 锁定性质：这些值与 Go 端 internal/jobs/streams.go 同名同值。drift 时本测试失败。
# 见 ADR-0003、CONTEXT.md → analysis job contract。


def test_stage_values():
    assert STAGE_CORE == "core"
    assert STAGE_ENRICHMENT == "enrichment"


def test_stream_values():
    assert STREAM_CORE == "analysis.core"
    assert STREAM_ENRICHMENT == "analysis.enrichment"


def test_group_values():
    assert GROUP_CORE == "analysis-core-workers"
    assert GROUP_ENRICHMENT == "analysis-enrichment-workers"
