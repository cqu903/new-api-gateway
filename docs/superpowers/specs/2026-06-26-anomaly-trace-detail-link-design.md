# 异常页 → Trace 详情直链 设计

- 日期：2026-06-26
- 状态：已确认，待实现
- 类型：功能增强（admin UI）

## 背景

管理后台的「异常」页（`GET /admin/api/anomalies`）列出 `usage_anomalies` 表里的异常告警，每行展示 ID、时间、Severity、类型、员工、观测值、原因，但**没有任何入口能跳到对应的 trace**。运营人员看到一条异常后，要手动切到 Trace 页、凭用户名/时间反查，体验割裂。

反向链路其实已经存在：trace 详情页（`GET /admin/api/traces/{trace_id}`）底部有「关联异常」表。本次补上缺失的「异常 → trace」方向。

## 目标

- 在异常页，每条异常可直接打开其对应 trace 的详情页。
- 复用现有「trace 列表 → trace 详情」的交互模式（当前页内跳转 + 返回按钮）。

## 非目标（YAGNI）

- 不引入客户端权限门控（前端不预判用户能否看 trace，沿用服务端 403 + 现有错误渲染）。
- 不为 `sample_trace_ids` 多条 trace 做 `+N` / 可展开 UI——当前所有异常检测单位都是单个 trace，数组实际恒为长度 1。
- 不保留返回时的分页位置 / 滚动状态（返回异常页重新拉列表，列表轻量）。
- 不改 trace 详情页「关联异常」表（你已在那个 trace 上，反链无意义）。
- 不碰 worker、不加 migration、不改 Go/Python job payload、不改 trace 状态 / analysis stage。

## 现状（已核实）

- 路由：`GET /admin/api/anomalies` → `Handler.listAnomalies` → `Repository.ListAnomalies(limit)`（权限 `PermissionViewAggregates`）。
- 路由：`GET /admin/api/traces/{trace_id}` → `Handler.getTraceDetail`（权限 `PermissionViewNormalizedTraces`），已存在。
- `AnomalySummary`（`internal/admin/models.go:122`）**没有** trace 字段；`ListAnomalies`（`internal/admin/repository.go:344`）的 SELECT **不取** `sample_trace_ids`。
- `usage_anomalies` 表有 `sample_trace_ids TEXT[]` 列（`migrations/0004_worker_anomaly_coverage.sql:19`）。worker 端所有检测器写入时均为 `sample_trace_ids=[job.trace_id]`（`workers/analysis_worker/rules.py:153/216`、`isolation_forest.py:127`），即每条异常恒对应 1 条 trace。
- 前端 `renderAnomalies`（`internal/adminui/app.js:1471`）渲染静态表，无点击绑定。
- 现成可复用模式：trace 列表 `renderTraces`（`app.js:1349`）用 `traceButton(trace_id)` 生成 `<button data-trace-id>`，渲染后绑定 `[data-trace-id]` 点击 → `api('/traces/{id}')` → `renderTraceDetail(body)`（绑定见 `app.js:1374-1383`）。
- `renderTraceDetail`（`app.js:1406`）的「返回」按钮当前写死 `state.view = "traces"`（`app.js:1466`）。
- DB 驱动为 `pgx/v5`；扫描 `TEXT[]` 有现成模式 `(*pgtype.FlatArray[string])(&field)`（`repository.go:1364` 起的 Keywords/Aliases 即此用法）。

## 设计

### 1. 数据模型与后端（`internal/admin`）

- `AnomalySummary` 新增字段：
  ```go
  SampleTraceIDs []string `json:"sample_trace_ids"`
  ```
- `ListAnomalies` 的 SELECT 增加 `sample_trace_ids`，并在 `rows.Scan` 中以 `(*pgtype.FlatArray[string])(&item.SampleTraceIDs)` 扫描（与现有 Keywords/Aliases 一致）。
- **不改** `listTraceAnomalies`：trace 详情页的「关联异常」不需要 trace 链接。该字段在 trace 详情返回的 anomalies 里为零值（`null`），前端在该页面忽略它。属纯增量、向后兼容（旧消费端不受影响）。

### 2. 前端异常页（`internal/adminui/app.js`）

- `renderAnomalies` 行首新增「Trace」列（与 Trace 列表风格一致，放在最前）：
  - `sample_trace_ids` 非空 → `traceButton(ids[0])`（只取首个；多余元素忽略，不提示）。
  - 为空 → 渲染 `—`。
- 表头对应增加「Trace」列。
- `renderShell` 之后，绑定 `[data-trace-id]` 点击（仿 `renderTraces`）：`api('/traces/{id}')` → `renderTraceDetail(body, "anomalies")`，错误时沿用现有错误面板渲染。

### 3. 返回导航参数化

- `renderTraceDetail` 签名改为 `renderTraceDetail(body, returnView = "traces")`。
- 「返回」按钮 handler：`state.view = returnView; await loadView();`（替换原写死的 `"traces"`）。
- 调用方：`renderTraces` 的点击仍走默认 `"traces"`；异常页的点击传 `"anomalies"`，返回即重拉 `/anomalies` 重渲染异常列表。

### 4. 边界与权限

- `sample_trace_ids` 为空 → 无链接（`—`）。非空 → 仅首个 trace 可点。
- 权限：异常页权限与 trace 详情权限可能不重合。前端无客户端权限信息（导航对所有角色都显示、强制在服务端，为现状），故 trace 链接对所有人都显示；若无 trace 权限，点击 → API 403 → 现有错误渲染展示信息。与当前 nav 行为一致，作为接受行为。

## 测试

- Go `internal/admin`：
  - `handlers_test.go`：扩展 `TestListAnomaliesIncludesDisplayReason`（`handlers_test.go:1271`），在 fake `db.anomalies` 的 `AnomalySummary` 上设置 `SampleTraceIDs`，断言响应 JSON 含 `sample_trace_ids`。
  - `repository_test.go`：`ListAnomalies` 的 mock DB scan 路径需容纳新增的 `sample_trace_ids` 列（参照现有 `scanFuncRow` / `scanAnomalyCount` 模式补一列）。
- 前端 `internal/adminui/`：扩展 `app_traces.test.js`，用例覆盖：
  - 异常页对带 `sample_trace_ids` 的行渲染出 trace 按钮；
  - 点击触发 `renderTraceDetail`（断言进入 trace 详情视图）；
  - 「返回」从异常进入时回到「异常」视图（而非 Trace）。
  - Node `--test`。
- `make test` 同时跑 Node UI 测试（`node --test internal/adminui/*.test.js`）与 `go test ./...`。

## 受影响文件

- `internal/admin/models.go`（`AnomalySummary` 加字段）
- `internal/admin/repository.go`（`ListAnomalies` SELECT + Scan）
- `internal/admin/handlers_test.go`、`internal/admin/repository_test.go`（测试）
- `internal/adminui/app.js`（`renderAnomalies` 加列 + 点击绑定；`renderTraceDetail` 返回参数化）
- `internal/adminui/app_traces.test.js`（前端测试）

## 契约边界影响

只动 Go admin 端 + 前端。不触及 `internal/jobs/` 与 `workers/analysis_worker/models.py` 的 Go/Python 契约，不改 job payload、trace 状态、analysis stage，不加 migration。
