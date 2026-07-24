package admin

import "testing"

// 这些是分页纯函数的直接单测（接口即测试面）。
// ListTraces/ListAnomalies 的端到端分页行为另由 repository_test.go / handlers_test.go 守护。

func TestClampPagination(t *testing.T) {
	tests := []struct {
		name       string
		page       int
		limit      int
		totalItems int64
		wantPage   int
		wantPages  int
		wantPrev   bool
		wantNext   bool
	}{
		{name: "middle page", page: 2, limit: 50, totalItems: 120, wantPage: 2, wantPages: 3, wantPrev: true, wantNext: true},
		{name: "first of many", page: 1, limit: 50, totalItems: 120, wantPage: 1, wantPages: 3, wantPrev: false, wantNext: true},
		{name: "last page", page: 3, limit: 50, totalItems: 120, wantPage: 3, wantPages: 3, wantPrev: true, wantNext: false},
		{name: "page beyond end clamps to last", page: 5, limit: 50, totalItems: 120, wantPage: 3, wantPages: 3, wantPrev: true, wantNext: false},
		{name: "page beyond single page clamps to one", page: 3, limit: 50, totalItems: 10, wantPage: 1, wantPages: 1, wantPrev: false, wantNext: false},
		{name: "empty result set resets to page one", page: 7, limit: 50, totalItems: 0, wantPage: 1, wantPages: 0, wantPrev: false, wantNext: false},
		{name: "exact division", page: 2, limit: 50, totalItems: 100, wantPage: 2, wantPages: 2, wantPrev: true, wantNext: false},
		{name: "remainder rounds total pages up", page: 1, limit: 50, totalItems: 101, wantPage: 1, wantPages: 3, wantPrev: false, wantNext: true},
		{name: "one item one page", page: 1, limit: 50, totalItems: 1, wantPage: 1, wantPages: 1, wantPrev: false, wantNext: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := clampPagination(tt.page, tt.limit, tt.totalItems)
			if got.Page != tt.wantPage || got.TotalPages != tt.wantPages || got.HasPrev != tt.wantPrev || got.HasNext != tt.wantNext {
				t.Fatalf("clampPagination(%d, %d, %d) = %+v, want page=%d totalPages=%d hasPrev=%v hasNext=%v",
					tt.page, tt.limit, tt.totalItems, got, tt.wantPage, tt.wantPages, tt.wantPrev, tt.wantNext)
			}
			if got.PageSize != tt.limit {
				t.Fatalf("PageSize = %d, want %d", got.PageSize, tt.limit)
			}
			if got.TotalItems != tt.totalItems {
				t.Fatalf("TotalItems = %d, want %d", got.TotalItems, tt.totalItems)
			}
		})
	}
}

func TestNormalizeListPage(t *testing.T) {
	for _, tt := range []struct {
		in   int
		want int
	}{{-3, 1}, {0, 1}, {1, 1}, {5, 5}} {
		if got := normalizeListPage(tt.in); got != tt.want {
			t.Fatalf("normalizeListPage(%d) = %d, want %d", tt.in, got, tt.want)
		}
	}
}

func TestNormalizeListLimit(t *testing.T) {
	for _, tt := range []struct {
		in   int
		want int
	}{{-1, 100}, {0, 100}, {1, 1}, {50, 50}, {100, 100}, {101, 100}} {
		if got := normalizeListLimit(tt.in); got != tt.want {
			t.Fatalf("normalizeListLimit(%d) = %d, want %d", tt.in, got, tt.want)
		}
	}
}

func TestParsePageParam(t *testing.T) {
	for _, tt := range []struct {
		in   string
		want int
	}{{"", 1}, {"   ", 1}, {"abc", 1}, {"0", 1}, {"-2", 1}, {"2.5", 1}, {"1", 1}, {" 3 ", 3}, {"42", 42}} {
		if got := parsePageParam(tt.in); got != tt.want {
			t.Fatalf("parsePageParam(%q) = %d, want %d", tt.in, got, tt.want)
		}
	}
}
