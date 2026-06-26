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
