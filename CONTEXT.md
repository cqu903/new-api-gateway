# CONTEXT

本仓库的统一语言（ubiquitous language）术语表。命名领域概念时以此为准，避免同义词漂移。
当某个概念尚未收录，要么是项目未使用的语言（重新考虑），要么是真实缺口（留给 `/domain-modeling` 补）。

## 分页与列表

### Pagination（分页）

分页列表视图（trace 列表、anomaly 列表，以及未来的同类视图）共有的导航元数据。
字段：`page`、`pageSize`、`totalItems`、`totalPages`、`hasPrev`、`hasNext`。

- **服务端单方面计算并 clamp**：页码越界时钳到末页；结果集为空时 `page=1`、`totalPages=0`。
- **客户端只读、只展示**：不参与计算，不假设页大小。
- **不变量：`pageSize` 的真值源只在服务端**（`defaultListPageSize`）。请求不携带页大小；响应回传 `page_size`，客户端据此渲染。
- **分页计算（pagination math）**：clamp 与 `hasPrev`/`hasNext` 的推导，是 trace 列表与 anomaly 列表之间逐字相同的纯逻辑，由各自语言的分页模块承载（Go `clampPagination`；JS `pagination.js`）。

跳页（jump-page）输入解析属于分页计算的一部分；列表视图的过滤、渲染、事件绑定（`bind*`）属于「视图行为」，与分页计算分开。

## 工作相关性裁决

### Verdict（裁决）

`LLMJudgeClient.judge(bundle)` 对一个 trace bundle 返回的、**校验过的**分类结果。
字段：`decision`、`recommended_action`、`confidence`、`task_category`、`task_domain`、`reason`。

- **契约**：judge 要么返回 `Verdict`，要么抛 `LLMJudgeUnavailable`——涵盖传输（timeout / http_error / connection_error）、解析（invalid_response / invalid_json）与**校验**（invalid_result：decision/action 非法或配对不符）全部失败。
- **校验归判定器**：decision/action 的合法性、配对、confidence 的 clamp 在构造 `Verdict` 时完成；调用方不再做裁决语义校验。
- **score 推导不在此**：`decision → work/personal score` 的映射是 work_relevance 的评分模型，留在调用方，不属于裁决本身（见 ADR-0002）。

### 裁决词表（verdict_vocab）

`decision`（`work_related` / `non_work_related` / `needs_review` / `unknown`）与 `recommended_action`（`allow` / `alert_non_work` / `review_conflict` / `record_only`）的合法值与配对关系（如 `non_work_related` 只配 `alert_non_work`）。

- **单一真相源**在 `verdict_vocab.py`：判定器（prompt + 校验）、work_relevance（规则路径 `_decision_from_scores` + 评分 `_adapt_llm_result`）、rules.py（异常触发）三方共用，避免字面量漂移。
- 不归任一产出者：LLM 判定与规则评分是裁决的两条产出路径，共用同一套词表。

## 既有术语（种子，待 `/domain-modeling` 深化）

以下为项目已确立的核心领域词，此处仅作索引，定义待后续补全。

- **trace（追踪）**：一次经过网关的请求-响应记录。
- **anomaly（异常）**：对 trace 用量/行为偏离基线的标记。
- **evidence（证据）**：请求体/响应体/头部等审计证据对象（filesystem 或 OSS 两条路径）。
- **identity snapshot（身份快照）**：由 token 指纹解析出的调用方身份。
- **stage（阶段）**：分析流水线的阶段（core / enrichment），各对应一条 Redis stream。
- **stream（流）**：`analysis.core`、`analysis.enrichment` 两条 Redis Streams。
