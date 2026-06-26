"""Real-LLM integration tests for off-domain work-relevance judgment.

Unlike the stub-based unit tests in ``test_llm_judge.py`` / ``test_work_relevance.py``
(which feed a canned verdict through a ``StubJudge``), these tests exercise the
**actual** ``LLMJudgeClient`` — a real HTTP call to the configured ``LLM_JUDGE_*``
endpoint with the ``ORG_BUSINESS_DOMAIN`` system prompt — to verify the model
*semantically* classifies a trace that serves a different industry from the
org's main business as ``non_work_related``. This is the gap the off-domain
design spec (2026-06-26) section 7 left as "写入 e2e 或手动验证记录".

Auto-skipped when:
  - ``LLM_JUDGE_*`` is not configured (CI / host without judge env), or
  - ``ORG_BUSINESS_DOMAIN`` is unset (off-domain rule inactive).

Run for-real inside the deployed enrichment worker (where the env is set):
    docker exec -w /workspace/workers/analysis_worker \\
        new-api-gateway-analysis-enrichment-worker-1 \\
        uv run pytest tests/test_llm_judge_integration.py -v
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from main import create_llm_judge_from_env  # noqa: E402
from models import NormalizedMessage, TraceCapturedJob  # noqa: E402
from work_relevance import classify_work_relevance  # noqa: E402


def _high_cost_job() -> TraceCapturedJob:
    """High token tier (>=20k) with no catalog → high_cost_unknown → LLM judge invoked."""
    return TraceCapturedJob(
        type="trace_captured",
        trace_id="trace_integration",
        route_pattern="/v1/chat/completions",
        protocol_family="openai_chat",
        capture_mode="raw_and_normalized",
        username="alice",
        model_requested="gpt-4.1",
        usage_total_tokens=25000,
    )


def _msg(text: str) -> NormalizedMessage:
    return NormalizedMessage(
        trace_id="trace_integration",
        direction="request",
        sequence_index=0,
        role="user",
        modality="text",
        content_text=text,
        content_text_hash="hash",
        media_url="",
        source_path="request.messages[0]",
        protocol_item_type="openai_chat_message",
        token_count_estimate=10,
        metadata={},
        message_key="k",
    )


def _llm_evidence(assessment) -> list[dict]:
    """Evidence proving the LLM judge was actually consulted (not rule-shortcircuited
    nor the unavailable-fallback). kind=='llm_judge' distinguishes a real verdict
    from kind=='llm_unavailable'."""
    return [
        e for e in assessment.evidence
        if isinstance(e, dict) and e.get("source") == "llm_judge" and e.get("kind") == "llm_judge"
    ]


@pytest.fixture(scope="module")
def real_judge():
    client = create_llm_judge_from_env()
    if client is None:
        pytest.skip("LLM_JUDGE_* not configured; real-LLM integration test skipped")
    if not client.org_business_domain:
        pytest.skip("ORG_BUSINESS_DOMAIN unset; off-domain rule inactive")
    return client


def test_real_llm_flags_manufacturing_website_as_non_work(real_judge):
    """Spec's motivating case: building a manufacturing company's website while
    the org's main business is financial services = clearly serving a different
    industry → non_work_related + alert_non_work."""
    messages = [
        _msg("我们在帮一家生产制造公司做官网，需要重新设计首页的产品展示和OEM询盘表单。"),
        _msg("请把工厂介绍和生产线那几页的样式全部优化一下，风格偏工业制造。"),
        _msg("继续完善机械设备产品目录页面的排版和询盘交互。"),
    ]
    assessment = classify_work_relevance(_high_cost_job(), messages, [], llm_judge=real_judge)

    assert _llm_evidence(assessment), (
        f"LLM judge was not consulted (decision={assessment.decision}, "
        f"action={assessment.recommended_action}); evidence={assessment.evidence}"
    )
    assert assessment.decision == "non_work_related", (
        f"expected non_work_related, got {assessment.decision}; evidence={assessment.evidence}"
    )
    assert assessment.recommended_action == "alert_non_work"


def test_real_llm_keeps_financial_internal_analysis_as_work(real_judge):
    """Counter-example: a bank's internal loan-portfolio risk analysis is core
    financial-services work and must NOT be alerted even though it mentions
    other industries (manufacturing/retail) as analysis subjects."""
    messages = [
        _msg("帮我分析本行三季度对公贷款组合的信用风险敞口，按行业和担保方式拆分。"),
        _msg("重点看制造业和批发零售业这两个行业的违约率趋势，给出风险预警建议。"),
    ]
    assessment = classify_work_relevance(_high_cost_job(), messages, [], llm_judge=real_judge)

    assert _llm_evidence(assessment), (
        f"LLM judge was not consulted (decision={assessment.decision}); evidence={assessment.evidence}"
    )
    assert assessment.recommended_action != "alert_non_work", (
        f"financial-internal analysis was wrongly alerted; evidence={assessment.evidence}"
    )


def test_real_llm_keeps_internal_procurement_as_work(real_judge):
    """Counter-example (internal function per spec §4.2): procurement / admin is
    legitimate work even though it is not revenue-generating and not core business."""
    messages = [
        _msg("整理本月办公用品采购清单，对比三家供应商的报价，做个采购审批表交领导签字。"),
    ]
    assessment = classify_work_relevance(_high_cost_job(), messages, [], llm_judge=real_judge)

    assert _llm_evidence(assessment), (
        f"LLM judge was not consulted (decision={assessment.decision}); evidence={assessment.evidence}"
    )
    assert assessment.recommended_action != "alert_non_work", (
        f"internal procurement was wrongly alerted; evidence={assessment.evidence}"
    )
