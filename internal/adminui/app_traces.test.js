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
