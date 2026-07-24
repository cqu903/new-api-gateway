"""裁决词表：decision / recommended_action 的合法值与配对关系。

单一真相源——LLM 判定器（prompt + 校验）、work_relevance（规则路径 + 评分）、
rules.py（异常触发）三方共用，避免字面量漂移。见 CONTEXT.md → 裁决词表、ADR-0002。
"""

from __future__ import annotations

# 合法值（字符串即领域语言，落库 / 进 prompt / 写 evidence 都用它）。
DECISION_WORK_RELATED = "work_related"
DECISION_NON_WORK_RELATED = "non_work_related"
DECISION_NEEDS_REVIEW = "needs_review"
DECISION_UNKNOWN = "unknown"

ACTION_ALLOW = "allow"
ACTION_ALERT_NON_WORK = "alert_non_work"
ACTION_REVIEW_CONFLICT = "review_conflict"
ACTION_RECORD_ONLY = "record_only"

# 有序序列：给 prompt / 展示用（join 顺序稳定）。
DECISIONS = (
    DECISION_WORK_RELATED,
    DECISION_NON_WORK_RELATED,
    DECISION_NEEDS_REVIEW,
    DECISION_UNKNOWN,
)
ACTIONS = (
    ACTION_ALLOW,
    ACTION_ALERT_NON_WORK,
    ACTION_REVIEW_CONFLICT,
    ACTION_RECORD_ONLY,
)

# 集合：给校验用（O(1) 成员判断）。
VALID_DECISIONS = frozenset(DECISIONS)
VALID_ACTIONS = frozenset(ACTIONS)

# decision → 允许的 recommended_action 配对。
VALID_DECISION_ACTIONS = {
    DECISION_WORK_RELATED: frozenset({ACTION_ALLOW}),
    DECISION_NON_WORK_RELATED: frozenset({ACTION_ALERT_NON_WORK}),
    DECISION_NEEDS_REVIEW: frozenset({ACTION_REVIEW_CONFLICT}),
    DECISION_UNKNOWN: frozenset({ACTION_RECORD_ONLY}),
}
