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
    window: { innerHeight: 900, innerWidth: 1440, UsagePage: { renderUsagePage: () => "" }, AdminAnalysisResultCards: { renderAnalysisResultCards: () => "" }, Chart: overrides.Chart || function Chart() {}, Pagination: require("./pagination.js") },
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
  applyAnomalyFilter: typeof applyAnomalyFilter !== "undefined" ? applyAnomalyFilter : undefined,
  ANOMALY_TYPE_FILTERS: typeof ANOMALY_TYPE_FILTERS !== "undefined" ? ANOMALY_TYPE_FILTERS : undefined,
};`,
    sandbox,
  );
  return { app: sandbox.module.exports, fakeApp };
}

// parseAnomalyJumpPage 的测试已迁至 pagination.test.js（与 trace 合并测 Pagination.parseJumpPage）。

// normalize 的 fallback 测试已迁至 pagination.test.js（直接测 Pagination.normalize）。

test("ANOMALY_TYPE_FILTERS includes 全部 plus the five live types", () => {
  const { app } = loadAppModule();
  const values = app.ANOMALY_TYPE_FILTERS.map((o) => o.value);
  // assert element-wise with assert.equal (not deepEqual): ANOMALY_TYPE_FILTERS
  // comes from the vm sandbox, and Node's deepEqual treats cross-realm values
  // as "same structure but not reference-equal".
  assert.equal(values.length, 6);
  assert.equal(values[0], "");
  assert.equal(values[1], "high_trace_tokens");
  assert.equal(values[2], "long_output_anomaly");
  assert.equal(values[3], "off_hours_high_usage");
  assert.equal(values[4], "non_work_use");
  assert.equal(values[5], "multivariate_anomaly");
});

test("applyAnomalyFilter reads the select into state and resets page to 1", () => {
  const { app } = loadAppModule({ querySelector: (sel) => (sel === "#anomaly-filter-type" ? { value: "non_work_use" } : undefined) });
  app.state.anomalies.page = 5;
  app.state.anomalies.anomalyType = "stale";

  app.applyAnomalyFilter();

  assert.equal(app.state.anomalies.anomalyType, "non_work_use");
  assert.equal(app.state.anomalies.page, 1);
});

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
