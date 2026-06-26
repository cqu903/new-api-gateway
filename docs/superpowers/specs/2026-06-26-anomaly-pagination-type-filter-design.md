# 异常页面：类型筛选 + 分页 — 设计文档

- 日期：2026-06-26
- 作者：roy.yuan + Claude（brainstorming）
- 状态：待评审

## 1. 背景与问题

管理端「异常」列表当前是一锤子查询：后端 `listAnomalies` handler（`internal/admin/handlers.go:593`）硬编码 `ListAnomalies(ctx, 100)`，repository（`internal/admin/repository.go:344`）是 `SELECT … FROM usage_anomalies ORDER BY created_at DESC LIMIT $1`；前端 `renderAnomalies`（`internal/adminui/app.js:1471`）拿到 `{anomalies:[...]}` 直接渲染一张表。**无分页、无任何筛选。** 异常累积超过 100 条后，旧记录永远看不到；也无法只看某一类异常。

紧邻的「Trace」列表刚（merge `trace-pagination-search`）落地了成熟的分页 + 筛选模式：`TraceFilter{Page,Limit:50,…}` → `ListTraces` 先 `count(*)` 算 `totalPages`、clamp page、再查当页 → `TraceListResult{Traces, TracePagination{Page,PageSize,TotalItems,TotalPages,HasPrev,HasNext}}`；前端有完整一套 `state.traces` + 筛选栏 + 分页栏（首页/页码/末页/跳转输入）。异常页应与之**对称**。

### 现状核实（codegraph + 读码）

- 5 个 live `anomaly_type`：`non_work_use`、`high_trace_tokens`、`long_output_anomaly`、`off_hours_high_usage`（core 实时）、`multivariate_anomaly`（batch Isolation Forest）。中文文案见 `internal/admin/anomaly_reason.go:formatAnomalyDisplayReasonZH`。
- `usage_anomalies` 表可筛字段：`anomaly_type` / `severity` / `status` / `username` / `token_fingerprint`；现有索引 `(status,created_at DESC)`、`(username,created_at DESC)`、`(token,created_at DESC)`，**未覆盖 `anomaly_type`**。
- `status` 字段虽存在（`TEXT DEFAULT 'open'`，无 CHECK），但全仓**无任何 `UPDATE usage_anomalies SET status=…`**；worker INSERT（`repository.py:332` / `offline.py:263`）不带 status 列，全部走默认 `'open'`。`createReview` 对 anomaly 加评审记录但写到独立 `review_decisions` 表、**不回写 status**。即所有异常 status 恒为 `open`，「状态筛选」现状下只有单一取值。

## 2. 目标与非目标

### 目标
- 异常列表支持**按 `anomaly_type` 单选筛选**（下拉，含「全部」）。
- 异常列表支持**页码分页**（首页/上一页/页码/下一页/末页/跳转输入），与 Trace 列表 UX 一致。
- 后端复用 Trace 已验证的 `count → totalPages → clamp page → 当页` 分页骨架；前端复用其分页/筛选交互。

### 非目标（YAGNI，明确不做）
- ❌ 状态（open/resolved）筛选 —— 系统当前无「标记已解决」功能，status 恒为 `open`，筛选无意义。待 resolved 功能另案实现后再加。
- ❌ severity 筛选、用户/token 搜索框 —— 用户未要求。
- ❌ 「标记 anomaly 为 resolved」功能本身 —— 独立功能，不在本次范围。
- ❌ 跨页/无限滚动、keyset 分页 —— 异常是稀疏事件，数据量小，OFFSET 分页可接受且与 Trace 一致。
- ❌ 前端分页函数通用化重构 —— 当前仅两个列表，复制比参数化更易读；第三个列表出现时再抽象。

## 3. 关键取舍

### ① 前端分页/筛选函数：复制为 anomaly 专属 vs 通用化参数化
Trace 侧已有一套**有测试覆盖**（`app_traces.test.js`）的函数：`tracePageNumbers` / `parseTraceJumpPage` / `normalizeTracePagination` / `tracePaginationHTML` / `bindTracePagination` / `traceFiltersHTML` / `applyTraceSearch` / `bindTraceSearch`，耦合 `state.traces` / `data-trace-page` / `#trace-jump-page`。

**选择：复制为 anomaly 专属版本**（`anomalyPageNumbers` / `parseAnomalyJumpPage` / `normalizeAnomalyPagination` / `anomalyPaginationHTML` / `bindAnomalyPagination` / `anomalyFiltersHTML` / `applyAnomalyFilter` / `bindAnomalySearch`，绑 `state.anomalies` / `data-anomaly-page` / `#anomaly-jump-page`）。

- 理由：完全不碰已稳定的 Trace UI 与其测试，零回归风险；app.js 无框架，通用化需传 state 切片名 / data 属性 / jump input id / 回调，可读性反而下降。两个列表时复制更直白，YAGNI。

### ② 后端分页类型：重命名通用化 vs 各自重复
`TracePagination{Page,PageSize,TotalItems,TotalPages,HasPrev,HasNext}` 字段完全通用，仅 3 处引用（定义 / `TraceListResult` 字段 / repository 构造）。

**选择：重命名 `TracePagination` → `Pagination`**（通用），Trace 与 anomaly 共用；新增 `AnomalyListResult{Anomalies []AnomalySummary; Pagination Pagination}`。避免出现两个字段一模一样的结构。`normalizeTraceListPage/Limit` 本就不绑 `TraceFilter`，直接复用。

### ③ 类型下拉选项来源：前端硬编码 vs 后端 distinct
**选择：前端硬编码 5 种 live 类型常量 + 「全部」**，label 对齐 `anomaly_reason.go` 文案。简单、确定、与「当前 5 类」现实一致；历史/未知类型是边缘场景，不强行支持筛选（与 `display_reason` 对未知类型回退 `reason` 的策略一致）。

## 4. 设计详述

### 4.1 后端（`internal/admin/`，纯读路径）

**models.go**
- 重命名 `TracePagination` → `Pagination`（字段、JSON tag 不变：`page` / `page_size` / `total_items` / `total_pages` / `has_prev` / `has_next`）。`TraceListResult.Pagination` 改类型为 `Pagination`。
- 新增 `AnomalyFilter { AnomalyType string; Page int; Limit int }`。
- 新增 `AnomalyListResult { Anomalies []AnomalySummary `json:"anomalies"`; Pagination Pagination `json:"pagination"` }`。

**repository.go**
- `ListAnomalies(ctx, filter AnomalyFilter) (AnomalyListResult, error)`：
  - 新增 `anomalyFilterWhereArgs(filter)` → 当 `AnomalyType != ""` 返回 `[]string{"anomaly_type = "}` 与 `[]any{filter.AnomalyType}`，否则返回空 where（与 `traceFilterWhereArgs` 同构，仅等值匹配、无需 ILIKE）。
  - `page := normalizeTraceListPage(filter.Page)`、`limit := normalizeTraceListLimit(filter.Limit)`（复用现成 helper）。
  - `count(*)` 带同样的 where → `totalItems` → `totalPages`（向上取整）→ clamp `page` 到 `[1, totalPages]`（空表 page=1）。
  - 当页查询：`SELECT … WHERE <anomaly_filter> ORDER BY created_at DESC LIMIT $n OFFSET $m`（OFFSET = `(page-1)*limit`），对齐 Trace 的 `listTraceRows` 模式。
  - 返回 `AnomalyListResult{Anomalies, Pagination{…, HasPrev: page>1, HasNext: page<totalPages}}`。
- 删除旧 `ListAnomalies(ctx, limit int)` 签名。已 grep 坐实全仓仅两处调用：`handlers.go:594`（本次改造）与 `handlers_test.go:1273`（测试，迁到新签名）；`LookupTokenSummary` 用独立 count 查询、`listTraceAnomalies`（trace 详情关联异常）是独立函数，均不受影响。

**handlers.go**
- `listAnomalies`：解析 `page`（`strconv.Atoi`+`>0`，与 `listTraces` 一致）与 `anomaly_type`（`strings.TrimSpace`）查询参数 → `AnomalyFilter{Page, Limit:50, AnomalyType}` → `h.repo.ListAnomalies` → `withAnomalyDisplayReasons` → `writeJSON` 返回 `AnomalyListResult`（JSON 形态变为 `{anomalies:[…], pagination:{…}}`）。

### 4.2 迁移（`migrations/0021_anomaly_type_index.sql`，只新增）

```sql
CREATE INDEX IF NOT EXISTS idx_usage_anomalies_type_created
    ON usage_anomalies(anomaly_type, created_at DESC);
```

与现有 `(status,created_at)` / `(username,created_at)` / `(token,created_at)` 三个索引对称，覆盖「按类型筛选 + 时间排序」。`schema_migrations` 由现有执行器维护；不改写已发布迁移。

### 4.3 前端（`internal/adminui/app.js`）

- `state` 新增 `anomalies: { page:1, pageSize:50, anomalyType:"" }`；新增 `anomalyRequestSeq = 0`。
- 类型常量（label 对齐 `anomaly_reason.go`）：
  - `high_trace_tokens` → 高 token 用量
  - `long_output_anomaly` → 超长输出
  - `off_hours_high_usage` → 非工作时间高用量
  - `non_work_use` → 非工作用途
  - `multivariate_anomaly` → 多变量异常
- `loadAnomalies()`：`queryString({page, anomaly_type: state.anomalies.anomalyType})` → `api("/anomalies?…")`，沿用 `requestSeq` 防竞态（与 `loadTraces` 同构）。
- `renderAnomalies(body)` 重写：`normalizeAnomalyPagination(body.pagination)` → `anomalyFiltersHTML()`（一个 `<select>`，选项 = 「全部」+ 5 类型，`value=state.anomalies.anomalyType`）→ 现有表格（列不变）→ `anomalyPaginationHTML(pagination)` → 绑定 `bindAnomalySearch`（select `change` 写回 `state.anomalies.anomalyType`、回到 page=1、重载）/ `bindAnomalyPagination`（页码/跳转，与 trace 同构）。
- `loadView()` 的 `anomalies` 分支：`api("/anomalies")` → `loadAnomalies()`。
- Trace 详情→异常页的回退路径（`renderTraceDetail(detail,"anomalies")` → 返回按钮）不变。

## 5. 数据流

```
用户选类型/翻页
  → state.anomalies.{anomalyType, page} 更新
  → loadAnomalies() → GET /admin/api/anomalies?page=N&anomaly_type=XXX
  → listAnomalies handler → AnomalyFilter → ListAnomalies
      → count(*) with anomaly_type filter → totalPages → clamp page
      → SELECT 当页 (anomaly_type=?, ORDER BY created_at DESC, LIMIT/OFFSET)
  → withAnomalyDisplayReasons → {anomalies:[…], pagination:{…}}
  → renderAnomalies → 筛选栏 + 表格 + 分页栏
```

## 6. 契约边界

- **不碰** Go/Python job 契约（`internal/jobs/` + `workers/analysis_worker/models.py`）、**不碰** worker、**不改** trace 写入或异常产出语义。
- 仅 admin 读路径 + 一个只读索引迁移；admin API `/admin/api/anomalies` 的响应**新增 `pagination` 字段**、`anomalies` 字段语义不变（前端是唯一消费方，同步改造）。

## 7. 测试策略（最窄优先）

- Go `internal/admin/repository_test.go`：`ListAnomalies` 分页（count/totalPages/clamp/空表=page 1）+ `anomaly_type` 筛选（匹配 / 不匹配 / 空=全部）；旧 `ListAnomalies(ctx,limit)` 用例迁移到新签名。
- Go `internal/admin/handlers_test.go`：`GET /admin/api/anomalies?page=2&anomaly_type=non_work_use` 解析参数、响应含 `pagination`。
- 新增 `internal/adminui/app_anomalies.test.js`：`normalizeAnomalyPagination` / `anomalyPageNumbers` / `parseAnomalyJumpPage` / 类型下拉渲染与 `change` 写回 `state.anomalies.anomalyType` + 重置 page=1。
- Makefile 已 glob 全部 `*.test.js`，新测试自动纳入 `make test`（先 Node 后 Go）。
- 验收：`make test` 全绿；本地起栈，异常列表选类型只出对应行、翻页栏页码/跳转可用、与 Trace 列表观感一致。

## 8. Docs 同步

- `ARCHITECTURE.md`：异常列表段落补「按 `anomaly_type` 筛选 + 50 条/页页码分页（与 Trace 同构）」。
- `README.md`：异常列表能力（筛选 + 分页）一句。
- `CLAUDE.md`：无需改（命令/契约语义不变）。

## 9. 验收标准

1. 异常列表出现「类型」下拉，选择某类型后列表仅含该类型记录，选「全部」恢复。
2. 列表底部出现与 Trace 一致的分页栏：首页/上一页/页码/下一页/末页 + 跳转输入；越界/非数字/空值不发请求（与 trace 行为一致）。
3. 每页 50 条；超过 50 条可翻页查看历史异常。
4. `make test`（Node + Go）全绿，含新增的 anomaly 分页/筛选测试。
5. 不引入对 worker / job 契约 / trace 写入路径的任何改动。
