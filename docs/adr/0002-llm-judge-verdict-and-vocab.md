# ADR-0002：LLM 判定器返回校验过的 Verdict，裁决词表独立成模块

- 状态：Accepted
- 日期：2026-07-24
- 关联：`CONTEXT.md` → Verdict / 裁决词表；承袭 ADR-0001 的「做深 ≠ 全塞」

## 背景（Context）

`LLMJudgeClient.judge(bundle)` 原本返回 **raw dict**：它只负责 HTTP + JSON 解析，而「裁决语义」——decision/action 的合法性校验、配对检查、confidence clamp——散在调用方 `work_relevance._adapt_llm_result`。同时：

- 裁决词表（`DECISION_*` / `ACTION_*` / `VALID_DECISION_ACTIONS`）权威定义在 `work_relevance.py`，`llm_judge.py` **反向 import** 它们，还维护第二份 `_ALLOWED_*` 表用于拼提示词，两份表必须手工同步。
- 词表被三方消费：判定器（prompt）、work_relevance（规则路径 `_decision_from_scores` + 评分 `_adapt_llm_result`）、`rules.py`（用字面量 `"alert_non_work"`，第三处隐式漂移）。
- 校验失败抛 `InvalidLLMResult`（work_relevance 定义），与传输/解析失败的 `LLMJudgeUnavailable`（判定器定义）是两套异常，但下游 `classify_work_relevance` 只用 `except Exception` + `getattr(error_type)` 统一处理。

## 决策（Decision）

1. `judge(bundle: Mapping) -> Verdict`：判定器返回**校验过的** `Verdict` dataclass（字段 decision / recommended_action / confidence / task_category / task_domain / reason），构造时完成合法性 + 配对校验 + confidence clamp。
2. 裁决词表独立成 `verdict_vocab.py`（`DECISION_*` / `ACTION_*` / `VALID_*`），判定器与 work_relevance、rules.py 共用；删 `llm_judge._ALLOWED_*` 第二份表；`rules.py` 字面量改常量。
3. 校验逻辑（`_adapt_llm_result` 的 570-580）搬进判定器（构造 `Verdict` 时）；`decision → score` 的评分映射（581-610）留 `work_relevance`，输入从 raw dict 改 `Verdict`。
4. 删 `InvalidLLMResult`；校验失败抛 `LLMJudgeUnavailable("invalid_result", msg)`，判定器异常族统一。

## 理由

- **接口即测试面**：校验是「裁决语义」，归产出裁决的判定器；判定器吐 raw dict 让调用方校验，是接缝方向反了。`judge` 的返回值就是「一个合法裁决」。
- **接缝方向修正**：`llm_judge` 不再 `from work_relevance import ...`；判定器（底层适配器）与 work_relevance（上层编排）互不反向依赖。词表归中性底层 `verdict_vocab`，而非任一产出者——LLM 路径与规则路径都是裁决的产出路径。
- **不越界（承袭 ADR-0001）**：score 推导是 work_relevance 的评分模型，不是 LLM 裁决本身；把它拽进判定器会撑宽其接口。本次只搬校验，评分留原地。
- **异常统一**：下游已用 `getattr(error_type)`、`strict_llm_errors` 对所有异常一视同仁；统一到 `LLMJudgeUnavailable` + `error_type` 减一个类型、一处失败语义。

## 后果（Consequences）

- 正：判定器自包含（prompt + 词表 + 校验 + 失败语义都在内）；`_adapt_llm_result` 瘦身为评分映射；词表三消费者统一，消除字面量漂移；判定器可用 fake 替换（满足同一 `judge → Verdict` 接缝）。
- 负：`work_relevance` 新增 `from llm_judge import Verdict`（类型依赖）——这是上层消费下层输出的正向依赖，可接受。
- **重开信号**：若出现第二个裁决产出者（如非 LLM 的判定器）且其 `Verdict` 形状与 LLM 的一致，可把 `Verdict` 上移到共享层（如 `verdict_vocab` 或新的 `verdict.py`）；届时「多个产出者形状趋同」才是上移依据。
