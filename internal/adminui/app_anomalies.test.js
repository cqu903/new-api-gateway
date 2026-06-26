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
