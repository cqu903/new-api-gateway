# 异常页 → Trace 详情直链 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在管理后台「异常」页，每条异常可直接打开其对应 trace 的详情页（当前页内跳转 + 返回）。

**Architecture:** 后端在 `AnomalySummary` 上暴露 `usage_anomalies.sample_trace_ids`（`ListAnomalies` 的 SELECT/Scan 增一列），前端在 `renderAnomalies` 行首加「Trace」列并复用现成 `traceButton` → `api('/traces/{id}')` → `renderTraceDetail` 模式；把 `renderTraceDetail` 的返回目标参数化，使从异常页进入时「返回」回到「异常」。

**Tech Stack:** Go（`pgx/v5` + `pgtype.FlatArray[string]` 扫描 `TEXT[]`）、原生 JS（`internal/adminui/app.js`，`node --test` 测试）。

## Global Constraints

- 默认中文沟通；代码、标识符、错误文本沿用项目现有语言。
- **不碰** worker、**不加** migration、**不改** job payload / trace 状态 / analysis stage；只动 Go admin 端 + 前端。
- DB 驱动为 `pgx/v5`；扫描 `TEXT[]` 必须用 `(*pgtype.FlatArray[string])(&field)`（见 `internal/admin/repository.go:1364` 现有用法）。
- `make test` = 先 `node --test internal/adminui/*.test.js`，再 `go test ./...`；改前端渲染不能只跑 Go 测试。
- 小改动优先跑最窄验证：Go 改动先跑 `go test ./internal/admin/...`；前端改动先跑对应 `node --test` 文件。
- 不改写已发布迁移；本计划不涉及迁移。
- 契约边界（`internal/jobs/` ↔ `workers/analysis_worker/models.py`）本次不动。

参考 spec：`docs/superpowers/specs/2026-06-26-anomaly-trace-detail-link-design.md`

---

### Task 1: 后端 — 在 `AnomalySummary` / `ListAnomalies` 暴露 `sample_trace_ids`

**Files:**
- Modify: `internal/admin/models.go`（`AnomalySummary` 结构，约 122-134 行）
- Modify: `internal/admin/repository.go`（`ListAnomalies`，344-374 行）
- Test: `internal/admin/handlers_test.go`（扩展 `TestListAnomaliesIncludesDisplayReason` 1271-1312；更新 `memoryAdminDB` anomaly 分支 2183-2206；import 块 3-18 行）

**Interfaces:**
- Produces: `AnomalySummary.SampleTraceIDs []string`（JSON `sample_trace_ids`），由 `ListAnomalies` 填充；`listTraceAnomalies` 不变（该字段在 trace 详情返回里为零值）。

- [ ] **Step 1: 给 `AnomalySummary` 加字段（让后续测试可编译）**

`internal/admin/models.go`，把 `AnomalySummary`（122-134 行）改为：

```go
type AnomalySummary struct {
	AnomalyID          string   `json:"anomaly_id"`
	AnomalyType        string   `json:"anomaly_type"`
	Severity           string   `json:"severity"`
	Status             string   `json:"status"`
	Username           string   `json:"username"`
	FingerprintDisplay string   `json:"fingerprint_display"`
	ObservedValue      string   `json:"observed_value"`
	ThresholdValue     string   `json:"threshold_value"`
	Reason             string   `json:"reason"`
	DisplayReason      string   `json:"display_reason"`
	CreatedAt          string   `json:"created_at"`
	SampleTraceIDs     []string `json:"sample_trace_ids"`
}
```

- [ ] **Step 2: 写失败测试 — 扩展 `TestListAnomaliesIncludesDisplayReason`**

`internal/admin/handlers_test.go`：

(a) 在 `db.anomalies` 的 fixture（1273-1286 行）里加一行 `SampleTraceIDs`：

```go
	db.anomalies = []AnomalySummary{
		{
			AnomalyID:          "anom_1",
			AnomalyType:        "high_trace_tokens",
			Severity:           "high",
			Status:             "open",
			Username:           "E10001",
			FingerprintDisplay: "fp_1234",
			ObservedValue:      "48200",
			ThresholdValue:     "40000",
			Reason:             "raw high trace token reason",
			CreatedAt:          "2026-04-28 10:00:00+00",
			SampleTraceIDs:     []string{"trace_123"},
		},
	}
```

(b) 在该测试末尾（1309-1311 行 `reason` 断言之后、函数闭合 `}` 之前）追加：

```go
	if got := body.Anomalies[0]["sample_trace_ids"]; !reflect.DeepEqual(got, []any{"trace_123"}) {
		t.Fatalf("sample_trace_ids = %#v, want [trace_123]", got)
	}
```

(c) 在 import 块加入 `reflect` 与 `pgtype`：
- stdlib 组（4-14 行）：在 `"net/http/httptest"`（11 行）和 `"strings"`（12 行）之间插入 `	"reflect"`。
- 外部组：在 `"github.com/jackc/pgx/v5/pgconn"`（17 行）之后插入 `	"github.com/jackc/pgx/v5/pgtype"`。

- [ ] **Step 3: 跑测试，确认失败**

Run: `go test ./internal/admin/ -run TestListAnomaliesIncludesDisplayReason -v`
Expected: FAIL — `sample_trace_ids = nil, want [trace_123]`（`ListAnomalies` 还没 SELECT/Scan 该列，`memoryAdminDB` 也没写 `dest[10]`）。

- [ ] **Step 4: 实现 — `ListAnomalies` 增列**

`internal/admin/repository.go`，`ListAnomalies`（344-374 行）：

SELECT 增加 `sample_trace_ids`（351-356 行改为）：

```go
	rows, err := r.db.Query(ctx, `
SELECT anomaly_id, anomaly_type, severity, status, username, fingerprint_display,
       observed_value::text, threshold_value::text, reason, created_at::text, sample_trace_ids
FROM usage_anomalies
ORDER BY created_at DESC
LIMIT $1`, limit)
```

Scan 增加数组扫描（364-368 行改为）：

```go
		if err := rows.Scan(
			&item.AnomalyID, &item.AnomalyType, &item.Severity, &item.Status,
			&item.Username, &item.FingerprintDisplay, &item.ObservedValue,
			&item.ThresholdValue, &item.Reason, &item.CreatedAt,
			(*pgtype.FlatArray[string])(&item.SampleTraceIDs),
		); err != nil {
```

（`repository.go` 顶部已 import `"github.com/jackc/pgx/v5/pgtype"`，无需新增。）

- [ ] **Step 5: 实现 — 更新 `memoryAdminDB` 让 handler 测试能投递该列**

`internal/admin/handlers_test.go`，`memoryAdminDB.Query` 的 `FROM usage_anomalies` 分支（2188-2204 行）。

**注意：** 该分支同时服务 `ListAnomalies`（无 WHERE，11 列）和 `listTraceAnomalies`（`WHERE $1 = ANY(sample_trace_ids)`，10 列，本计划不改）。因此写 `dest[10]` 必须 `len(dest) > 10` 守卫，否则 `listTraceAnomalies`（10 列）越界 panic。

把 scan 闭包改为（在 `*(dest[9].(*string)) = item.CreatedAt` 之后、`return nil` 之前追加守卫写入）：

```go
			scans = append(scans, func(dest ...any) error {
				*(dest[0].(*string)) = item.AnomalyID
				*(dest[1].(*string)) = item.AnomalyType
				*(dest[2].(*string)) = item.Severity
				*(dest[3].(*string)) = item.Status
				*(dest[4].(*string)) = item.Username
				*(dest[5].(*string)) = item.FingerprintDisplay
				*(dest[6].(*string)) = item.ObservedValue
				*(dest[7].(*string)) = item.ThresholdValue
				*(dest[8].(*string)) = item.Reason
				*(dest[9].(*string)) = item.CreatedAt
				if len(dest) > 10 {
					*(dest[10].(*pgtype.FlatArray[string])) = pgtype.FlatArray[string](item.SampleTraceIDs)
				}
				return nil
			})
```

- [ ] **Step 6: 跑测试，确认通过**

Run: `go test ./internal/admin/ -run TestListAnomaliesIncludesDisplayReason -v`
Expected: PASS。

再跑整个 admin 包，确认 `listTraceAnomalies` 相关用例（如 `TestGetTraceDetailIncludesDisplayReasonInAnomalies`）未受影响：
Run: `go test ./internal/admin/... `
Expected: PASS（全包通过）。

- [ ] **Step 7: 提交**

```bash
git add internal/admin/models.go internal/admin/repository.go internal/admin/handlers_test.go
git commit -m "feat(admin): expose sample_trace_ids on anomaly list for trace linking"
```

---

### Task 2: 前端 — 参数化 `renderTraceDetail` 的返回目标

**Files:**
- Modify: `internal/adminui/app.js`（`renderTraceDetail` 签名 1406 行 + 返回按钮 handler 1465-1468 行）
- Test: `internal/adminui/app_traces.test.js`（导出 `renderTraceDetail` + 新增返回目标用例）

**Interfaces:**
- Produces: `renderTraceDetail(body, returnView = "traces")` —— 「返回」按钮把 `state.view` 设为 `returnView` 后 `loadView()`。
- Consumes: Task 3 的 `renderAnomalies` 点击将以 `renderTraceDetail(detail, "anomalies")` 调用本函数。

- [ ] **Step 1: 导出 `renderTraceDetail` 供测试**

`internal/adminui/app_traces.test.js`，把文件末尾 `vm.runInNewContext` 注入的 `module.exports = { ... }`（42-49 行）扩为：

```js
module.exports = {
  state,
  loadTraces,
  renderTraces,
  renderAnomalies: typeof renderAnomalies !== "undefined" ? renderAnomalies : undefined,
  renderTraceDetail: typeof renderTraceDetail !== "undefined" ? renderTraceDetail : undefined,
  applyTraceSearch: typeof applyTraceSearch !== "undefined" ? applyTraceSearch : undefined,
  parseTraceJumpPage: typeof parseTraceJumpPage !== "undefined" ? parseTraceJumpPage : undefined,
};
```

（`renderAnomalies` 在 Task 3 才用到，此处一并导出无害。）

- [ ] **Step 2: 写失败测试 — 返回目标随 `returnView` 变化**

在 `app_traces.test.js` 末尾追加：

```js
test("renderTraceDetail back button returns to the provided view and defaults to traces", async () => {
  let backHandler;
  const backBtn = {
    addEventListener(evt, cb) { backHandler = cb; },
    removeEventListener() {}, getAttribute() { return ""; },
    matches() { return false; }, closest() { return null; },
    style: {}, textContent: "",
  };
  const { app } = loadAppModule({
    querySelector: (sel) => (sel === "#back-to-traces" ? backBtn : undefined),
    fetch: async (url) => {
      const json = url.includes("/anomalies")
        ? { anomalies: [] }
        : url.includes("/traces")
          ? { traces: [], pagination: { page: 1, page_size: 50, total_items: 0, total_pages: 0, has_prev: false, has_next: false } }
          : {};
      return { ok: true, status: 200, json: async () => json, text: async () => "" };
    },
  });

  app.renderTraceDetail({ trace: { trace_id: "trace_123" } }, "anomalies");
  assert.equal(typeof backHandler, "function");
  await backHandler();
  assert.equal(app.state.view, "anomalies");

  app.renderTraceDetail({ trace: { trace_id: "trace_456" } });
  assert.equal(typeof backHandler, "function");
  await backHandler();
  assert.equal(app.state.view, "traces");
});
```

- [ ] **Step 3: 跑测试，确认失败**

Run: `node --test internal/adminui/app_traces.test.js`
Expected: FAIL —— `state.view` 仍为写死的 `"traces"`（第一次断言 `=== "anomalies"` 不成立）。

- [ ] **Step 4: 实现 — 参数化返回目标**

`internal/adminui/app.js`：

(a) `renderTraceDetail` 签名（1406 行）：

```js
function renderTraceDetail(body, returnView = "traces") {
```

(b) 返回按钮 handler（1465-1468 行）：

```js
  document.querySelector("#back-to-traces").addEventListener("click", async () => {
    state.view = returnView;
    await loadView();
  });
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `node --test internal/adminui/app_traces.test.js`
Expected: PASS（新用例 + 既有用例全过）。

- [ ] **Step 6: 提交**

```bash
git add internal/adminui/app.js internal/adminui/app_traces.test.js
git commit -m "feat(adminui): parameterize trace detail back button return view"
```

---

### Task 3: 前端 — 异常页加「Trace」列 + 点击打开 trace 详情

**Files:**
- Modify: `internal/adminui/app.js`（`renderAnomalies` 1471-1483 行）
- Test: `internal/adminui/app_traces.test.js`（增强 `loadAppModule` 支持 `querySelectorAll` 覆盖 + 渲染用例 + 点击用例）

**Interfaces:**
- Consumes: `traceButton(id)`、`api('/traces/{id}')`、Task 2 的 `renderTraceDetail(detail, "anomalies")`、`arrayValue`、`badge`、`table`、`formatTime`、`escapeHTML`（均已存在）。

- [ ] **Step 1: 增强 `loadAppModule` 支持 `querySelectorAll` 覆盖（点击用例需要）**

`internal/adminui/app_traces.test.js`，把 sandbox.document 的 `querySelectorAll`（34 行）改为：

```js
      querySelectorAll(selector) {
        if (typeof overrides.querySelectorAll === "function") {
          const r = overrides.querySelectorAll(selector);
          if (r !== undefined) return r;
        }
        return [];
      },
```

- [ ] **Step 2: 写失败测试 — 渲染 + 点击**

在 `app_traces.test.js` 末尾追加两个用例：

```js
test("renderAnomalies shows a trace link when sample_trace_ids is non-empty and omits it when empty", () => {
  const { app, fakeApp } = loadAppModule();
  app.renderAnomalies({ anomalies: [{ anomaly_id: "anom_1", sample_trace_ids: ["trace_123"], severity: "high", anomaly_type: "high_trace_tokens", created_at: "2026-04-28T10:00:00Z", observed_value: "48200", display_reason: "x" }] });
  assert.match(fakeApp.innerHTML, /data-trace-id="trace_123"/);

  app.renderAnomalies({ anomalies: [{ anomaly_id: "anom_2", sample_trace_ids: [], severity: "medium", anomaly_type: "off_hours_high_usage", created_at: "2026-04-28T11:00:00Z", observed_value: "22500", display_reason: "y" }] });
  assert.doesNotMatch(fakeApp.innerHTML, /data-trace-id=/);
});

test("clicking an anomaly trace button opens the corresponding trace detail", async () => {
  const fetchCalls = [];
  let traceClickHandler;
  const traceBtn = { dataset: { traceId: "trace_123" }, addEventListener(evt, cb) { traceClickHandler = cb; } };
  const backBtn = { addEventListener() {}, removeEventListener() {}, getAttribute() { return ""; }, matches() { return false; }, closest() { return null; }, style: {}, textContent: "" };
  const { app, fakeApp } = loadAppModule({
    querySelector: (sel) => (sel === "#back-to-traces" ? backBtn : undefined),
    querySelectorAll: (sel) => (sel === "[data-trace-id]" ? [traceBtn] : []),
    fetch: async (url) => {
      fetchCalls.push(url);
      if (url.includes("/traces/trace_123")) {
        return { ok: true, status: 200, json: async () => ({ trace: { trace_id: "trace_123" } }), text: async () => "" };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    },
  });
  app.state.view = "anomalies";
  app.renderAnomalies({ anomalies: [{ anomaly_id: "anom_1", sample_trace_ids: ["trace_123"], severity: "high", anomaly_type: "high_trace_tokens", created_at: "2026-04-28T10:00:00Z", observed_value: "48200", display_reason: "x" }] });

  assert.equal(typeof traceClickHandler, "function");
  await traceClickHandler();
  assert.ok(fetchCalls.some((u) => u.includes("/admin/api/traces/trace_123")));
  assert.match(fakeApp.innerHTML, /Trace 详情/);
});
```

- [ ] **Step 3: 跑测试，确认失败**

Run: `node --test internal/adminui/app_traces.test.js`
Expected: FAIL —— 渲染用例：`fakeApp.innerHTML` 不含 `data-trace-id="trace_123"`；点击用例：`traceClickHandler` 为 `undefined`（`renderAnomalies` 尚未绑定点击）。

- [ ] **Step 4: 实现 — `renderAnomalies` 加列 + 点击绑定**

`internal/adminui/app.js`，把 `renderAnomalies`（1471-1483 行）整体替换为：

```js
function renderAnomalies(body) {
  body = body || {};
  const rows = arrayValue(body.anomalies).map((item) => {
    const ids = arrayValue(item.sample_trace_ids);
    return [
      ids.length ? traceButton(ids[0]) : "—",
      item.anomaly_id,
      formatTime(item.created_at),
      badge(item.severity),
      item.anomaly_type,
      item.username || item.fingerprint_display,
      item.observed_value,
      item.display_reason || item.reason,
    ];
  });
  renderShell(page("异常", `<section class="panel">${table(["Trace", "ID", "时间 (UTC+8)", "Severity", "类型", "员工", "观测值", "原因"], rows)}</section>`));
  document.querySelectorAll("[data-trace-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        const detail = await api(`/traces/${encodeURIComponent(button.dataset.traceId)}`);
        renderTraceDetail(detail, "anomalies");
      } catch (error) {
        renderShell(page("Trace", `<section class="panel error">${escapeHTML(error.message)}</section>`));
      }
    });
  });
}
```

说明：
- `traceButton(ids[0])` 返回 `{ safeHTML: true, html }`，`table` 的 cell 处理器对其原样输出（与 `badge(...)` 用法一致）；`"—"` 为字符串，会被转义输出。只取首个 trace，多余元素忽略（与 spec 一致）。
- `sample_trace_ids` 为空或缺失 → `arrayValue` 返回 `[]` → 渲染 `—`。
- 点击绑定仿 `renderTraces`（`app.js:1374-1383`），错误时渲染错误面板。

- [ ] **Step 5: 跑测试，确认通过**

Run: `node --test internal/adminui/app_traces.test.js`
Expected: PASS（两个新用例 + 既有用例全过）。

- [ ] **Step 6: 提交**

```bash
git add internal/adminui/app.js internal/adminui/app_traces.test.js
git commit -m "feat(adminui): open trace detail from anomaly rows"
```

---

### Task 4: 全量验证

- [ ] **Step 1: 跑全量验证**

Run: `make test`
Expected: Node UI 测试（含 `internal/adminui/app_traces.test.js`）全过，随后 `go test ./...` 全过。

- [ ] **Step 2: 检查文档同步**

本改动不涉及架构、命令、队列语义、运行方式或测试流程的改变（仅 admin UI 行为增强），无需改 `README.md` / `ARCHITECTURE.md` / `CLAUDE.md` / `AGENTS.md`。若实现中对这些有任何触及，再补。

---

## Self-Review

**1. Spec coverage：**
- 「`AnomalySummary` 加 `SampleTraceIDs`」→ Task 1 Step 1。✓
- 「`ListAnomalies` SELECT + Scan 增列」→ Task 1 Step 4。✓
- 「不改 `listTraceAnomalies`」→ Task 1 Step 5 用 `len(dest) > 10` 守卫保证其 10 列不受影响；Global Constraints 也声明不改。✓
- 「异常页行首加 Trace 列，非空渲染 `traceButton(首个)`，空渲染 `—`」→ Task 3 Step 4。✓
- 「点击 → `renderTraceDetail(detail, "anomalies")`」→ Task 3 Step 4 点击绑定。✓
- 「返回目标参数化」→ Task 2。✓
- 「权限沿用服务端 403 + 现有错误渲染」→ Task 3 Step 4 的 `catch` 渲染错误面板；无客户端门控（YAGNI）。✓
- 「测试：Go handler + repository fake、前端渲染 + 点击」→ Task 1 / Task 2 / Task 3。✓
- 「`make test`」→ Task 4。✓
- 非目标（worker/迁移/契约/pagination 保留/+N UI/客户端权限门控）均未引入。✓

**2. Placeholder scan：** 无 TBD/TODO；每个代码步骤含完整可运行代码与确切命令。✓

**3. Type consistency：**
- `SampleTraceIDs []string`（Go）↔ JSON `sample_trace_ids` ↔ 前端 `item.sample_trace_ids`（经 `arrayValue` 取数组）——命名链一致。✓
- `renderTraceDetail(body, returnView = "traces")` 定义（Task 2）与调用 `renderTraceDetail(detail, "anomalies")`（Task 3）签名一致。✓
- `memoryAdminDB` 守卫 `dest[10]` 的类型 `*pgtype.FlatArray[string]` 与 `ListAnomalies` Scan 传入的 `(*pgtype.FlatArray[string])(&item.SampleTraceIDs)` 一致。✓
