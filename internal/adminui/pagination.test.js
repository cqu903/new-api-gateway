const test = require("node:test");
const assert = require("node:assert/strict");
const { normalize, pageNumbers, parseJumpPage } = require("./pagination.js");

// 这些用例直接测 pagination.js 的纯函数接口（接口即测试面），不再靠 vm 加载整个 app.js。
// app_*.test.js 里的 parseTraceJumpPage / parseAnomalyJumpPage / normalizeAnomalyPagination 用例已迁到此。

test("parseJumpPage validates page input against total pages", () => {
  const total = 5;
  assert.equal(parseJumpPage("3", total), 3);
  assert.equal(parseJumpPage(" 2 ", total), 2);
  assert.equal(parseJumpPage("1", total), 1);
  assert.equal(parseJumpPage("5", total), 5);
  assert.equal(parseJumpPage("", total), null);
  assert.equal(parseJumpPage("abc", total), null);
  assert.equal(parseJumpPage("0", total), null);
  assert.equal(parseJumpPage("6", total), null);
  assert.equal(parseJumpPage("-1", total), null);
  assert.equal(parseJumpPage("2.5", total), null);
});

test("normalize falls back to provided fallback when payload missing", () => {
  const p = normalize(undefined, { page: 2, pageSize: 50 });
  assert.equal(p.page, 2);
  assert.equal(p.pageSize, 50);
  assert.equal(p.totalPages, 0);
});

test("normalize prefers response fields over fallback", () => {
  const p = normalize(
    { page: 3, page_size: 20, total_items: 100, total_pages: 5, has_prev: true, has_next: true },
    { page: 1, pageSize: 50 },
  );
  assert.equal(p.page, 3);
  assert.equal(p.pageSize, 20);
  assert.equal(p.totalItems, 100);
  assert.equal(p.totalPages, 5);
  assert.equal(p.hasPrev, true);
  assert.equal(p.hasNext, true);
});

test("pageNumbers lists every page when total <= 7", () => {
  assert.deepEqual(pageNumbers({ page: 1, totalPages: 5 }), [1, 2, 3, 4, 5]);
  assert.deepEqual(pageNumbers({ page: 3, totalPages: 7 }), [1, 2, 3, 4, 5, 6, 7]);
});

test("pageNumbers windows to first/last plus current neighborhood for large totals", () => {
  assert.deepEqual(pageNumbers({ page: 5, totalPages: 10 }), [1, 4, 5, 6, 10]);
  // current near start pads 2,3,4
  assert.deepEqual(pageNumbers({ page: 1, totalPages: 10 }), [1, 2, 3, 4, 10]);
  // current near end pads last-3,last-2,last-1
  assert.deepEqual(pageNumbers({ page: 10, totalPages: 10 }), [1, 7, 8, 9, 10]);
});
