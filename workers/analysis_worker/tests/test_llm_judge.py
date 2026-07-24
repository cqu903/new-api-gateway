import httpx
import pytest

from llm_judge import LLMJudgeClient, LLMJudgeUnavailable


def test_posts_openai_compatible_chat_completion_request_with_json_instructions(monkeypatch):
    recorded = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": '{"decision":"work_related","recommended_action":"allow","confidence":0.9}',
                        }
                    }
                ]
            }

    def fake_post(url, headers=None, json=None, timeout=None):
        recorded["url"] = url
        recorded["headers"] = headers
        recorded["json"] = json
        recorded["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr(httpx, "post", fake_post)

    client = LLMJudgeClient(
        base_url="https://judge.example.com/",
        model="judge-model",
        api_key="secret-token",
        timeout_seconds=12.5,
        max_tokens=800,
    )

    result = client.judge({"trace_id": "trace_1", "score": 0.91})

    assert result.decision == "work_related"
    assert result.recommended_action == "allow"
    assert recorded["url"] == "https://judge.example.com/chat/completions"
    assert recorded["headers"] == {
        "Content-Type": "application/json",
        "Authorization": "Bearer secret-token",
    }
    assert recorded["timeout"] == 12.5
    assert recorded["json"]["model"] == "judge-model"
    assert recorded["json"]["temperature"] == 0
    assert recorded["json"]["max_tokens"] == 800
    assert recorded["json"]["messages"][0]["role"] == "system"
    assert "JSON" in recorded["json"]["messages"][0]["content"]
    assert "untrusted" in recorded["json"]["messages"][0]["content"]
    assert "decision, recommended_action, task_category, task_domain, confidence, reason" in recorded["json"]["messages"][0]["content"]
    assert "allow, alert_non_work, review_conflict, record_only" in recorded["json"]["messages"][0]["content"]
    assert "review_high_cost_unknown" not in recorded["json"]["messages"][0]["content"]
    assert "Do not repeat the input" in recorded["json"]["messages"][0]["content"]
    assert recorded["json"]["messages"][1]["role"] == "user"
    assert recorded["json"]["messages"][1]["content"] == 'Classify this trace bundle: {"score": 0.91, "trace_id": "trace_1"}'


def test_system_prompt_recommended_actions_match_current_worker_contract(monkeypatch):
    recorded = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": '{"decision":"unknown","recommended_action":"record_only"}',
                        }
                    }
                ]
            }

    def fake_post(url, headers=None, json=None, timeout=None):
        recorded["prompt"] = json["messages"][0]["content"]
        return FakeResponse()

    monkeypatch.setattr(httpx, "post", fake_post)

    client = LLMJudgeClient(base_url="https://judge.example.com", model="judge-model")

    client.judge({"trace_id": "trace_actions"})

    prompt = recorded["prompt"]
    assert "recommended_action must be one of allow, alert_non_work, review_conflict, record_only" in prompt
    assert "review_high_cost_unknown" not in prompt


def test_accepts_json_wrapped_in_markdown_fence(monkeypatch):
    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": "```json\n{\"decision\":\"non_work_related\",\"recommended_action\":\"alert_non_work\"}\n```",
                        }
                    }
                ]
            }

    monkeypatch.setattr(httpx, "post", lambda *args, **kwargs: FakeResponse())

    client = LLMJudgeClient(base_url="https://judge.example.com", model="judge-model")

    result = client.judge({"trace_id": "trace_2"})

    assert result.decision == "non_work_related"


def test_raises_unavailable_on_timeout(monkeypatch):
    def fake_post(*args, **kwargs):
        raise httpx.TimeoutException("timed out")

    monkeypatch.setattr(httpx, "post", fake_post)

    client = LLMJudgeClient(base_url="https://judge.example.com", model="judge-model")

    with pytest.raises(LLMJudgeUnavailable) as exc_info:
        client.judge({"trace_id": "trace_timeout"})

    assert exc_info.value.error_type == "timeout"
    assert "timed out" in exc_info.value.message


def test_raises_unavailable_on_invalid_json(monkeypatch):
    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": "not json",
                        }
                    }
                ]
            }

    monkeypatch.setattr(httpx, "post", lambda *args, **kwargs: FakeResponse())

    client = LLMJudgeClient(base_url="https://judge.example.com", model="judge-model")

    with pytest.raises(LLMJudgeUnavailable) as exc_info:
        client.judge({"trace_id": "trace_invalid_json"})

    assert exc_info.value.error_type == "invalid_json"
    assert "not json" not in exc_info.value.message
    assert "content_length=" in exc_info.value.message


def test_raises_unavailable_on_http_status_error(monkeypatch):
    request = httpx.Request("POST", "https://judge.example.com/chat/completions")
    response = httpx.Response(503, request=request)

    def fake_post(*args, **kwargs):
        raise httpx.HTTPStatusError("service unavailable", request=request, response=response)

    monkeypatch.setattr(httpx, "post", fake_post)

    client = LLMJudgeClient(base_url="https://judge.example.com", model="judge-model")

    with pytest.raises(LLMJudgeUnavailable) as exc_info:
        client.judge({"trace_id": "trace_http_error"})

    assert exc_info.value.error_type == "http_error"
    assert "service unavailable" in exc_info.value.message


def test_raises_unavailable_on_connection_error(monkeypatch):
    request = httpx.Request("POST", "https://judge.example.com/chat/completions")

    def fake_post(*args, **kwargs):
        raise httpx.ConnectError("connection refused", request=request)

    monkeypatch.setattr(httpx, "post", fake_post)

    client = LLMJudgeClient(base_url="https://judge.example.com", model="judge-model")

    with pytest.raises(LLMJudgeUnavailable) as exc_info:
        client.judge({"trace_id": "trace_connection_error"})

    assert exc_info.value.error_type == "connection_error"
    assert "connection refused" in exc_info.value.message


def test_raises_unavailable_on_invalid_response_shape(monkeypatch):
    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"unexpected": []}

    monkeypatch.setattr(httpx, "post", lambda *args, **kwargs: FakeResponse())

    client = LLMJudgeClient(base_url="https://judge.example.com", model="judge-model")

    with pytest.raises(LLMJudgeUnavailable) as exc_info:
        client.judge({"trace_id": "trace_invalid_shape"})

    assert exc_info.value.error_type == "invalid_response"


def test_rejects_legal_json_content_that_is_not_an_object(monkeypatch):
    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": "[\"not\", \"object\"]",
                        }
                    }
                ]
            }

    monkeypatch.setattr(httpx, "post", lambda *args, **kwargs: FakeResponse())

    client = LLMJudgeClient(base_url="https://judge.example.com", model="judge-model")

    with pytest.raises(LLMJudgeUnavailable) as exc_info:
        client.judge({"trace_id": "trace_non_object_json"})

    assert exc_info.value.error_type == "invalid_json"


def test_system_prompt_includes_off_industry_rule_when_org_domain_set():
    client = LLMJudgeClient(
        base_url="https://judge.example.com",
        model="judge-model",
        org_business_domain="金融服务",
    )
    prompt = client.system_prompt
    assert client.org_business_domain == "金融服务"
    assert "金融服务" in prompt
    assert "DIFFERENT" in prompt  # off-industry clause
    assert "Internal corporate functions" in prompt  # internal-function exclusion
    assert "task_domain" in prompt
    assert "reason" in prompt


def test_system_prompt_omits_off_industry_rule_when_org_domain_unset():
    client = LLMJudgeClient(base_url="https://judge.example.com", model="judge-model")
    prompt = client.system_prompt
    assert client.org_business_domain == ""
    assert "DIFFERENT" not in prompt  # no off-industry clause
    assert "Internal corporate functions" not in prompt
    assert "task_domain" in prompt  # schema keys still present (uniform)
    assert "reason" in prompt


def test_system_prompt_internal_function_clause_is_bilingual_and_language_neutral():
    client = LLMJudgeClient(
        base_url="https://judge.example.com",
        model="judge-model",
        org_business_domain="金融服务",
    )
    prompt = client.system_prompt
    assert "Internal corporate functions" in prompt  # anchor preserved
    assert "采购" in prompt  # Chinese internal-function example present
    assert "regardless of the language" in prompt


def test_org_business_domain_is_length_capped():
    client = LLMJudgeClient(
        base_url="https://judge.example.com",
        model="judge-model",
        org_business_domain="金" * 300,
    )
    assert client.org_business_domain == "金" * 200


def _judge_response(monkeypatch, content):
    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"choices": [{"message": {"content": content}}]}

    monkeypatch.setattr(httpx, "post", lambda *args, **kwargs: FakeResponse())


def test_verdict_rejects_illegal_decision_as_invalid_result(monkeypatch):
    _judge_response(monkeypatch, '{"decision":"maybe","recommended_action":"allow"}')
    client = LLMJudgeClient(base_url="https://judge.example.com", model="judge-model")
    with pytest.raises(LLMJudgeUnavailable) as exc_info:
        client.judge({"trace_id": "trace_illegal_decision"})
    assert exc_info.value.error_type == "invalid_result"


def test_verdict_rejects_mismatched_decision_action_as_invalid_result(monkeypatch):
    _judge_response(monkeypatch, '{"decision":"work_related","recommended_action":"alert_non_work"}')
    client = LLMJudgeClient(base_url="https://judge.example.com", model="judge-model")
    with pytest.raises(LLMJudgeUnavailable) as exc_info:
        client.judge({"trace_id": "trace_mismatch"})
    assert exc_info.value.error_type == "invalid_result"


def test_verdict_clamps_confidence_into_zero_one_range(monkeypatch):
    _judge_response(monkeypatch, '{"decision":"work_related","recommended_action":"allow","confidence":5.0}')
    client = LLMJudgeClient(base_url="https://judge.example.com", model="judge-model")
    result = client.judge({"trace_id": "trace_clamp"})
    assert result.decision == "work_related"
    assert result.recommended_action == "allow"
    assert result.confidence == 1.0
