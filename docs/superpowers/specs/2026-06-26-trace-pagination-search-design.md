# Trace 页面：搜索/过滤 + 页码跳转 设计

- 日期：2026-06-26
- worktree：`trace-pagination-search`
- 涉及：`internal/admin/`（Go）、`internal/adminui/`（JS）、测试
- 无 schema 变更、无新迁移、无新索引

## 1. 目标与范围

### 目标
1. **搜索能力**：trace 列表页加一个过滤栏，支持按以下维度筛选：
   - `username`（员工）—— 前缀匹配
   - `trace_id` —— 精确匹配
   - `token_fingerprint` —— 精确匹配
   - `needs_review` —— 布尔开关「仅看待复核」
2. **页码跳转**：翻页栏支持「输入页码 → 跳转」，且跳页/翻页期间保留生效中的过滤条件。

### 非目标（明确不做，YAGNI）
- model / route_pattern 模糊文本搜索
- 状态码（status_code）过滤
- 时间范围（快捷区间 / 自定义起止）过滤
- 每页条数（page size）选择器
- keyset/游标分页、去掉 `count(*)`、近似计数等分页机制改造
- GIN / trigram / 物化视图等新索引或新结构
- 前端「输入即搜」（debounce 自动过滤）

## 2. 现状（改造前的关键事实）

- **前端**（`internal/adminui/app.js`）：trace 列表页只有一张表 + 数字翻页栏（首页/上一页/…/下一页/末页），**完全没有搜索/过滤栏**。`loadTraces()`（约 L685）只拼 `queryString({ page })`；`state.traces = { page, pageSize }`（约 L34）。
- **后端 handler**（`internal/admin/handlers.go` `listTraces`，L325）：已绑定 `trace_id`/`username`/`token_fingerprint`/`route_pattern`/`model`/`page`，`Limit` 写死 50。
- **后端 repo**（`internal/admin/repository.go`）：
  - `traceFilterWhereArgs`（L219）目前全是**精确匹配**（`= $%d`）。
  - `ListTraces`（L290）先 `SELECT count(*)` 再 `listTraceRows`（L247，`LIMIT $n OFFSET $m`），`ORDER BY t.created_at DESC, t.trace_id DESC`。
- **DB**（`migrations/0001_core_schema.sql`）：`trace_id TEXT NOT NULL UNIQUE`；已有索引 `idx_traces_username_created(username_snapshot, created_at)`、`idx_traces_token_created(token_fingerprint, created_at)`、`idx_traces_created_at`。

## 3. 设计

### 3.1 取舍总览
- 保留 **offset 分页 + 每请求一次 `count(*)`**：保证 `totalPages` 准确，页码跳转才可靠；不上 keyset（会牺牲跳页/总页数）。
- **无 schema 变更**：`username` 前缀匹配可用现有 B-tree 索引，`trace_id` 走主键，`token_fingerprint` 走现有索引，`needs_review` 用相关子查询。
- 前端用**显式「搜索」提交**，而非输入即搜（见 §4 的生效过滤约束）。

### 3.2 后端（Go，`internal/admin/`）

**`models.go` — `TraceFilter`**：新增字段
```go
NeedsReview bool
```

**`repository.go` — `traceFilterWhereArgs`**：
- `username`：从精确改为前缀匹配
  ```go
  if filter.Username != "" {
      add("t.username_snapshot ILIKE $%d ESCAPE '\\'", escapeILIKE(filter.Username)+"%")
  }
  ```
  - `escapeILIKE`（新增小 helper）：先转义 `\`、`%`、`_`（前缀 `\`），再在 Go 端拼 `%`，使输入被当字面量（见 §5）。
  - 前缀无前导通配符 → 预期可走 `idx_traces_username_created` 的前缀范围扫描；`ILIKE` 是否命中索引依赖 DB 排序规则，最坏退化为扫描——但不影响结果正确性，仅影响性能。
- `trace_id` / `token_fingerprint`：保持精确（现有逻辑不变）。
- `needs_review`：开关打开时追加
  ```go
  if filter.NeedsReview {
      where = append(where, "EXISTS(SELECT 1 FROM analysis_results WHERE trace_id = t.trace_id AND severity = 'review')")
  }
  ```
  （该 EXISTS 与 `listTraceRows` SELECT 里现有的 `needs_review` 列定义一致，仅多放一份到 WHERE。）

> 关于 `username` 中的 `%`/`_`：`ILIKE` 里它们是元字符。详见 §5 边界处理——需转义，避免用户输入被当通配符。

**`handlers.go` — `listTraces`**：补绑 `needs_review`
```go
NeedsReview: parseBoolQueryParam(r.URL.Query().Get("needs_review")),
```
其中 `parseBoolQueryParam` 为**新增小 helper**（handler 包内，无现成实现）：对 `"1"`/`"true"`（大小写不敏感、trim）返回 true，其余（含缺省）返回 false。`trace_id`/`username`/`token_fingerprint` 已绑定，无需改动。

### 3.3 前端（`internal/adminui/app.js`）

**`state.traces` 扩展**（生效中的过滤条件，约 L34）：
```js
traces: { page: 1, pageSize: 50, username: "", traceId: "", tokenFingerprint: "", needsReview: false }
```

**`loadTraces()`**（约 L685）：把生效过滤拼进参数，空值省略：
```js
const params = queryString({
  page: requestedPage,
  username: state.traces.username,
  trace_id: state.traces.traceId,
  token_fingerprint: state.traces.tokenFingerprint,
  needs_review: state.traces.needsReview ? "1" : "",
});
```

**`renderTraces(body)`**（L1250）：在表格 `<section class="panel">` 上方插入一个过滤面板（复用现有 `.filters`/`.field` 样式，与用量/运行时页一致），包含：
- 用户名（前缀）输入框，初值 = `state.traces.username`
- Trace ID 输入框，初值 = `state.traces.traceId`
- Token 指纹输入框，初值 = `state.traces.tokenFingerprint`
- 「仅看待复核」勾选框，初值 = `state.traces.needsReview`
- 「搜索」按钮（并支持输入框回车提交）

提交语义（`bindTraceSearch`）：
1. 读各输入框当前 DOM 值 → 写回 `state.traces.{username, traceId, tokenFingerprint, needsReview}`
2. `state.traces.page = 1`
3. `renderShell(loading)` + `loadView()`

**翻页栏页码跳转**（`tracePaginationHTML` L1205 / `bindTracePagination` L1235）：
- 在 `pagination-controls` 末尾追加：`跳至 <input type="number" min="1" max="{totalPages}"> 页` + （隐式回车触发）。
- `bindTracePagination` 中给该输入框绑定 `change`/回车：
  - 解析整数 `n`；非数字 / 空 → 不动作；
  - `n < 1` 或 `n > totalPages` → 原地轻提示（如置红框 / title），不发请求；
  - 合法且 `n !== state.traces.page` → `state.traces.page = n` + `loadView()`。

### 3.4 数据流
```
用户填过滤栏 → 点搜索
  → state.traces.* 更新为生效过滤, page=1
  → loadTraces(): GET /admin/api/traces?username=roy&needs_review=1&page=1
  → handler listTraces: 构建 TraceFilter{Username:"roy", NeedsReview:true, Page:1, Limit:50}
  → ListTraces:
       count(*) WHERE username_snapshot ILIKE 'roy%' AND EXISTS(...severity='review')
       list rows  WHERE 同上  ORDER BY created_at DESC, trace_id DESC  LIMIT 50 OFFSET 0
  → 返回 { traces:[...], pagination:{page,page_size,total_items,total_pages,...} }
  → renderTraces: 回填过滤栏初值 + 表格 + 翻页栏(含跳页)

翻页/跳页：仅改 state.traces.page，生效过滤不变 → 同一套 WHERE 跨页一致
```

## 4. 分页正确性保证（为何搜索不会破坏分页）

1. **计数与取数同源 WHERE**：`ListTraces` 的 `count(*)` 与 `listTraceRows` 都调用同一个 `traceFilterWhereArgs(filter)`。所有新过滤（ILIKE / EXISTS）都加在该函数内 → 计数和取数永远用同一谓词 → `totalItems/total_pages` 始终等于实际行数，无幽灵页。
2. **排序为全序，过滤不改排序**：`ORDER BY created_at DESC, trace_id DESC`，`trace_id` 唯一 → 无并列行 → offset 翻页不重不漏。**实现约束：不得从 ORDER BY 移除 `trace_id`。**
3. **trace 按 `created_at` 追加、行不移动**：旧行 `created_at` 不变，offset 在翻页期间稳定（仅新行插入到 DESC 顶端，符合既有行为）。
4. **跳页优雅收敛**：跳页读上一次响应的 `totalPages`；若两次请求间数据变化导致页号越界，后端 `ListTraces` 会把 `page` 钳到 `totalPages` 并返回纠正值，前端按返回值渲染。
5. **生效过滤不变约束（实现关键）**：`state.traces.*` 仅在点「搜索」时更新；翻页/跳页请求一律带当前生效过滤。输入框只是 DOM 编辑态，不直接双向绑定 state —— 否则会出现「计数用过滤 A、取数用过滤 B」的错位。

## 5. 边界与错误处理

- 过滤值为空字符串 / 开关关 → 不加对应 WHERE 子句（保持现状行为）。
- `username` 含 `%` 或 `_`：在 Go 端拼 `%` 前先转义这两个元字符（用 `\` 作 escape char，SQL 写 `ILIKE $n ESCAPE '\'`），使输入被当字面量。
- 跳页输入非数字 / 空 → 不发请求；越界（`<1` 或 `>totalPages`）→ 原地提示，不发请求。
- `needs_review` 过滤命中 0 条 → 复用现有「共 0 条」空态。
- 切换过滤条件后 `page` 超出新 `totalPages`：后端钳到末页，前端以响应里的 `pagination.page` 为准（`normalizeTracePagination` 已处理）。
- 不记录、不持久化明文 token：`token_fingerprint` 本身是 HMAC 指纹/脱敏值，过滤只走该列，符合数据安全约定。

## 6. 测试

### Go（`internal/admin/`，`go test`）
沿用现有 handler/repo 测试的「内存 DB + 录制/断言 SQL」模式（见 `handlers_test.go` 的 `memoryAdminDB`、`repository_test.go`）：
- `traceFilterWhereArgs`：`username` 非空 → 生成 `ILIKE` 子句且参数以 `%` 结尾；含 `_`/`%` 时被转义；空值不生成子句；`needs_review=true` → 生成 EXISTS 子句，`false` → 不生成；`trace_id`/`token_fingerprint` 精确子句不变。
- handler `listTraces`：`needs_review=1`/`true` → `TraceFilter.NeedsReview` 为 true；其它值/缺省 → false；`username` 透传到 repo。
- repo `ListTraces`：带过滤时 `total_items` 反映过滤后行数；`total_pages` 与之一致（断言计数与取数同源 WHERE）。

### JS（`internal/adminui/`，`node --test`，`make test` 会先跑）
按 `app_usage_integration.test.js` 模式新建 traces 测试，覆盖：
- `loadTraces` / 参数构造：生效过滤被拼进 query string（`username`/`trace_id`/`token_fingerprint`/`needs_review=1`），空值省略。
- 过滤栏 HTML：含全部字段，且输入框初值从 `state.traces` 正确回填。
- 跳页校验：合法页号 → 触发 `loadView` 且 `state.traces.page` 更新；越界 / 非数字 → 不触发、不更新。
- 提交语义：点搜索 → `state.traces.*` 更新、`page` 重置为 1。

## 7. 文档同步
按 CLAUDE.md「Docs To Sync」：若涉及用户可见的 admin UI 行为变化，检查 `README.md` / `ARCHITECTURE.md` 是否需要补一句 trace 列表支持过滤与页码跳转（预计改动很小，可能仅需 README 截图/说明处一行）。

## 8. 风险与回滚
- 风险低：无 schema/迁移/索引变更，纯 Go + JS + 测试。
- `traceFilterWhereArgs` 的调用面核查（已确认）：
  - `ListTraces` 的 count 与 `listTraceRows` 取数都走它 → §4 的「同源 WHERE」保证一致。
  - `LookupTokenSummary`（L411）只传 `TokenFingerprint`（保持精确，未改）+ `Page/Limit`，`Username` 为空、`NeedsReview` 为零值 false → **不受本次改动影响**。
  - 即：`username` 改为 `ILIKE`、新增 `needs_review` 只在 traces 列表 handler 这一条路径生效，不影响 token 反查。
- 回滚：revert 该分支提交即可，不影响数据。
