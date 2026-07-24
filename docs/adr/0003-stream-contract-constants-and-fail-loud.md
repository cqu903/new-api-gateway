# ADR-0003：跨进程 stream 契约用手写常量 + fail-loud，不做代码级共享 schema

- 状态：Accepted
- 日期：2026-07-24
- 关联：`CONTEXT.md` → analysis job contract；承袭 ADR-0001/0002 的「做深 ≠ 全塞」

## 背景（Context）

Go 网关发布分析任务到 Redis Streams、Python worker 消费。跨进程契约的 stage / stream 名 / 消费组名曾以**字面量**在两侧重复（Go `streams.go`、`admin/runtime.go` ↔ Python `streams.py`、`main.py`、`runtime_metrics.py`），且 `streams.py:_parse_stage` 对非空未知 stage **静默退化为 CORE**——stage 漂移被 e2e 掩盖（退化后仍处理，e2e 不失败）。

曾考虑两个更大的方案：
- **跨语言代码生成**（单一 IDL → Go + Python 常量 / schema）。
- **28 字段 job payload 的代码级共享 schema**（Go `TraceCapturedJob` ↔ Python `TraceCapturedJob` dataclass）。

## 决策（Decision）

1. **stage / stream / group 名用手写双侧常量**（Go 扩 `internal/jobs/streams.go`，Python 新 `contract.py`），配契约测试 + e2e 守一致。**不引入跨语言代码生成**。
2. **`_parse_stage` fail-loud**：非空未知 stage 抛错（归 terminal → DLQ）；空 stage 保留默认值（兼容旧消息）。
3. **不做 28 字段 job payload 的代码级共享 schema**（见下方「关键澄清」）。

## 理由

- **行为量匹配**（承袭 ADR-0001/0002）：跨进程的字面量只有 stage（2）+ stream 名（2）+ group 名（2）共 6 个字符串。代码生成的基建成本远超收益；手写两侧常量 + 契约断言是匹配的深度。e2e（`test_gateway_worker_pipeline`）已是 stream 名的事实契约（不一致则 worker 收不到消息），显式断言补 stage 名的空缺。
- **drift fails loud**：`_parse_stage` 静默退化是真正被掩盖的隐患——stage 漂移时 worker 用错的 stage 跑、产出错误分析，比「无分析」更难发现。fail-loud（terminal DLQ）让 drift 响亮失败；DLQ 可修复后重放、不永久丢失。契约测试是第一道防线，fail-loud 是最后一道。
- **空 stage 保留默认**：兼容 Go 未发 stage 字段的历史消息；只对「非空但未知」（明确的 drift 信号）fail-loud。

## 关键澄清（防未来重提）

**28 字段 `TraceCapturedJob` 不跨 Redis stream**。深入追数据流发现：

- stream message 只发 5 字段（`trace_id` / `stage` / `attempt` / `hints` / `enqueued_at`），`trace_id` 是唯一标识；
- worker（`CoreStageProcessor.process` → `repository.load_trace_job_json(trace_id)`）**从 `traces` 表读完整 trace 行**组装成 28 字段 JSON，再 `parse_job`。

即 `TraceCapturedJob` 是 traces 表行的内存映射，**DB schema（migrations）已是它的真相源**——再搞一套代码级共享 schema 是重复 DB 契约。同理，`core_status` / `enrichment_status` 是 Python worker 单侧 UPDATE（Go 写的是 `analysis_status` 列），不属 Go↔Python 代码级契约。

（架构评审的初始 Explore 报告把这两者误判为跨进程契约漂移，本 ADR 修正之。）

## 后果（Consequences）

- 正：stage / stream / group 名双侧单一常量源（各语言内）；stage 漂移 fail-loud 不再被掩盖；e2e + 契约断言双层守护。
- 负：两侧常量仍各写一份（靠契约测试盯一致），非真·单源——但跨语言真单源需 code-gen，6 个字符串不值得。
- **重开信号**：若 stage / stream / group 数量显著增长（如出现第三、第四个 stage），或出现第二个跨语言契约族，可重新评估 code-gen。
