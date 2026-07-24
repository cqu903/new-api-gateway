// 分页纯函数模块：归一化服务端分页响应、推算页码窗口、解析跳页输入。
// 零 state、零 DOM——调用方负责把结果写回各自的视图状态。详见 CONTEXT.md → Pagination。
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.Pagination = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  function finiteNumber(value) {
    const number = Number(value || 0);
    return Number.isFinite(number) ? number : 0;
  }

  // normalize 把服务端分页响应归一化为视图用的分页对象；缺失字段用 fallback（当前请求的页 / 页大小）兜底。
  // pageSize 的真值来自响应（服务端 defaultListPageSize），fallback 不再假设固定页大小。
  function normalize(pagination, fallback) {
    const normalized = pagination || {};
    const fb = fallback || {};
    const fallbackPage = Math.max(1, finiteNumber(fb.page) || 1);
    const fallbackPageSize = Math.max(1, finiteNumber(fb.pageSize) || 1);
    return {
      page: Math.max(1, finiteNumber(normalized.page) || fallbackPage),
      pageSize: Math.max(1, finiteNumber(normalized.page_size) || fallbackPageSize),
      totalItems: Math.max(0, finiteNumber(normalized.total_items)),
      totalPages: Math.max(0, finiteNumber(normalized.total_pages)),
      hasPrev: Boolean(normalized.has_prev),
      hasNext: Boolean(normalized.has_next),
    };
  }

  // pageNumbers 推算分页器要展示的页码窗口（首末页 + 当前页邻域；总页数 <=7 时全展示）。
  function pageNumbers(pagination) {
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

  // parseJumpPage 把跳页输入解析为 [1, totalPages] 内的整数；非法 / 越界返回 null。
  function parseJumpPage(raw, totalPages) {
    const trimmed = String(raw ?? "").trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 1 || n > totalPages) return null;
    return n;
  }

  return { normalize, pageNumbers, parseJumpPage };
});
