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
  loadTraces,
  renderTraces,
  renderAnomalies: typeof renderAnomalies !== "undefined" ? renderAnomalies : undefined,
  renderTraceDetail: typeof renderTraceDetail !== "undefined" ? renderTraceDetail : undefined,
  applyTraceSearch: typeof applyTraceSearch !== "undefined" ? applyTraceSearch : undefined,
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

// parseTraceJumpPage 的测试已迁至 pagination.test.js（直接测 Pagination.parseJumpPage）。

test("renderTraces emits a jump-to-page input bounded by total pages", () => {
  const { app, fakeApp } = loadAppModule();
  app.state.view = "traces";
  app.renderTraces({ traces: [], pagination: { page: 2, page_size: 50, total_items: 150, total_pages: 3, has_prev: true, has_next: true } });
  assert.match(fakeApp.innerHTML, /id="trace-jump-page"[^>]*min="1"[^>]*max="3"/);
  assert.match(fakeApp.innerHTML, /id="trace-jump-go"/);
});

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
