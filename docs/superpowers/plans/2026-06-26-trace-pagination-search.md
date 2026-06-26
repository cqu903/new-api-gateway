# Trace 页面搜索/过滤 + 页码跳转 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 admin trace 列表页加搜索/过滤栏（username 前缀、trace_id/token 精确、needs_review 开关）+ 翻页栏「输入页码跳转」，并在翻页期间保留生效中的过滤条件。

**Architecture:** 后端在现有 offset 分页 + `traceFilterWhereArgs` 基础上扩展 WHERE（username 改 ILIKE 前缀、新增 needs_review EXISTS 子查询）、handler 补绑 `needs_review`；前端扩展 `state.traces` 存「生效过滤」，过滤栏显式提交后写回 state 并重置到第 1 页，翻页/跳页只改 page 不动过滤。计数与取数同源 WHERE 保证分页正确。

**Tech Stack:** Go（`internal/admin/`，pgx）、原生 JS（`internal/adminui/app.js`，`node --test` + vm 沙箱）、PostgreSQL。

**参考 spec：** `docs/superpowers/specs/2026-06-26-trace-pagination-search-design.md`

## Global Constraints

- **无 schema / 无新迁移 / 无新索引**：不新增 `migrations/NNNN_*.sql`，不改 `traces` 表结构。username 前缀走现有 `idx_traces_username_created`，trace_id 走主键，token_fingerprint 走 `idx_traces_token_created`，needs_review 用相关子查询。
- **不改排序**：`ORDER BY t.created_at DESC, t.trace_id DESC` 必须保持（`trace_id` 唯一 → 全序 → offset 翻页不重不漏）。任何任务都不得移除 `trace_id` 排序键。
- **同源 WHERE**：`traceFilterWhereArgs` 被 count 与 list 共用，新增过滤必须加在该函数内（不能只加到其中一条 SQL）。
- **数据安全**：`token_fingerprint` 是 HMAC 指纹/脱敏值，过滤只走该列；不记录、不持久化明文 key。
- **语言**：UI 文案中文，标识符/错误文本沿用现有（英文）。
- **验证命令**：`make test`（先 `node --test internal/adminui/*.test.js`，再 `go test ./...`）；窄验证用 `go test ./internal/admin/...` 或 `node --test internal/adminui/app_traces.test.js`。

---

## File Structure

**修改：**
- `internal/admin/models.go` — `TraceFilter` 加 `NeedsReview bool` 字段。
- `internal/admin/repository.go` — 新增 `escapeILIKE`；`traceFilterWhereArgs` 改 username 为 ILIKE、加 needs_review EXISTS。
- `internal/admin/handlers.go` — 新增 `parseBoolQueryParam`；`listTraces` 补绑 `needs_review`。
- `internal/admin/repository_test.go` — 更新 `TestRepositoryListTracesBindsFiltersAndCapsLimit`；新增 ILIKE/escape/EXISTS 测试。
- `internal/admin/handlers_test.go` — 新增 `parseBoolQueryParam` 测试。
- `internal/adminui/app.js` — 扩展 `state.traces`；`loadTraces` 带过滤参数；新增 `traceFiltersHTML`/`bindTraceSearch`/`applyTraceSearch`/`parseTraceJumpPage`；`renderTraces` 插过滤栏；`tracePaginationHTML`/`bindTracePagination` 加跳页。
- `internal/adminui/app_traces.test.js`（新建）— traces 前端逻辑测试。
- `README.md` / `ARCHITECTURE.md`（仅在有用户可见行为描述需要同步时）。

**职责边界：** 纯逻辑（`escapeILIKE`/`parseBoolQueryParam`/`parseTraceJumpPage`）独立可测；过滤条件构造集中在 `traceFilterWhereArgs`；前端「生效过滤」集中在 `state.traces`，DOM 读写集中在 `applyTraceSearch`/`bindTracePagination`。

---

## Task 1: 后端纯 helper（escapeILIKE + parseBoolQueryParam）+ TraceFilter 字段

**Files:**
- Modify: `internal/admin/models.go:78-87`（`TraceFilter`）
- Modify: `internal/admin/repository.go`（新增 `escapeILIKE`）
- Modify: `internal/admin/handlers.go`（新增 `parseBoolQueryParam`）
- Test: `internal/admin/handlers_test.go`（`parseBoolQueryParam`）
- Test: `internal/admin/repository_test.go`（`escapeILIKE`）

**Interfaces:**
- Produces: `escapeILIKE(s string) string`（repository.go，包内）、`parseBoolQueryParam(raw string) bool`（handlers.go，包内）、`TraceFilter.NeedsReview bool`。Task 2 消费这三者。

- [ ] **Step 1: 写失败测试 — `escapeILIKE`**

在 `internal/admin/repository_test.go` 末尾追加：

```go
func TestEscapeILIKEEscapesMetacharacters(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"plain", "plain"},
		{"a_b", `a\_b`},
		{"a%c", `a\%c`},
		{`a\b`, `a\\b`},
		{"a_b%c", `a\_b\%c`},
	}
	for _, c := range cases {
		if got := escapeILIKE(c.in); got != c.want {
			t.Fatalf("escapeILIKE(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
```

- [ ] **Step 2: 运行，确认失败**

Run: `go test ./internal/admin/ -run TestEscapeILIKEEscapesMetacharacters -v`
Expected: FAIL（`undefined: escapeILIKE`）。

- [ ] **Step 3: 实现 `escapeILIKE`**

在 `internal/admin/repository.go` 的 `traceFilterWhereArgs` 上方新增：

```go
// escapeILIKE 转义 ILIKE 元字符（\ % _），配合 SQL 的 ESCAPE '\' 使用，
// 使外部输入被当字面量而非通配符。escape char 固定为反斜杠。
func escapeILIKE(s string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return replacer.Replace(s)
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `go test ./internal/admin/ -run TestEscapeILIKEEscapesMetacharacters -v`
Expected: PASS。

- [ ] **Step 5: 写失败测试 — `parseBoolQueryParam`**

在 `internal/admin/handlers_test.go` 末尾追加：

```go
func TestParseBoolQueryParam(t *testing.T) {
	truthy := []string{"1", "true", "TRUE", "True", " 1 ", " true "}
	falsy := []string{"", "0", "false", "no", "bogus", "  "}
	for _, v := range truthy {
		if !parseBoolQueryParam(v) {
			t.Fatalf("parseBoolQueryParam(%q) = false, want true", v)
		}
	}
	for _, v := range falsy {
		if parseBoolQueryParam(v) {
			t.Fatalf("parseBoolQueryParam(%q) = true, want false", v)
		}
	}
}
```

- [ ] **Step 6: 运行，确认失败**

Run: `go test ./internal/admin/ -run TestParseBoolQueryParam -v`
Expected: FAIL（`undefined: parseBoolQueryParam`）。

- [ ] **Step 7: 实现 `parseBoolQueryParam`**

在 `internal/admin/handlers.go` 的 `listTraces` 上方新增：

```go
// parseBoolQueryParam 解析查询参数里的布尔值：仅 "1" / "true"（大小写不敏感、trim）为真，其余为假。
func parseBoolQueryParam(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true":
		return true
	default:
		return false
	}
}
```

- [ ] **Step 8: 运行，确认通过**

Run: `go test ./internal/admin/ -run TestParseBoolQueryParam -v`
Expected: PASS。

- [ ] **Step 9: 加 `TraceFilter.NeedsReview` 字段**

修改 `internal/admin/models.go` 的 `TraceFilter`：

```go
type TraceFilter struct {
	TraceID          string
	Username         string
	TokenFingerprint string
	RoutePattern     string
	Model            string
	StatusCode       int
	NeedsReview      bool
	Page             int
	Limit            int
}
```

- [ ] **Step 10: 编译 + 全 admin 包测试不回归**

Run: `go build ./internal/admin/... && go test ./internal/admin/...`
Expected: 编译通过，所有现有测试 PASS（新字段零值 false，对 `LookupTokenSummary` 等用命名字段构造的调用无影响）。

- [ ] **Step 11: 提交**

```bash
git add internal/admin/models.go internal/admin/repository.go internal/admin/handlers.go internal/admin/repository_test.go internal/admin/handlers_test.go
git commit -m "feat(admin): add escapeILIKE + parseBoolQueryParam helpers and TraceFilter.NeedsReview"
```

---

## Task 2: 接线过滤逻辑（traceFilterWhereArgs + handler）

**Files:**
- Modify: `internal/admin/repository.go:219-244`（`traceFilterWhereArgs`）
- Modify: `internal/admin/handlers.go:332-340`（`listTraces` 的 `filter`）
- Test: `internal/admin/repository_test.go`（更新 + 新增）

**Interfaces:**
- Consumes: `escapeILIKE`、`parseBoolQueryParam`、`TraceFilter.NeedsReview`（Task 1）。
- Produces: `traceFilterWhereArgs` 对 `Username`/`NeedsReview` 的新行为；handler 把 `needs_review` 查询参数映射到 `TraceFilter.NeedsReview`。

- [ ] **Step 1: 更新现有测试断言（username 现在是 ILIKE）**

`TestRepositoryListTracesBindsFiltersAndCapsLimit`（`repository_test.go:416`）当前断言 `t.username_snapshot = $2` 与 6 个 count 参数。username 改 ILIKE 后，count SQL 里是 `t.username_snapshot ILIKE $2 ESCAPE '\'`，且第 2 个参数变为 `E10001%`。把该测试的断言段（约 L441-L457）替换为：

```go
	if !strings.Contains(db.querySQLs[0], "t.trace_id = $1") ||
		!strings.Contains(db.querySQLs[0], `t.username_snapshot ILIKE $2 ESCAPE '\'`) ||
		!strings.Contains(db.querySQLs[0], "t.token_fingerprint = $3") ||
		!strings.Contains(db.querySQLs[0], "t.route_pattern = $4") ||
		!strings.Contains(db.querySQLs[0], "t.model_requested = $5") ||
		!strings.Contains(db.querySQLs[0], "t.status_code = $6") {
		t.Fatalf("count query filters = %s", db.querySQLs[0])
	}
	if strings.Contains(db.querySQLs[1], "500") {
		t.Fatalf("list query interpolated raw limit: %s", db.querySQLs[1])
	}
	if got := db.queryArgsLog[0]; len(got) != 6 || got[1] != "E10001%" {
		t.Fatalf("count query args = %#v, want 6 filters with username='E10001%%'", got)
	}
	if got := db.queryArgsLog[1]; len(got) != 8 || got[6] != 100 || got[7] != 0 {
		t.Fatalf("list query args = %#v, want filters + [100 0]", got)
	}
```

> 用 Go 反引号原始字符串（`` `...ESCAPE '\'` ``）断言，避免双引号字符串里反斜杠转义的歧义。

- [ ] **Step 2: 运行，确认失败（实现还没改，断言已是新期望）**

Run: `go test ./internal/admin/ -run TestRepositoryListTracesBindsFiltersAndCapsLimit -v`
Expected: FAIL（当前实现仍是 `=`，不包含 `ILIKE ... ESCAPE`，且 username 参数是 `E10001` 非 `E10001%`）。

- [ ] **Step 3: 实现 — `traceFilterWhereArgs` username 改 ILIKE**

修改 `internal/admin/repository.go:226-228`，把：

```go
	if filter.Username != "" {
		add("t.username_snapshot = $%d", filter.Username)
	}
```

改为：

```go
	if filter.Username != "" {
		add("t.username_snapshot ILIKE $%d ESCAPE '\\'", escapeILIKE(filter.Username)+"%")
	}
```

- [ ] **Step 4: 运行，确认通过**

Run: `go test ./internal/admin/ -run TestRepositoryListTracesBindsFiltersAndCapsLimit -v`
Expected: PASS。

- [ ] **Step 5: 写失败测试 — username ILIKE 前缀 + 转义（独立用例）**

在 `repository_test.go` 追加：

```go
func TestRepositoryListTracesUsernameUsesILIKEPrefix(t *testing.T) {
	db := &recordingAdminDB{
		rowQueue: []pgx.Row{
			scanFuncRow{scan: func(dest ...any) error { *(dest[0].(*int64)) = int64(0); return nil }},
		},
		rowsQueue: []pgx.Rows{&fakeRows{}},
	}
	repo := NewRepository(db)

	_, err := repo.ListTraces(context.Background(), TraceFilter{Username: "roy", Page: 1, Limit: 50})
	if err != nil {
		t.Fatalf("ListTraces error: %v", err)
	}
	// count 与 list 都应是 ILIKE 前缀
	for i, sql := range db.querySQLs {
		if !strings.Contains(sql, `username_snapshot ILIKE $1 ESCAPE '\'`) {
			t.Fatalf("query[%d] missing ILIKE prefix: %s", i, sql)
		}
	}
	if got := db.queryArgsLog[0]; len(got) != 1 || got[0] != "roy%" {
		t.Fatalf("count username arg = %#v, want [roy%%]", got)
	}
	// list 参数 = [roy%, 50, 0]
	if got := db.queryArgsLog[1]; len(got) != 3 || got[0] != "roy%" || got[1] != 50 || got[2] != 0 {
		t.Fatalf("list args = %#v, want [roy%% 50 0]", got)
	}
}

func TestRepositoryListTracesUsernameEscapesMetaChars(t *testing.T) {
	db := &recordingAdminDB{
		rowQueue: []pgx.Row{
			scanFuncRow{scan: func(dest ...any) error { *(dest[0].(*int64)) = int64(0); return nil }},
		},
		rowsQueue: []pgx.Rows{&fakeRows{}},
	}
	repo := NewRepository(db)

	_, _ = repo.ListTraces(context.Background(), TraceFilter{Username: "a_b%c", Page: 1, Limit: 50})
	if got := db.queryArgsLog[0]; len(got) != 1 || got[0] != `a\_b\%c%` {
		t.Fatalf("escaped username arg = %#v, want [a\\_b\\%%c + trailing %%]", got)
	}
}
```

- [ ] **Step 6: 运行，确认通过（实现已在 Step 3 完成）**

Run: `go test ./internal/admin/ -run 'TestRepositoryListTracesUsername' -v`
Expected: PASS。

- [ ] **Step 7: 写失败测试 — needs_review EXISTS 出现在 count 与 list 两条 SQL**

在 `repository_test.go` 追加：

```go
func TestRepositoryListTracesNeedsReviewAddsExistsToBothQueries(t *testing.T) {
	db := &recordingAdminDB{
		rowQueue: []pgx.Row{
			scanFuncRow{scan: func(dest ...any) error { *(dest[0].(*int64)) = int64(0); return nil }},
		},
		rowsQueue: []pgx.Rows{&fakeRows{}},
	}
	repo := NewRepository(db)

	_, err := repo.ListTraces(context.Background(), TraceFilter{NeedsReview: true, Page: 1, Limit: 50})
	if err != nil {
		t.Fatalf("ListTraces error: %v", err)
	}
	const existsClause = "EXISTS(SELECT 1 FROM analysis_results WHERE trace_id = t.trace_id AND severity = 'review')"
	for i, sql := range db.querySQLs {
		if !strings.Contains(sql, existsClause) {
			t.Fatalf("query[%d] missing needs_review EXISTS: %s", i, sql)
		}
	}
	// EXISTS 不带位置参数 → count 参数为 0，list 参数 = [limit, offset]
	if got := db.queryArgsLog[0]; len(got) != 0 {
		t.Fatalf("count args = %#v, want 0 (EXISTS adds no positional arg)", got)
	}
	if got := db.queryArgsLog[1]; len(got) != 2 || got[0] != 50 || got[1] != 0 {
		t.Fatalf("list args = %#v, want [50 0]", got)
	}
}

func TestRepositoryListTracesNeedsReviewOffOmitsExists(t *testing.T) {
	db := &recordingAdminDB{
		rowQueue: []pgx.Row{
			scanFuncRow{scan: func(dest ...any) error { *(dest[0].(*int64)) = int64(0); return nil }},
		},
		rowsQueue: []pgx.Rows{&fakeRows{}},
	}
	repo := NewRepository(db)

	_, _ = repo.ListTraces(context.Background(), TraceFilter{NeedsReview: false, Page: 1, Limit: 50})
	if strings.Contains(db.querySQLs[0], "EXISTS(SELECT 1 FROM analysis_results") {
		t.Fatalf("count query unexpectedly includes EXISTS: %s", db.querySQLs[0])
	}
}
```

- [ ] **Step 8: 运行，确认失败**

Run: `go test ./internal/admin/ -run 'TestRepositoryListTracesNeedsReview' -v`
Expected: FAIL（`traceFilterWhereArgs` 还没加 EXISTS 分支）。

- [ ] **Step 9: 实现 — `traceFilterWhereArgs` 加 needs_review EXISTS**

在 `internal/admin/repository.go` 的 `traceFilterWhereArgs` 里，`StatusCode` 分支之后、`return` 之前追加：

```go
	if filter.NeedsReview {
		where = append(where, "EXISTS(SELECT 1 FROM analysis_results WHERE trace_id = t.trace_id AND severity = 'review')")
	}
```

（用 `where = append(...)` 而非 `add`，因为该子句不带位置参数；放在最后，不影响其它 `$%d` 编号。）

- [ ] **Step 10: 运行，确认通过**

Run: `go test ./internal/admin/ -run 'TestRepositoryListTracesNeedsReview' -v`
Expected: PASS。

- [ ] **Step 11: handler 补绑 `needs_review`**

修改 `internal/admin/handlers.go` 的 `listTraces` 里 `filter := TraceFilter{...}`（L332），加一行：

```go
	filter := TraceFilter{
		TraceID:          r.URL.Query().Get("trace_id"),
		Username:         r.URL.Query().Get("username"),
		TokenFingerprint: r.URL.Query().Get("token_fingerprint"),
		RoutePattern:     r.URL.Query().Get("route_pattern"),
		Model:            r.URL.Query().Get("model"),
		NeedsReview:      parseBoolQueryParam(r.URL.Query().Get("needs_review")),
		Page:             page,
		Limit:            50,
	}
```

- [ ] **Step 12: 全 admin 包测试 + `LookupTokenSummary` 无回归**

Run: `go test ./internal/admin/...`
Expected: 全部 PASS。重点确认 `TestRepositoryLookupTokenSummary*` 仍通过（`LookupTokenSummary` 只传 `TokenFingerprint`，username 空/NeedsReview 零值 → SQL 不受影响）。

- [ ] **Step 13: 提交**

```bash
git add internal/admin/repository.go internal/admin/handlers.go internal/admin/repository_test.go
git commit -m "feat(admin): trace list filter — username ILIKE prefix + needs_review EXISTS, bind needs_review param"
```

---

## Task 3: 前端 state + loadTraces 带过滤参数

**Files:**
- Modify: `internal/adminui/app.js:34-37`（`state.traces`）
- Modify: `internal/adminui/app.js:685-702`（`loadTraces`）
- Test: `internal/adminui/app_traces.test.js`（新建）

**Interfaces:**
- Produces: `state.traces.{username, traceId, tokenFingerprint, needsReview}`（生效过滤）；`loadTraces()` 会把这四个值拼进 `/traces?...` 查询串。Task 4/5 消费 `state.traces`。

- [ ] **Step 1: 新建测试文件 + 写失败测试（loadTraces URL）**

创建 `internal/adminui/app_traces.test.js`，写入测试 harness 与第一个用例。harness 参考 `app_usage_integration.test.js`，但导出 traces 相关函数：

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadAppModule(overrides = {}) {
  const sourcePath = path.join(__dirname, "app.js");
  const source = fs.readFileSync(sourcePath, "utf8").replace(/\nboot\(\);\s*$/, "\n");
  const fakeApp = { innerHTML: "" };
  const fakeElement = { addEventListener() {}, removeEventListener() {}, getAttribute() { return ""; }, matches() { return false; }, closest() { return null; }, style: {}, textContent: "" };
  const sandbox = {
    console,
    setTimeout: overrides.setTimeout || setTimeout,
    clearTimeout: overrides.clearTimeout || clearTimeout,
    URLSearchParams,
    FormData,
    document: {
      cookie: "",
      body: { appendChild() {} },
      getElementById() { return null; },
      createElement() { return { className: "", textContent: "", style: {}, getBoundingClientRect() { return { width: 0, height: 0 }; }, remove() {} }; },
      querySelector(selector) {
        if (typeof overrides.querySelector === "function") {
          const r = overrides.querySelector(selector);
          if (r !== undefined) return r;
        }
        if (selector === "#app") return fakeApp;
        return null;
      },
      querySelectorAll() { return []; },
    },
    window: { innerHeight: 900, innerWidth: 1440, UsagePage: { renderUsagePage: () => "" }, AdminAnalysisResultCards: { renderAnalysisResultCards: () => "" }, Chart: overrides.Chart || function Chart() {} },
    fetch: overrides.fetch || (async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" })),
    module: { exports: {} },
    exports: {},
  };
  vm.runInNewContext(
    `${source}
module.exports = {
  state,
  loadTraces,
  renderTraces,
  applyTraceSearch: typeof applyTraceSearch !== "undefined" ? applyTraceSearch : undefined,
  parseTraceJumpPage: typeof parseTraceJumpPage !== "undefined" ? parseTraceJumpPage : undefined,
};`,
    sandbox,
  );
  return { app: sandbox.module.exports, fakeApp };
}

test("loadTraces includes active filters in the query string and omits empties", async () => {
  const calls = [];
  const { app } = loadAppModule({
    fetch: async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ traces: [], pagination: { page: 1, page_size: 50, total_items: 0, total_pages: 0, has_prev: false, has_next: false } }), text: async () => "" };
    },
  });
  app.state.view = "traces";
  app.state.traces.username = "roy";
  app.state.traces.traceId = "";
  app.state.traces.tokenFingerprint = "";
  app.state.traces.needsReview = true;

  await app.loadTraces();

  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/admin\/api\/traces\?/);
  assert.match(calls[0], /username=roy/);
  assert.match(calls[0], /needs_review=1/);
  assert.match(calls[0], /page=1/);
  assert.doesNotMatch(calls[0], /trace_id=/);
  assert.doesNotMatch(calls[0], /token_fingerprint=/);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test internal/adminui/app_traces.test.js`
Expected: FAIL（`state.traces.username` 等字段不存在 → undefined；`needs_review` 不会被拼上）。

- [ ] **Step 3: 扩展 `state.traces`**

修改 `internal/adminui/app.js:34-37`：

```js
  traces: {
    page: 1,
    pageSize: 50,
    username: "",
    traceId: "",
    tokenFingerprint: "",
    needsReview: false,
  },
```

- [ ] **Step 4: 扩展 `loadTraces` 拼过滤参数**

修改 `internal/adminui/app.js` 的 `loadTraces`（约 L685），把：

```js
  const requestedPage = Math.max(1, finiteNumber(state.traces.page) || 1);
  const params = queryString({ page: requestedPage });
```

改为：

```js
  const requestedPage = Math.max(1, finiteNumber(state.traces.page) || 1);
  const params = queryString({
    page: requestedPage,
    username: state.traces.username,
    trace_id: state.traces.traceId,
    token_fingerprint: state.traces.tokenFingerprint,
    needs_review: state.traces.needsReview ? "1" : "",
  });
```

（`queryString` 已自动省略空串，故空过滤不会出现在 URL。）

- [ ] **Step 5: 运行，确认通过**

Run: `node --test internal/adminui/app_traces.test.js`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add internal/adminui/app.js internal/adminui/app_traces.test.js
git commit -m "feat(adminui): extend trace state + loadTraces with active filter params"
```

---

## Task 4: 前端过滤栏 UI + 提交语义

**Files:**
- Modify: `internal/adminui/app.js`（新增 `traceFiltersHTML`/`bindTraceSearch`/`applyTraceSearch`；改 `renderTraces`）
- Test: `internal/adminui/app_traces.test.js`

**Interfaces:**
- Produces: `traceFiltersHTML()`（读 `state.traces` 生成过滤栏 HTML，输入框回填生效值）；`applyTraceSearch()`（读 DOM 输入 → 写回 `state.traces.*` + `page=1`）；`bindTraceSearch()`（绑表单 submit）。`renderTraces` 在表格上方插入过滤栏并调用 `bindTraceSearch`。

- [ ] **Step 1: 写失败测试 — 过滤栏 HTML + 回填**

在 `app_traces.test.js` 追加：

```js
test("renderTraces emits a filter bar whose inputs are prefilled from active filters", () => {
  const { app, fakeApp } = loadAppModule();
  app.state.view = "traces";
  app.state.traces.username = "roy";
  app.state.traces.tokenFingerprint = "tkfp_abc";
  app.state.traces.needsReview = true;

  app.renderTraces({ traces: [], pagination: { page: 1, page_size: 50, total_items: 90, total_pages: 2, has_prev: false, has_next: true } });

  assert.match(fakeApp.innerHTML, /id="trace-filters"/);
  assert.match(fakeApp.innerHTML, /id="trace-filter-username"[^>]*value="roy"/);
  assert.match(fakeApp.innerHTML, /id="trace-filter-token"[^>]*value="tkfp_abc"/);
  assert.match(fakeApp.innerHTML, /id="trace-filter-needs-review"[^>]*checked/);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test internal/adminui/app_traces.test.js`
Expected: FAIL（`renderTraces` 还没渲染过滤栏，innerHTML 里没有 `trace-filters`）。

- [ ] **Step 3: 实现 `traceFiltersHTML`**

在 `internal/adminui/app.js` 的 `renderTraces`（L1250）上方新增：

```js
function traceFiltersHTML() {
  return `
    <section class="panel">
      <form class="filters" id="trace-filters" autocomplete="off">
        <div class="field">
          <label for="trace-filter-username">员工 (前缀)</label>
          <input type="text" id="trace-filter-username" name="username" value="${escapeHTML(state.traces.username)}" placeholder="例如 E1001">
        </div>
        <div class="field">
          <label for="trace-filter-trace-id">Trace ID</label>
          <input type="text" id="trace-filter-trace-id" name="trace_id" value="${escapeHTML(state.traces.traceId)}" placeholder="精确匹配">
        </div>
        <div class="field">
          <label for="trace-filter-token">Token 指纹</label>
          <input type="text" id="trace-filter-token" name="token_fingerprint" value="${escapeHTML(state.traces.tokenFingerprint)}" placeholder="精确匹配">
        </div>
        <div class="field">
          <label class="checkbox">
            <input type="checkbox" id="trace-filter-needs-review" name="needs_review" value="1" ${state.traces.needsReview ? "checked" : ""}>
            仅看待复核
          </label>
        </div>
        <div class="field">
          <button type="submit" class="primary">搜索</button>
        </div>
      </form>
    </section>
  `;
}
```

- [ ] **Step 4: 在 `renderTraces` 插入过滤栏（仅 HTML）**

修改 `renderTraces` 的 `renderShell(page("Trace", \`<section class="panel">...\`))`（L1267-1273），把 `${traceFiltersHTML()}` 放在表格 panel 之前。**本步只加 HTML，先不调用 `bindTraceSearch`**（它下一周期才实现并接线）：

```js
  renderShell(
    page(
      "Trace",
      `${traceFiltersHTML()}<section class="panel">${table(["Trace", "时间 (UTC+8)", "员工", "Model", "Route", "Status", "Input", "Output", "Cached", "Total"], rows)}${tracePaginationHTML(pagination)}</section>`,
    ),
  );
  bindTracePagination();
```

- [ ] **Step 5: 运行，确认通过**

Run: `node --test internal/adminui/app_traces.test.js`
Expected: 过滤栏 HTML 用例 PASS（`bindTraceSearch` 的接线在下一周期补）。

- [ ] **Step 6: 写失败测试 — `applyTraceSearch` 读 DOM 写 state + 重置 page**

在 `app_traces.test.js` 追加：

```js
test("applyTraceSearch reads filter inputs into state and resets page to 1", () => {
  const fakes = {
    "#trace-filter-username": { value: " roy " },
    "#trace-filter-trace-id": { value: " trace_9 " },
    "#trace-filter-token": { value: "" },
    "#trace-filter-needs-review": { checked: true },
  };
  const { app } = loadAppModule({ querySelector: (sel) => fakes[sel] });
  app.state.traces.page = 5;
  app.state.traces.username = "stale";

  app.applyTraceSearch();

  assert.equal(app.state.traces.username, "roy");
  assert.equal(app.state.traces.traceId, "trace_9");
  assert.equal(app.state.traces.tokenFingerprint, "");
  assert.equal(app.state.traces.needsReview, true);
  assert.equal(app.state.traces.page, 1);
});
```

- [ ] **Step 7: 运行，确认失败**

Run: `node --test internal/adminui/app_traces.test.js`
Expected: FAIL（`applyTraceSearch` 未定义 → 模块导出为 undefined，`app.applyTraceSearch` 不是函数）。

- [ ] **Step 8: 实现 `applyTraceSearch` + `bindTraceSearch`**

在 `traceFiltersHTML` 下方新增：

```js
// applyTraceSearch 把过滤栏当前 DOM 值写回 state.traces（生效过滤）并重置到第 1 页。
// 与「生效过滤不变」约束配合：翻页/跳页不改这里读写的字段，只改 page。
function applyTraceSearch() {
  const username = document.querySelector("#trace-filter-username");
  const traceId = document.querySelector("#trace-filter-trace-id");
  const token = document.querySelector("#trace-filter-token");
  const needsReview = document.querySelector("#trace-filter-needs-review");
  state.traces.username = username ? username.value.trim() : "";
  state.traces.traceId = traceId ? traceId.value.trim() : "";
  state.traces.tokenFingerprint = token ? token.value.trim() : "";
  state.traces.needsReview = needsReview ? needsReview.checked : false;
  state.traces.page = 1;
}

function bindTraceSearch() {
  const form = document.querySelector("#trace-filters");
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    applyTraceSearch();
    renderShell(`<section class="loading-panel">正在加载Trace...</section>`);
    await loadView();
  });
}
```

- [ ] **Step 9: 在 `renderTraces` 接线 `bindTraceSearch`**

回到 `renderTraces`（Step 4 改过的位置），在 `bindTracePagination();` 之前加一行 `bindTraceSearch();`：

```js
  bindTraceSearch();
  bindTracePagination();
```

（`bindTraceSearch` 已在 Step 8 定义，此处接线安全；找不到 `#trace-filters` 时它直接 return，不影响渲染。）

- [ ] **Step 10: 运行，确认通过**

Run: `node --test internal/adminui/app_traces.test.js`
Expected: 全部用例 PASS（过滤栏 HTML + applyTraceSearch）。

- [ ] **Step 11: 提交**

```bash
git add internal/adminui/app.js internal/adminui/app_traces.test.js
git commit -m "feat(adminui): trace filter bar (username/trace_id/token/needs_review) with explicit submit"
```

---

## Task 5: 前端页码跳转

**Files:**
- Modify: `internal/adminui/app.js`（新增 `parseTraceJumpPage`；改 `tracePaginationHTML` + `bindTracePagination`）
- Test: `internal/adminui/app_traces.test.js`

**Interfaces:**
- Produces: `parseTraceJumpPage(raw, totalPages)`（纯函数，返回合法页码或 `null`）；翻页栏含 `#trace-jump-page` 输入 + `#trace-jump-go` 按钮；`bindTracePagination` 绑定回车/点击跳转，越界/非数字不发请求。

- [ ] **Step 1: 写失败测试 — `parseTraceJumpPage` 纯校验**

在 `app_traces.test.js` 追加：

```js
test("parseTraceJumpPage validates page input against total pages", () => {
  const { app } = loadAppModule();
  const total = 5;
  assert.equal(app.parseTraceJumpPage("3", total), 3);
  assert.equal(app.parseTraceJumpPage(" 2 ", total), 2);
  assert.equal(app.parseTraceJumpPage("1", total), 1);
  assert.equal(app.parseTraceJumpPage("5", total), 5);
  assert.equal(app.parseTraceJumpPage("", total), null);
  assert.equal(app.parseTraceJumpPage("abc", total), null);
  assert.equal(app.parseTraceJumpPage("0", total), null);
  assert.equal(app.parseTraceJumpPage("6", total), null);
  assert.equal(app.parseTraceJumpPage("-1", total), null);
  assert.equal(app.parseTraceJumpPage("2.5", total), null);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test internal/adminui/app_traces.test.js`
Expected: FAIL（`parseTraceJumpPage` 未定义 → 模块导出里是 undefined，`app.parseTraceJumpPage` 不是函数）。

- [ ] **Step 3: 实现 `parseTraceJumpPage`**

在 `internal/adminui/app.js` 的 `tracePaginationHTML`（L1205）上方新增：

```js
// parseTraceJumpPage 把跳页输入解析为 [1, totalPages] 内的整数；非法/越界返回 null。
function parseTraceJumpPage(raw, totalPages) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > totalPages) return null;
  return n;
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `node --test internal/adminui/app_traces.test.js`
Expected: 该用例 PASS。

- [ ] **Step 5: 写失败测试 — 翻页栏含跳页输入（max=totalPages）**

在 `app_traces.test.js` 追加：

```js
test("renderTraces emits a jump-to-page input bounded by total pages", () => {
  const { app, fakeApp } = loadAppModule();
  app.state.view = "traces";
  app.renderTraces({ traces: [], pagination: { page: 2, page_size: 50, total_items: 150, total_pages: 3, has_prev: true, has_next: true } });
  assert.match(fakeApp.innerHTML, /id="trace-jump-page"[^>]*min="1"[^>]*max="3"/);
  assert.match(fakeApp.innerHTML, /id="trace-jump-go"/);
});
```

- [ ] **Step 6: 运行，确认失败**

Run: `node --test internal/adminui/app_traces.test.js`
Expected: FAIL（翻页栏还没有 `trace-jump-page`）。

- [ ] **Step 7: 实现 — `tracePaginationHTML` 加跳页控件**

修改 `tracePaginationHTML`（L1221-L1232）的返回模板，在「末页」按钮后、`</div>`（`pagination-controls` 结束）前插入跳页控件：

```js
  return `
    <div class="pagination-bar">
      <div class="pagination-summary">第 ${formatNumber(pagination.page)} / ${formatNumber(pagination.totalPages)} 页，共 ${formatNumber(pagination.totalItems)} 条</div>
      <div class="pagination-controls">
        <button type="button" data-trace-page="1" ${pagination.hasPrev ? "" : "disabled"}>首页</button>
        <button type="button" data-trace-page="${pagination.page - 1}" ${pagination.hasPrev ? "" : "disabled"}>上一页</button>
        ${pageButtons.join("")}
        <button type="button" data-trace-page="${pagination.page + 1}" ${pagination.hasNext ? "" : "disabled"}>下一页</button>
        <button type="button" data-trace-page="${pagination.totalPages}" ${pagination.hasNext ? "" : "disabled"}>末页</button>
        <span class="pagination-jump">跳至 <input type="number" id="trace-jump-page" min="1" max="${pagination.totalPages}" value="${pagination.page}"> 页 <button type="button" id="trace-jump-go">跳转</button></span>
      </div>
    </div>
  `;
```

- [ ] **Step 8: 运行，确认通过**

Run: `node --test internal/adminui/app_traces.test.js`
Expected: 跳页输入用例 PASS。

- [ ] **Step 9: 实现 — `bindTracePagination` 绑定跳页事件**

修改 `bindTracePagination`（L1235），在现有 `[data-trace-page]` 循环之后追加跳页绑定：

```js
function bindTracePagination() {
  document.querySelectorAll("[data-trace-page]").forEach((button) => {
    if (button.disabled) return;
    button.addEventListener("click", async () => {
      const nextPage = Number(button.dataset.tracePage || 1);
      if (!Number.isFinite(nextPage) || nextPage < 1 || nextPage === state.traces.page) {
        return;
      }
      state.traces.page = nextPage;
      renderShell(`<section class="loading-panel">正在加载Trace...</section>`);
      await loadView();
    });
  });

  const jumpInput = document.querySelector("#trace-jump-page");
  const jumpGo = document.querySelector("#trace-jump-go");
  if (!jumpInput || !jumpGo) return;
  const go = async () => {
    const totalPages = Number(jumpInput.max) || 0;
    const next = parseTraceJumpPage(jumpInput.value, totalPages);
    if (next === null) {
      jumpInput.classList.add("invalid");
      return;
    }
    jumpInput.classList.remove("invalid");
    if (next === state.traces.page) return;
    state.traces.page = next;
    renderShell(`<section class="loading-panel">正在加载Trace...</section>`);
    await loadView();
  };
  jumpGo.addEventListener("click", go);
  jumpInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      go();
    }
  });
}
```

- [ ] **Step 10: 运行全部 traces 前端测试**

Run: `node --test internal/adminui/app_traces.test.js`
Expected: 全部 PASS。

- [ ] **Step 11: 提交**

```bash
git add internal/adminui/app.js internal/adminui/app_traces.test.js
git commit -m "feat(adminui): trace list jump-to-page input with validation"
```

---

## Task 6: 文档同步 + 全量验证

**Files:**
- Possibly modify: `README.md`、`ARCHITECTURE.md`（仅当存在 trace 列表行为描述需要更新时）

**Interfaces:**
- Consumes: 全部前序任务的产出。

- [ ] **Step 1: 检查文档是否需要同步**

Run: `grep -n "trace\|Trace\|翻页\|分页" README.md ARCHITECTURE.md`
判断：若文档里有 trace 列表「仅翻页/不可搜索」之类的描述，补一句「支持按员工前缀/Trace ID/Token 指纹/待复核筛选，并支持页码跳转」；若只是架构级描述（队列、存储），则无需改动。

- [ ] **Step 2: 全量基础验证**

Run: `make test`
Expected: `node --test internal/adminui/*.test.js` 全绿，`go test ./...` 全绿。

- [ ] **Step 3: （可选）真实栈手验**

若本地已起 docker 栈，手动：打开 admin trace 页 → 输入员工前缀搜索 → 翻页（过滤保留）→ 勾「仅看待复核」再搜 → 在翻页栏输入页码回车跳转 / 输入越界值确认不发请求。无 docker 则跳过，依赖自动化测试。

- [ ] **Step 4: 提交（若有文档改动）**

```bash
git add README.md ARCHITECTURE.md
git commit -m "docs: note trace list search/filter and page jump"
```

（无改动则跳过本步。）

---

## 完成判据（Definition of Done）

- trace 列表页有过滤栏：员工（前缀 ILIKE）、Trace ID（精确）、Token 指纹（精确）、仅看待复核（开关），显式「搜索」提交。
- 翻页栏有「跳至第 N 页」输入，回车/点击跳转；越界、非数字、空值不发请求。
- 翻页/跳页期间生效过滤条件不变（`state.traces.*` 只在搜索时更新）。
- count 与取数同源 WHERE；`ORDER BY created_at DESC, trace_id DESC` 未变；`LookupTokenSummary` 行为不变。
- `make test` 全绿；无 schema/迁移/索引变更。
