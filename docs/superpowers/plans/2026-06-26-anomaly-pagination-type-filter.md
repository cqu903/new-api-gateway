# 异常页面：类型筛选 + 分页 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给管理端「异常」列表加上「按 anomaly_type 单选筛选」和「50 条/页页码分页（含跳转）」，与 Trace 列表 UX 对称。

**Architecture:** 后端复用 Trace 已验证的 `count → totalPages → clamp page → 当页 LIMIT/OFFSET` 骨架：重命名 `TracePagination`→通用 `Pagination`，新增 `AnomalyFilter`/`AnomalyListResult`，`ListAnomalies(ctx, AnomalyFilter)` 返回带分页的结果；handler 解析 `page`+`anomaly_type`。前端复制 Trace 的分页/筛选函数为 anomaly 专属版本（绑 `state.anomalies`/`data-anomaly-page`/`#anomaly-jump-page`），类型下拉硬编码 5 种 live 类型 +「全部」。新增只读索引迁移 `0021`。

**Tech Stack:** Go（`internal/admin/`，`pgx`）、PostgreSQL 迁移、原生 JS（`internal/adminui/app.js`，`node --test` 测试）。

**Spec:** `docs/superpowers/specs/2026-06-26-anomaly-pagination-type-filter-design.md`

## Global Constraints

- 每页固定 50 条：handler 硬编码 `Limit: 50`（与 `listTraces` 一致）；`normalizeTraceListLimit` 上限 100 兜底。
- 5 种 live `anomaly_type`：`non_work_use`、`high_trace_tokens`、`long_output_anomaly`、`off_hours_high_usage`、`multivariate_anomaly`。前端硬编码常量 +「全部」选项，label 对齐 `internal/admin/anomaly_reason.go` 文案。
- 复用现成 `normalizeTraceListPage`/`normalizeTraceListLimit`（`repository.go:205/212`），不新写。
- 后端重命名 `TracePagination`→`Pagination`（通用），trace 与 anomaly 共用，**不**复制结构。
- 前端**复制** anomaly 专属分页/筛选函数，**不**改 trace 的函数与其测试。
- 迁移只新增 `migrations/0021_anomaly_type_index.sql`，不改写已发布迁移。
- **不碰** worker（`workers/`）、job 契约（`internal/jobs/` + `models.py`）、`status`/`resolved` 功能。
- 中文沟通；代码标识符/错误文本沿用项目现有语言。
- `make test` 先跑 `node --test internal/adminui/*.test.js`，再跑 `go test ./...`。

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `internal/admin/models.go` | 分页/筛选/结果类型 | 改：重命名 `TracePagination`→`Pagination`，新增 `AnomalyFilter`、`AnomalyListResult` |
| `internal/admin/repository.go` | anomaly 列表查询 | 改：`ListAnomalies(ctx, AnomalyFilter)`，新增 `anomalyFilterWhereArgs` |
| `internal/admin/handlers.go` | HTTP 参数解析 | 改：`listAnomalies` 解析 `page`+`anomaly_type` |
| `internal/admin/repository_test.go` | repo 测试 | 加：anomaly 分页/筛选测试 |
| `internal/admin/handlers_test.go` | handler 测试 + `memoryAdminDB` mock | 改：`memoryAdminDB` 支持 anomaly count/筛选/切片；更新 `TestListAnomaliesIncludesDisplayReason`；加分页/筛选 handler 测试 |
| `migrations/0021_anomaly_type_index.sql` | 索引 | 新建 |
| `internal/adminui/app.js` | 前端 anomaly 视图 | 改：`state.anomalies`、`loadAnomalies`、重写 `renderAnomalies`、anomaly 分页/筛选函数、类型常量、`loadView` 接线 |
| `internal/adminui/app_anomalies.test.js` | 前端测试 | 新建 |
| `internal/adminui/app_traces.test.js` | 前端测试 | 改：现有 anomaly 相关测试适配新 `renderAnomalies` |
| `ARCHITECTURE.md`、`README.md` | 文档 | 改：异常列表能力 |

---

### Task 1: 后端 repo — Pagination 通用化 + ListAnomalies 分页/筛选

**Files:**
- Modify: `internal/admin/models.go:90-102`（`TracePagination` 定义 + `TraceListResult`）
- Modify: `internal/admin/repository.go:300-375`（`ListTraces` 构造点 `:333` + 旧 `ListAnomalies :344`）
- Test: `internal/admin/repository_test.go`（文件末尾追加）

**Interfaces:**
- Consumes: `normalizeTraceListPage(page int) int`、`normalizeTraceListLimit(limit int) int`（`repository.go:205/212`，已存在）
- Produces:
  - `Pagination` struct（由 `TracePagination` 重命名，字段不变）
  - `AnomalyFilter struct { AnomalyType string; Page int; Limit int }`
  - `AnomalyListResult struct { Anomalies []AnomalySummary; Pagination Pagination }`
  - `ListAnomalies(ctx context.Context, filter AnomalyFilter) (AnomalyListResult, error)`
  - `anomalyFilterWhereArgs(filter AnomalyFilter) ([]string, []any)` —— 返回 `where` 子句片段（首元素恒为 `"1=1"`）与对应 args；`AnomalyType != ""` 时追加 `"anomaly_type = $N"`

- [ ] **Step 1: 写失败测试（分页元数据 + count/list 两次查询）**

追加到 `internal/admin/repository_test.go` 末尾：

```go
func TestRepositoryListAnomaliesReturnsPaginationMetadata(t *testing.T) {
	db := &recordingAdminDB{
		rowQueue: []pgx.Row{
			scanFuncRow{scan: func(dest ...any) error {
				*(dest[0].(*int64)) = int64(120)
				return nil
			}},
		},
		rowsQueue: []pgx.Rows{
			&scanRows{scans: []func(dest ...any) error{
				func(dest ...any) error {
					*(dest[0].(*string)) = "anom_120"
					*(dest[1].(*string)) = "high_trace_tokens"
					*(dest[2].(*string)) = "high"
					*(dest[3].(*string)) = "open"
					*(dest[4].(*string)) = "E10001"
					*(dest[5].(*string)) = "fp_abcd"
					*(dest[6].(*string)) = "48200"
					*(dest[7].(*string)) = "40000"
					*(dest[8].(*string)) = "raw reason"
					*(dest[9].(*string)) = "2026-06-03 10:00:00+00"
					*(dest[10].(*pgtype.FlatArray[string])) = pgtype.FlatArray[string]{}
					return nil
				},
			}},
		},
	}
	repo := NewRepository(db)

	result, err := repo.ListAnomalies(context.Background(), AnomalyFilter{Page: 3, Limit: 50})
	if err != nil {
		t.Fatalf("ListAnomalies error: %v", err)
	}
	if len(result.Anomalies) != 1 || result.Anomalies[0].AnomalyID != "anom_120" {
		t.Fatalf("anomaly rows = %#v", result.Anomalies)
	}
	if result.Pagination.Page != 3 || result.Pagination.PageSize != 50 {
		t.Fatalf("pagination page = %#v", result.Pagination)
	}
	if result.Pagination.TotalItems != 120 || result.Pagination.TotalPages != 3 {
		t.Fatalf("pagination totals = %#v", result.Pagination)
	}
	if !result.Pagination.HasPrev || result.Pagination.HasNext {
		t.Fatalf("pagination nav flags = %#v", result.Pagination)
	}
	if len(db.querySQLs) != 2 {
		t.Fatalf("querySQLs = %#v, want count + list queries", db.querySQLs)
	}
	if !strings.Contains(db.querySQLs[0], "SELECT count(*)") || !strings.Contains(db.querySQLs[0], "FROM usage_anomalies") {
		t.Fatalf("count query = %s", db.querySQLs[0])
	}
	if !strings.Contains(db.querySQLs[1], "ORDER BY created_at DESC") {
		t.Fatalf("list query = %s", db.querySQLs[1])
	}
	if got := db.queryArgsLog[1]; len(got) != 2 || got[0] != 50 || got[1] != 100 {
		t.Fatalf("list query args = %#v, want [50 100] (limit,offset)", got)
	}
}

func TestRepositoryListAnomaliesClampsPageToLastPage(t *testing.T) {
	db := &recordingAdminDB{
		rowQueue: []pgx.Row{
			scanFuncRow{scan: func(dest ...any) error {
				*(dest[0].(*int64)) = int64(60)
				return nil
			}},
		},
		rowsQueue: []pgx.Rows{&fakeRows{}},
	}
	repo := NewRepository(db)

	result, err := repo.ListAnomalies(context.Background(), AnomalyFilter{Page: 99, Limit: 50})
	if err != nil {
		t.Fatalf("ListAnomalies error: %v", err)
	}
	if result.Pagination.Page != 2 || result.Pagination.TotalPages != 2 {
		t.Fatalf("pagination = %#v, want last page 2/2", result.Pagination)
	}
	if got := db.queryArgsLog[1]; len(got) != 2 || got[0] != 50 || got[1] != 50 {
		t.Fatalf("list query args = %#v, want [50 50]", got)
	}
}

func TestRepositoryListAnomaliesReturnsFirstPageForEmptyResults(t *testing.T) {
	db := &recordingAdminDB{
		rowQueue: []pgx.Row{
			scanFuncRow{scan: func(dest ...any) error {
				*(dest[0].(*int64)) = int64(0)
				return nil
			}},
		},
		rowsQueue: []pgx.Rows{&fakeRows{}},
	}
	repo := NewRepository(db)

	result, err := repo.ListAnomalies(context.Background(), AnomalyFilter{Page: 9, Limit: 50})
	if err != nil {
		t.Fatalf("ListAnomalies error: %v", err)
	}
	if result.Pagination.Page != 1 || result.Pagination.TotalPages != 0 || result.Pagination.TotalItems != 0 {
		t.Fatalf("pagination = %#v, want empty result page 1 with zero totals", result.Pagination)
	}
}

func TestRepositoryListAnomaliesBindsTypeFilter(t *testing.T) {
	db := &recordingAdminDB{
		rowQueue: []pgx.Row{
			scanFuncRow{scan: func(dest ...any) error {
				*(dest[0].(*int64)) = int64(7)
				return nil
			}},
		},
		rowsQueue: []pgx.Rows{&fakeRows{}},
	}
	repo := NewRepository(db)

	if _, err := repo.ListAnomalies(context.Background(), AnomalyFilter{AnomalyType: "non_work_use", Page: 1, Limit: 50}); err != nil {
		t.Fatalf("ListAnomalies error: %v", err)
	}
	if len(db.querySQLs) != 2 {
		t.Fatalf("querySQLs = %#v", db.querySQLs)
	}
	if !strings.Contains(db.querySQLs[0], "anomaly_type = $1") {
		t.Fatalf("count query should filter anomaly_type, got %s", db.querySQLs[0])
	}
	if !strings.Contains(db.querySQLs[1], "anomaly_type = $1") {
		t.Fatalf("list query should filter anomaly_type, got %s", db.querySQLs[1])
	}
	// count 查询的 args：[typeValue]；list 查询的 args：[typeValue, limit, offset]
	if got := db.queryArgsLog[0]; len(got) != 1 || got[0] != "non_work_use" {
		t.Fatalf("count args = %#v, want [non_work_use]", got)
	}
	if got := db.queryArgsLog[1]; len(got) != 3 || got[0] != "non_work_use" || got[1] != 50 || got[2] != 0 {
		t.Fatalf("list args = %#v, want [non_work_use 50 0]", got)
	}
}

func TestRepositoryListAnomaliesRequiresDB(t *testing.T) {
	repo := NewRepository(nil)
	if _, err := repo.ListAnomalies(context.Background(), AnomalyFilter{Page: 1, Limit: 50}); !errors.Is(err, ErrAdminDBRequired) {
		t.Fatalf("err = %v, want ErrAdminDBRequired", err)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/admin/ -run TestRepositoryListAnomalies -v`
Expected: 编译失败 —— `ListAnomalies` 签名不匹配 / `AnomalyFilter` undefined / `TracePagination` 引用待改。

- [ ] **Step 3: models.go — 重命名 + 新增类型**

把 `internal/admin/models.go:90-102` 的：

```go
type TracePagination struct {
	Page       int   `json:"page"`
	PageSize   int   `json:"page_size"`
	TotalItems int64 `json:"total_items"`
	TotalPages int   `json:"total_pages"`
	HasPrev    bool  `json:"has_prev"`
	HasNext    bool  `json:"has_next"`
}

type TraceListResult struct {
	Traces     []TraceSummary  `json:"traces"`
	Pagination TracePagination `json:"pagination"`
}
```

替换为：

```go
type Pagination struct {
	Page       int   `json:"page"`
	PageSize   int   `json:"page_size"`
	TotalItems int64 `json:"total_items"`
	TotalPages int   `json:"total_pages"`
	HasPrev    bool  `json:"has_prev"`
	HasNext    bool  `json:"has_next"`
}

type TraceListResult struct {
	Traces     []TraceSummary `json:"traces"`
	Pagination Pagination     `json:"pagination"`
}

type AnomalyFilter struct {
	AnomalyType string
	Page        int
	Limit       int
}

type AnomalyListResult struct {
	Anomalies  []AnomalySummary `json:"anomalies"`
	Pagination Pagination       `json:"pagination"`
}
```

- [ ] **Step 4: repository.go — 修 ListTraces 构造点的类型名**

`internal/admin/repository.go:333` 的 `Pagination: TracePagination{` 改为 `Pagination: Pagination{`（仅类型名，字段不变）。

- [ ] **Step 5: repository.go — 重写 ListAnomalies + 新增 anomalyFilterWhereArgs**

把 `internal/admin/repository.go:344-375` 的旧 `ListAnomalies(ctx, limit int)` 整体替换为：

```go
func anomalyFilterWhereArgs(filter AnomalyFilter) ([]string, []any) {
	where := []string{"1=1"}
	args := []any{}
	if filter.AnomalyType != "" {
		args = append(args, filter.AnomalyType)
		where = append(where, fmt.Sprintf("anomaly_type = $%d", len(args)))
	}
	return where, args
}

func (r Repository) ListAnomalies(ctx context.Context, filter AnomalyFilter) (AnomalyListResult, error) {
	if r.db == nil {
		return AnomalyListResult{}, ErrAdminDBRequired
	}
	page := normalizeTraceListPage(filter.Page)
	limit := normalizeTraceListLimit(filter.Limit)
	where, args := anomalyFilterWhereArgs(filter)

	var totalItems int64
	countQuery := fmt.Sprintf(`SELECT count(*) FROM usage_anomalies WHERE %s`, strings.Join(where, " AND "))
	if err := r.db.QueryRow(ctx, countQuery, args...).Scan(&totalItems); err != nil {
		return AnomalyListResult{}, err
	}

	totalPages := 0
	if totalItems > 0 {
		totalPages = int((totalItems + int64(limit) - 1) / int64(limit))
		if page > totalPages {
			page = totalPages
		}
	} else {
		page = 1
	}

	offset := (page - 1) * limit
	listArgs := append(append([]any(nil), args...), limit, offset)
	query := fmt.Sprintf(`
SELECT anomaly_id, anomaly_type, severity, status, username, fingerprint_display,
       observed_value::text, threshold_value::text, reason, created_at::text, sample_trace_ids
FROM usage_anomalies
WHERE %s
ORDER BY created_at DESC
LIMIT $%d OFFSET $%d`, strings.Join(where, " AND "), len(args)+1, len(args)+2)
	rows, err := r.db.Query(ctx, query, listArgs...)
	if err != nil {
		return AnomalyListResult{}, err
	}
	defer rows.Close()
	var items []AnomalySummary
	for rows.Next() {
		var item AnomalySummary
		if err := rows.Scan(
			&item.AnomalyID, &item.AnomalyType, &item.Severity, &item.Status,
			&item.Username, &item.FingerprintDisplay, &item.ObservedValue,
			&item.ThresholdValue, &item.Reason, &item.CreatedAt,
			(*pgtype.FlatArray[string])(&item.SampleTraceIDs),
		); err != nil {
			return AnomalyListResult{}, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return AnomalyListResult{}, err
	}
	return AnomalyListResult{
		Anomalies: items,
		Pagination: Pagination{
			Page:       page,
			PageSize:   limit,
			TotalItems: totalItems,
			TotalPages: totalPages,
			HasPrev:    totalPages > 0 && page > 1,
			HasNext:    totalPages > 0 && page < totalPages,
		},
	}, nil
}
```

- [ ] **Step 6: 跑 repo 测试确认通过**

Run: `go test ./internal/admin/ -run TestRepositoryListAnomalies -v`
Expected: 5 个测试全 PASS。

- [ ] **Step 7: 跑 trace repo 测试确认重命名未破坏**

Run: `go test ./internal/admin/ -run TestRepositoryListTraces -v`
Expected: 全 PASS（验证 `TracePagination`→`Pagination` 重命名对 trace 无回归）。

- [ ] **Step 8: Commit**

```bash
git add internal/admin/models.go internal/admin/repository.go internal/admin/repository_test.go
git commit -m "feat(admin): anomaly list pagination + type filter (repo layer)"
```

---

### Task 2: 后端 handler — listAnomalies 参数解析 + memoryAdminDB mock 改造

**Files:**
- Modify: `internal/admin/handlers.go:593-601`（`listAnomalies`）
- Modify: `internal/admin/handlers_test.go`（`memoryAdminDB` 字段 `:1992`、`Query :2189-2215`、`memoryAdminRow.Scan` 加 count 分支；更新 `TestListAnomaliesIncludesDisplayReason :1273`；新增测试）

**Interfaces:**
- Consumes: `ListAnomalies(ctx, AnomalyFilter) (AnomalyListResult, error)`（Task 1 产出）、`withAnomalyDisplayReasons`、page 解析范式（参考 `listTraces :335-351`）
- Produces: `GET /admin/api/anomalies?page=N&anomaly_type=XXX` → `200` 响应体为 `AnomalyListResult`（`{anomalies:[…], pagination:{…}}`）

- [ ] **Step 1: 改 memoryAdminDB — 加 anomalyTotalItems 字段**

`internal/admin/handlers_test.go:1992` 的 `anomalies []AnomalySummary` 下一行新增字段：

```go
	anomalyTotalItems          int64
```

- [ ] **Step 2: 改 memoryAdminDB.Query — anomaly list 分支加筛选 + 切片**

把 `internal/admin/handlers_test.go:2189-2215` 的 `if strings.Contains(sql, "FROM usage_anomalies") { … }` 整段替换为（保留 `WHERE $1 = ANY(sample_trace_ids)` 的 traceAnomalies 子分支，仅在 else 分支做 ListAnomalies 的筛选+切片）：

```go
	if strings.Contains(sql, "FROM usage_anomalies") {
		items := m.anomalies
		if strings.Contains(sql, "WHERE $1 = ANY(sample_trace_ids)") {
			items = m.traceAnomalies
		} else {
			if strings.Contains(sql, "anomaly_type =") {
				typeVal := ""
				for _, a := range args {
					if s, ok := a.(string); ok && s != "" {
						typeVal = s
						break
					}
				}
				filtered := make([]AnomalySummary, 0, len(items))
				for _, it := range items {
					if it.AnomalyType == typeVal {
						filtered = append(filtered, it)
					}
				}
				items = filtered
			}
			limit, offset := len(items), 0
			if len(args) >= 2 {
				if v, ok := args[len(args)-2].(int); ok {
					limit = v
				}
				if v, ok := args[len(args)-1].(int); ok {
					offset = v
				}
			}
			if offset > len(items) {
				offset = len(items)
			}
			end := offset + limit
			if end > len(items) {
				end = len(items)
			}
			items = items[offset:end]
		}
		scans := make([]func(dest ...any) error, 0, len(items))
		for _, item := range items {
			item := item
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
		}
		return &scanRows{scans: scans}, nil
	}
```

- [ ] **Step 3: 改 memoryAdminRow.Scan — 加 anomaly count 分支**

在 `internal/admin/handlers_test.go` 的 `func (r memoryAdminRow) Scan(dest ...any) error {`（`:2336`）函数体最开头（`if strings.Contains(r.sql, "FROM audit_users")` 之前）插入：

```go
	if strings.Contains(r.sql, "SELECT count(*)") && strings.Contains(r.sql, "FROM usage_anomalies") && !strings.Contains(r.sql, "token_fingerprint") {
		*(dest[0].(*int64)) = r.db.anomalyTotalItems
		return nil
	}
```

> 条件里的 `!strings.Contains(r.sql, "token_fingerprint")` 是为了**不**误匹配 `LookupTokenSummary` 的 `SELECT count(*) FROM usage_anomalies WHERE token_fingerprint = $1 AND status = 'open'`（`repository.go:427`），保留其原有 mock 行为。

- [ ] **Step 4: 写失败测试（handler 分页 + 类型筛选）**

在 `internal/admin/handlers_test.go` 的 `TestListAnomaliesIncludesDisplayReason`（`:1273`）之前新增：

```go
func TestListAnomaliesReturnsTopLevelPagination(t *testing.T) {
	handler, db, cookie := newAuthenticatedAdminHandler(t, RoleAuditor, "", nil)
	db.anomalies = makeAnomalySummaries(60)
	db.anomalyTotalItems = 120

	req := httptest.NewRequest(http.MethodGet, "/admin/api/anomalies?page=2", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body AnomalyListResult
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v; raw=%s", err, rec.Body.String())
	}
	if body.Pagination.Page != 2 || body.Pagination.PageSize != 50 {
		t.Fatalf("pagination page = %#v", body.Pagination)
	}
	if body.Pagination.TotalItems != 120 || body.Pagination.TotalPages != 3 {
		t.Fatalf("pagination totals = %#v", body.Pagination)
	}
	if !body.Pagination.HasPrev || !body.Pagination.HasNext {
		t.Fatalf("pagination nav flags = %#v", body.Pagination)
	}
}

func TestListAnomaliesFiltersByType(t *testing.T) {
	handler, db, cookie := newAuthenticatedAdminHandler(t, RoleAuditor, "", nil)
	db.anomalies = []AnomalySummary{
		{AnomalyID: "anom_a", AnomalyType: "non_work_use", Severity: "high", Status: "open", CreatedAt: "2026-06-03 10:00:00+00"},
		{AnomalyID: "anom_b", AnomalyType: "high_trace_tokens", Severity: "medium", Status: "open", CreatedAt: "2026-06-03 09:00:00+00"},
	}
	db.anomalyTotalItems = 1

	req := httptest.NewRequest(http.MethodGet, "/admin/api/anomalies?page=1&anomaly_type=non_work_use", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body AnomalyListResult
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v; raw=%s", err, rec.Body.String())
	}
	if len(body.Anomalies) != 1 || body.Anomalies[0].AnomalyID != "anom_a" {
		t.Fatalf("anomalies = %#v, want only anom_a (non_work_use)", body.Anomalies)
	}
	if body.Pagination.TotalItems != 1 {
		t.Fatalf("total items = %d, want 1", body.Pagination.TotalItems)
	}
}
```

并在文件末尾（`makeTraceSummaries` 附近，`:2504` 后）加 helper：

```go
func makeAnomalySummaries(count int) []AnomalySummary {
	out := make([]AnomalySummary, count)
	for i := range out {
		out[i] = AnomalySummary{
			AnomalyID:   fmt.Sprintf("anom_%03d", i+1),
			AnomalyType: "high_trace_tokens",
			Severity:    "high",
			Status:      "open",
			CreatedAt:   "2026-06-03 10:00:00+00",
		}
	}
	return out
}
```

- [ ] **Step 5: 更新现有 TestListAnomaliesIncludesDisplayReason 适配新响应**

`internal/admin/handlers_test.go:1273` 的 `TestListAnomaliesIncludesDisplayReason`：在 `db.anomalies = […]` 之后补一行 `db.anomalyTotalItems = 1`；把解码目标从：

```go
	var body struct {
		Anomalies []map[string]any `json:"anomalies"`
	}
```

改为：

```go
	var body AnomalyListResult
```

并把后续对 `body.Anomalies[0]` 的访问改为结构体字段访问：

```go
	if len(body.Anomalies) != 1 {
		t.Fatalf("anomalies = %#v, want one item", body.Anomalies)
	}
	if got := body.Anomalies[0].DisplayReason; got != "本次请求有效 token 消耗 48,200，超过阈值 40,000。" {
		t.Fatalf("display_reason = %#v", got)
	}
	if got := body.Anomalies[0].Reason; got != "raw high trace token reason" {
		t.Fatalf("reason = %#v", got)
	}
	if got := body.Anomalies[0].SampleTraceIDs; !reflect.DeepEqual(got, []string{"trace_123"}) {
		t.Fatalf("sample_trace_ids = %#v, want [trace_123]", got)
	}
```

（删掉原来对 `body.Anomalies[0]["display_reason"]` 等 map 下标的访问。）

- [ ] **Step 6: 改 listAnomalies handler**

把 `internal/admin/handlers.go:593-601` 的 `listAnomalies` 替换为：

```go
func (h Handler) listAnomalies(w http.ResponseWriter, r *http.Request) {
	page := 1
	if rawPage := strings.TrimSpace(r.URL.Query().Get("page")); rawPage != "" {
		if parsed, err := strconv.Atoi(rawPage); err == nil && parsed > 0 {
			page = parsed
		}
	}
	filter := AnomalyFilter{
		AnomalyType: strings.TrimSpace(r.URL.Query().Get("anomaly_type")),
		Page:        page,
		Limit:       50,
	}
	result, err := h.repo.ListAnomalies(r.Context(), filter)
	if err != nil {
		http.Error(w, "failed to list anomalies", http.StatusInternalServerError)
		return
	}
	result.Anomalies = withAnomalyDisplayReasons(result.Anomalies)
	writeJSON(w, http.StatusOK, result)
}
```

- [ ] **Step 7: 跑 handler 测试确认通过**

Run: `go test ./internal/admin/ -run 'TestListAnomalies|TestGetTraceDetailIncludesDisplayReason' -v`
Expected: `TestListAnomaliesReturnsTopLevelPagination`、`TestListAnomaliesFiltersByType`、`TestListAnomaliesIncludesDisplayReason`（已更新）全 PASS。

- [ ] **Step 8: 回归 — LookupTokenSummary 测试不受 count 分支影响**

Run: `go test ./internal/admin/ -run TestRepositoryLookupTokenSummary -v`
Expected: 全 PASS（验证新 anomaly count 分支的 `!token_fingerprint` 排除未破坏 lookup 的 open-anomaly count）。

- [ ] **Step 9: 全 admin 包测试**

Run: `go test ./internal/admin/...`
Expected: 全 PASS。

- [ ] **Step 10: Commit**

```bash
git add internal/admin/handlers.go internal/admin/handlers_test.go
git commit -m "feat(admin): listAnomalies parses page + anomaly_type, returns pagination"
```

---

### Task 3: 迁移 — 0021 anomaly_type 索引

**Files:**
- Create: `migrations/0021_anomaly_type_index.sql`

- [ ] **Step 1: 新建迁移文件**

`migrations/0021_anomaly_type_index.sql`：

```sql
-- 支撑异常列表「按 anomaly_type 筛选 + 时间排序」查询，与现有
-- (status,created_at) / (username,created_at) / (token,created_at) 索引对称。
CREATE INDEX IF NOT EXISTS idx_usage_anomalies_type_created
    ON usage_anomalies(anomaly_type, created_at DESC);
```

- [ ] **Step 2: 语法校验（若有本地 postgres）**

Run: `docker compose -f deploy/docker-compose.yml --env-file .env.local --profile tools run --rm migrate`
Expected: 迁移执行器应用到 `0021`，`schema_migrations` 记录新行，无报错。若本地无栈，跳过并在 Task 7 一并验证。

- [ ] **Step 3: Commit**

```bash
git add migrations/0021_anomaly_type_index.sql
git commit -m "feat(db): index usage_anomalies(anomaly_type, created_at) for list filtering"
```

---

### Task 4: 前端 — state.anomalies + 分页/筛选纯函数 + 类型常量

**Files:**
- Modify: `internal/adminui/app.js`（state `:34-41` + 计数器 `:54` + 在 trace 函数后新增 anomaly 函数）
- Test: `internal/adminui/app_anomalies.test.js`（新建）

**Interfaces:**
- Consumes: 现有 helpers `finiteNumber`、`formatNumber`、`escapeHTML`（均已在 `app.js`）
- Produces:
  - `state.anomalies = { page, pageSize, anomalyType }`、全局 `anomalyRequestSeq`
  - `ANOMALY_TYPE_FILTERS` —— `[{value:"", label:"全部"}, {value:"high_trace_tokens", label:"高 token 用量"}, …]`
  - `normalizeAnomalyPagination(pagination) -> {page,pageSize,totalItems,totalPages,hasPrev,hasNext}`
  - `anomalyPageNumbers(pagination) -> number[]`
  - `parseAnomalyJumpPage(raw, totalPages) -> number|null`
  - `anomalyPaginationHTML(pagination) -> string`
  - `anomalyFiltersHTML() -> string`
  - `applyAnomalyFilter()`

> 注：`state.anomalies` 在本任务定义，因为 `normalizeAnomalyPagination`/`applyAnomalyFilter` 的 fallback 逻辑要读它；Task 5 的 `loadAnomalies`/`renderAnomalies` 直接消费。

- [ ] **Step 1: 写失败测试（纯函数）**

新建 `internal/adminui/app_anomalies.test.js`：

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
        if (selector === "#change-password-button") return fakeElement;
        if (selector === "#logout-button") return fakeElement;
        if (selector === ".main") return fakeElement;
        return null;
      },
      querySelectorAll(selector) {
        if (typeof overrides.querySelectorAll === "function") {
          const r = overrides.querySelectorAll(selector);
          if (r !== undefined) return r;
        }
        return [];
      },
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
  loadAnomalies: typeof loadAnomalies !== "undefined" ? loadAnomalies : undefined,
  renderAnomalies: typeof renderAnomalies !== "undefined" ? renderAnomalies : undefined,
  normalizeAnomalyPagination: typeof normalizeAnomalyPagination !== "undefined" ? normalizeAnomalyPagination : undefined,
  anomalyPageNumbers: typeof anomalyPageNumbers !== "undefined" ? anomalyPageNumbers : undefined,
  parseAnomalyJumpPage: typeof parseAnomalyJumpPage !== "undefined" ? parseAnomalyJumpPage : undefined,
  applyAnomalyFilter: typeof applyAnomalyFilter !== "undefined" ? applyAnomalyFilter : undefined,
  ANOMALY_TYPE_FILTERS: typeof ANOMALY_TYPE_FILTERS !== "undefined" ? ANOMALY_TYPE_FILTERS : undefined,
};`,
    sandbox,
  );
  return { app: sandbox.module.exports, fakeApp };
}

test("parseAnomalyJumpPage validates page input against total pages", () => {
  const { app } = loadAppModule();
  const total = 5;
  assert.equal(app.parseAnomalyJumpPage("3", total), 3);
  assert.equal(app.parseAnomalyJumpPage(" 2 ", total), 2);
  assert.equal(app.parseAnomalyJumpPage("1", total), 1);
  assert.equal(app.parseAnomalyJumpPage("5", total), 5);
  assert.equal(app.parseAnomalyJumpPage("", total), null);
  assert.equal(app.parseAnomalyJumpPage("abc", total), null);
  assert.equal(app.parseAnomalyJumpPage("0", total), null);
  assert.equal(app.parseAnomalyJumpPage("6", total), null);
  assert.equal(app.parseAnomalyJumpPage("-1", total), null);
  assert.equal(app.parseAnomalyJumpPage("2.5", total), null);
});

test("normalizeAnomalyPagination falls back to state.anomalies when payload missing", () => {
  const { app } = loadAppModule();
  app.state.anomalies.page = 2;
  app.state.anomalies.pageSize = 50;
  const p = app.normalizeAnomalyPagination(undefined);
  assert.equal(p.page, 2);
  assert.equal(p.pageSize, 50);
  assert.equal(p.totalPages, 0);
});

test("ANOMALY_TYPE_FILTERS includes 全部 plus the five live types", () => {
  const { app } = loadAppModule();
  const values = app.ANOMALY_TYPE_FILTERS.map((o) => o.value);
  assert.deepEqual(values, ["", "high_trace_tokens", "long_output_anomaly", "off_hours_high_usage", "non_work_use", "multivariate_anomaly"]);
});

test("applyAnomalyFilter reads the select into state and resets page to 1", () => {
  const { app } = loadAppModule({ querySelector: (sel) => (sel === "#anomaly-filter-type" ? { value: "non_work_use" } : undefined) });
  app.state.anomalies.page = 5;
  app.state.anomalies.anomalyType = "stale";

  app.applyAnomalyFilter();

  assert.equal(app.state.anomalies.anomalyType, "non_work_use");
  assert.equal(app.state.anomalies.page, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test internal/adminui/app_anomalies.test.js`
Expected: FAIL —— `parseAnomalyJumpPage`/`normalizeAnomalyPagination`/`ANOMALY_TYPE_FILTERS`/`applyAnomalyFilter` undefined（且加载 app.js 时无 `state.anomalies`，断言里 `app.state.anomalies.page = 2` 会抛错）。

- [ ] **Step 3: app.js — 加 state.anomalies + anomalyRequestSeq**

把 `internal/adminui/app.js:34-41` 的 `traces: { … }` 之后（`analysisRuntime` 之前）插入：

```js
  anomalies: {
    page: 1,
    pageSize: 50,
    anomalyType: "",
  },
```

并把 `:54` 的 `let traceRequestSeq = 0;` 之后加：

```js
let anomalyRequestSeq = 0;
```

- [ ] **Step 4: app.js — 加类型常量 + anomaly 纯函数**

在 `internal/adminui/app.js` 的 `bindTraceSearch`（约 `:1347`）之后、`renderTraces`（`:1349`）之前插入：

```js
const ANOMALY_TYPE_FILTERS = [
  { value: "", label: "全部" },
  { value: "high_trace_tokens", label: "高 token 用量" },
  { value: "long_output_anomaly", label: "超长输出" },
  { value: "off_hours_high_usage", label: "非工作时间高用量" },
  { value: "non_work_use", label: "非工作用途" },
  { value: "multivariate_anomaly", label: "多变量异常" },
];

function normalizeAnomalyPagination(pagination) {
  const normalized = pagination || {};
  const fallbackPage = Math.max(1, finiteNumber(state.anomalies.page) || 1);
  const fallbackPageSize = Math.max(1, finiteNumber(state.anomalies.pageSize) || 50);
  return {
    page: Math.max(1, finiteNumber(normalized.page) || fallbackPage),
    pageSize: Math.max(1, finiteNumber(normalized.page_size) || fallbackPageSize),
    totalItems: Math.max(0, finiteNumber(normalized.total_items)),
    totalPages: Math.max(0, finiteNumber(normalized.total_pages)),
    hasPrev: Boolean(normalized.has_prev),
    hasNext: Boolean(normalized.has_next),
  };
}

function anomalyPageNumbers(pagination) {
  const total = pagination.totalPages;
  const current = pagination.page;
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  const pages = new Set([1, total, current - 1, current, current + 1]);
  if (current <= 3) {
    pages.add(2);
    pages.add(3);
    pages.add(4);
  }
  if (current >= total - 2) {
    pages.add(total - 1);
    pages.add(total - 2);
    pages.add(total - 3);
  }
  return Array.from(pages)
    .filter((page) => page >= 1 && page <= total)
    .sort((a, b) => a - b);
}

// parseAnomalyJumpPage 把跳页输入解析为 [1, totalPages] 内的整数；非法/越界返回 null。
function parseAnomalyJumpPage(raw, totalPages) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > totalPages) return null;
  return n;
}

function anomalyPaginationHTML(pagination) {
  if (pagination.totalItems === 0 || pagination.totalPages === 0) {
    return `<div class="pagination-bar"><div class="pagination-summary">共 0 条</div></div>`;
  }
  const pages = anomalyPageNumbers(pagination);
  const pageButtons = [];
  let previous = 0;
  pages.forEach((pageNumber) => {
    if (previous && pageNumber - previous > 1) {
      pageButtons.push(`<span class="pagination-ellipsis" aria-hidden="true">...</span>`);
    }
    pageButtons.push(
      `<button type="button" data-anomaly-page="${pageNumber}" class="${pageNumber === pagination.page ? "active" : ""}" ${pageNumber === pagination.page ? 'aria-current="page"' : ""}>${pageNumber}</button>`,
    );
    previous = pageNumber;
  });
  return `
    <div class="pagination-bar">
      <div class="pagination-summary">第 ${formatNumber(pagination.page)} / ${formatNumber(pagination.totalPages)} 页，共 ${formatNumber(pagination.totalItems)} 条</div>
      <div class="pagination-controls">
        <button type="button" data-anomaly-page="1" ${pagination.hasPrev ? "" : "disabled"}>首页</button>
        <button type="button" data-anomaly-page="${pagination.page - 1}" ${pagination.hasPrev ? "" : "disabled"}>上一页</button>
        ${pageButtons.join("")}
        <button type="button" data-anomaly-page="${pagination.page + 1}" ${pagination.hasNext ? "" : "disabled"}>下一页</button>
        <button type="button" data-anomaly-page="${pagination.totalPages}" ${pagination.hasNext ? "" : "disabled"}>末页</button>
        <span class="pagination-jump">跳至 <input type="number" id="anomaly-jump-page" min="1" max="${pagination.totalPages}" value="${pagination.page}"> 页 <button type="button" id="anomaly-jump-go">跳转</button></span>
      </div>
    </div>
  `;
}

function anomalyFiltersHTML() {
  const current = state.anomalies.anomalyType;
  const options = ANOMALY_TYPE_FILTERS.map(
    (entry) => `<option value="${escapeHTML(entry.value)}"${entry.value === current ? " selected" : ""}>${escapeHTML(entry.label)}</option>`,
  ).join("");
  return `
    <section class="panel">
      <form class="filters" id="anomaly-filters" autocomplete="off">
        <div class="field">
          <label for="anomaly-filter-type">类型</label>
          <select id="anomaly-filter-type" name="anomaly_type">${options}</select>
        </div>
        <div class="field">
          <button type="submit" class="primary">筛选</button>
        </div>
      </form>
    </section>
  `;
}

// applyAnomalyFilter 把过滤栏当前 DOM 值写回 state.anomalies（生效过滤）并重置到第 1 页。
function applyAnomalyFilter() {
  const select = document.querySelector("#anomaly-filter-type");
  state.anomalies.anomalyType = select ? String(select.value).trim() : "";
  state.anomalies.page = 1;
}
```

- [ ] **Step 5: 跑纯函数测试确认通过**

Run: `node --test internal/adminui/app_anomalies.test.js`
Expected: 4 个测试 PASS。

- [ ] **Step 6: Commit**

```bash
git add internal/adminui/app.js internal/adminui/app_anomalies.test.js
git commit -m "feat(adminui): state.anomalies + anomaly pagination/filter pure functions"
```

---

### Task 5: 前端 — loadAnomalies/renderAnomalies/bind/loadView 接线

**Files:**
- Modify: `internal/adminui/app.js`（`loadView` anomalies 分支 `:589-591`、`renderAnomalies :1471-1497`、`loadTraces :689` 后新增 `loadAnomalies`/bind）
- Modify: `internal/adminui/app_anomalies.test.js`（追加集成测试）
- Modify: `internal/adminui/app_traces.test.js`（适配现有 anomaly 测试）

**Interfaces:**
- Consumes: Task 4 的 `state.anomalies`/`normalizeAnomalyPagination`/`anomalyPaginationHTML`/`anomalyFiltersHTML`/`applyAnomalyFilter`/`parseAnomalyJumpPage`；现有 `queryString`、`arrayValue`、`table`、`page`、`renderShell`、`badge`、`traceButton`、`escapeHTML`、`formatTime`、`api`
- Produces:
  - `loadAnomalies()` —— `GET /admin/api/anomalies?page=N&anomaly_type=XXX`（带 `anomalyRequestSeq` 防竞态）
  - `renderAnomalies(body)` —— 渲染 筛选栏 + 表格（列不变）+ 分页栏；绑定 `#anomaly-filters`（submit → applyAnomalyFilter → 重载）、`[data-anomaly-page]` 与 `#anomaly-jump-page/go`
  - `loadView()` 的 anomalies 分支改调 `loadAnomalies()`

- [ ] **Step 1: 写失败测试（集成：fetch URL + 渲染筛选栏/分页栏 + 跳转输入）**

追加到 `internal/adminui/app_anomalies.test.js`：

```js
test("loadAnomalies includes page and anomaly_type in the query string and omits empty type", async () => {
  const calls = [];
  const { app } = loadAppModule({
    fetch: async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ anomalies: [], pagination: { page: 1, page_size: 50, total_items: 0, total_pages: 0, has_prev: false, has_next: false } }), text: async () => "" };
    },
  });
  app.state.view = "anomalies";
  app.state.anomalies.page = 2;
  app.state.anomalies.anomalyType = "non_work_use";

  await app.loadAnomalies();

  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/admin\/api\/anomalies\?/);
  assert.match(calls[0], /page=2/);
  assert.match(calls[0], /anomaly_type=non_work_use/);
});

test("renderAnomalies emits a type filter select and a jump-to-page input", () => {
  const { app, fakeApp } = loadAppModule();
  app.state.view = "anomalies";
  app.state.anomalies.anomalyType = "non_work_use";

  app.renderAnomalies({ anomalies: [], pagination: { page: 2, page_size: 50, total_items: 150, total_pages: 3, has_prev: true, has_next: true } });

  assert.match(fakeApp.innerHTML, /id="anomaly-filters"/);
  assert.match(fakeApp.innerHTML, /id="anomaly-filter-type"/);
  assert.match(fakeApp.innerHTML, /<option value="non_work_use"\s+selected>/);
  assert.match(fakeApp.innerHTML, /id="anomaly-jump-page"[^>]*min="1"[^>]*max="3"/);
  assert.match(fakeApp.innerHTML, /id="anomaly-jump-go"/);
});

test("renderAnomalies still wires sample_trace_ids trace buttons", () => {
  const { app, fakeApp } = loadAppModule();
  app.renderAnomalies({ anomalies: [{ anomaly_id: "anom_1", sample_trace_ids: ["trace_123"], severity: "high", anomaly_type: "high_trace_tokens", created_at: "2026-04-28T10:00:00Z", observed_value: "48200", display_reason: "x" }], pagination: { page: 1, page_size: 50, total_items: 1, total_pages: 1, has_prev: false, has_next: false } });
  assert.match(fakeApp.innerHTML, /data-trace-id="trace_123"/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test internal/adminui/app_anomalies.test.js`
Expected: 新 3 个测试 FAIL（`loadAnomalies`/`renderAnomalies` 新行为未实现；注意 `loadAnomalies` 此时未定义，导出为 undefined，调用会抛错）。

- [ ] **Step 3: app.js — loadView 的 anomalies 分支改调 loadAnomalies**

把 `internal/adminui/app.js:589-591` 的：

```js
    } else if (state.view === "anomalies") {
      const body = await api("/anomalies");
      renderAnomalies(body);
```

改为：

```js
    } else if (state.view === "anomalies") {
      await loadAnomalies();
```

- [ ] **Step 4: app.js — 新增 loadAnomalies + bindAnomalyPagination + bindAnomalySearch**

在 `loadTraces`（`:689`）之后插入：

```js
async function loadAnomalies() {
  const requestSeq = ++anomalyRequestSeq;
  const requestedPage = Math.max(1, finiteNumber(state.anomalies.page) || 1);
  const params = queryString({
    page: requestedPage,
    anomaly_type: state.anomalies.anomalyType,
  });
  let body;
  try {
    body = await api(`/anomalies?${params}`);
  } catch (error) {
    if (requestSeq !== anomalyRequestSeq || state.view !== "anomalies" || state.anomalies.page !== requestedPage) {
      return;
    }
    throw error;
  }
  if (requestSeq !== anomalyRequestSeq || state.view !== "anomalies" || state.anomalies.page !== requestedPage) {
    return;
  }
  renderAnomalies(body);
}

function bindAnomalyPagination() {
  document.querySelectorAll("[data-anomaly-page]").forEach((button) => {
    if (button.disabled) return;
    button.addEventListener("click", async () => {
      const nextPage = Number(button.dataset.anomalyPage || 1);
      if (!Number.isFinite(nextPage) || nextPage < 1 || nextPage === state.anomalies.page) {
        return;
      }
      state.anomalies.page = nextPage;
      renderShell(`<section class="loading-panel">正在加载异常...</section>`);
      await loadView();
    });
  });

  const jumpInput = document.querySelector("#anomaly-jump-page");
  const jumpGo = document.querySelector("#anomaly-jump-go");
  if (!jumpInput || !jumpGo) return;
  const go = async () => {
    const totalPages = Number(jumpInput.max) || 0;
    const next = parseAnomalyJumpPage(jumpInput.value, totalPages);
    if (next === null) {
      jumpInput.classList.add("invalid");
      return;
    }
    jumpInput.classList.remove("invalid");
    if (next === state.anomalies.page) return;
    state.anomalies.page = next;
    renderShell(`<section class="loading-panel">正在加载异常...</section>`);
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

function bindAnomalySearch() {
  const form = document.querySelector("#anomaly-filters");
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    applyAnomalyFilter();
    renderShell(`<section class="loading-panel">正在加载异常...</section>`);
    await loadView();
  });
}
```

- [ ] **Step 5: app.js — 重写 renderAnomalies**

把 `internal/adminui/app.js:1471-1497` 的整个 `renderAnomalies` 替换为：

```js
function renderAnomalies(body) {
  body = body || {};
  const pagination = normalizeAnomalyPagination(body.pagination);
  state.anomalies.page = pagination.page;
  state.anomalies.pageSize = pagination.pageSize;
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
  renderShell(
    page(
      "异常",
      `${anomalyFiltersHTML()}<section class="panel">${table(["Trace", "ID", "时间 (UTC+8)", "Severity", "类型", "员工", "观测值", "原因"], rows)}${anomalyPaginationHTML(pagination)}</section>`,
    ),
  );
  bindAnomalySearch();
  bindAnomalyPagination();
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

- [ ] **Step 6: 跑集成测试确认通过**

Run: `node --test internal/adminui/app_anomalies.test.js`
Expected: 全部 7 个测试 PASS。

- [ ] **Step 7: 适配 app_traces.test.js 既有 anomaly 测试**

`internal/adminui/app_traces.test.js` 的 `renderAnomalies shows a trace link…`（`:177`）与 `clicking an anomaly trace button…`（`:186`）目前调用 `renderAnomalies({ anomalies: […] })`（无 `pagination`）。重写后 `normalizeAnomalyPagination(undefined)` 走 fallback 不崩，`bindAnomalySearch/bindAnomalyPagination` 在沙箱里因 `#anomaly-filters`/`[data-anomaly-page]` 返回 null/[] 而早退。

Run: `node --test internal/adminui/app_traces.test.js`
Expected: 全 PASS。若 `clicking an anomaly trace button` 因 fetch mock 未覆盖 `/anomalies` 失败，给该测试的 `fetch` override 增补 `anomalies` 分支（返回 `{ anomalies: [], pagination: { page:1, page_size:50, total_items:0, total_pages:0, has_prev:false, has_next:false } }`）。

- [ ] **Step 8: 跑全部前端测试**

Run: `node --test internal/adminui/*.test.js`
Expected: 全 PASS。

- [ ] **Step 9: Commit**

```bash
git add internal/adminui/app.js internal/adminui/app_anomalies.test.js internal/adminui/app_traces.test.js
git commit -m "feat(adminui): anomaly list page-jump pagination + type filter select"
```

---

### Task 6: Docs — ARCHITECTURE.md + README.md

**Files:**
- Modify: `ARCHITECTURE.md`（异常列表段，trace 分页段 `:260` 附近）
- Modify: `README.md`（异常列表能力，`:61` 附近）

- [ ] **Step 1: ARCHITECTURE.md 补异常列表分页/筛选说明**

在 `ARCHITECTURE.md:260`（Trace 列表分页/筛选段）之后追加一段：

```markdown
异常列表与 Trace 列表同构：固定 50 条/页的页码分页（首页/上一页/页码/下一页/末页 + 跳转输入，越界/非数字/空值不发请求），并可按 `anomaly_type` 单选筛选（下拉含「全部」+ 5 种 live 类型：`high_trace_tokens`/`long_output_anomaly`/`off_hours_high_usage`/`non_work_use`/`multivariate_anomaly`）。后端 `GET /admin/api/anomalies?page=N&anomaly_type=XXX` 返回 `{anomalies:[…], pagination:{…}}`，复用通用 `Pagination` 类型；`usage_anomalies(anomaly_type, created_at)` 索引支撑筛选+排序。
```

- [ ] **Step 2: README.md 补一句异常列表能力**

在 `README.md:61`（异常列表 `display_reason`/`reason` 说明）之后追加：

```markdown
管理端异常列表支持按 `anomaly_type` 单选筛选与 50 条/页的页码分页（含页码跳转）。
```

- [ ] **Step 3: Commit**

```bash
git add ARCHITECTURE.md README.md
git commit -m "docs: anomaly list type filter + pagination"
```

---

### Task 7: 全量验证 — make test

- [ ] **Step 1: 跑 make test（先 Node 后 Go）**

Run: `make test`
Expected: `node --test internal/adminui/*.test.js` 全 PASS，随后 `go test ./...` 全 PASS。

- [ ] **Step 2: 若本地有 docker 栈，端到端确认**

Run: `docker compose -f deploy/docker-compose.yml --env-file .env.local up -d postgres redis` → 执行迁移（含 0021）→ `make run` + worker → 浏览器打开异常列表，验证：类型下拉筛选生效、翻页栏页码与跳转可用、与 Trace 列表观感一致。
（可选；CI/本地有数据时执行。）

- [ ] **Step 3: 最终 commit（若有遗留改动）**

```bash
git status
# 若有未提交改动：
git add -A && git commit -m "test: full make test green for anomaly pagination/type filter"
```

---

## 完成标准（对照 spec §9）

1. 异常列表出现「类型」下拉，选某类型仅含该类型记录，「全部」恢复。 ✅ Task 4-5
2. 分页栏：首页/上一页/页码/下一页/末页 + 跳转输入；越界/非数字/空值不发请求。 ✅ Task 4-5
3. 每页 50 条；超 50 可翻页。 ✅ Task 1-2
4. `make test` 全绿（Node + Go，含新增 anomaly 测试）。 ✅ Task 7
5. 不引入对 worker / job 契约 / trace 写入的改动。 ✅ 全程约束
