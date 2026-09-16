// @purpose Proves that one wedged Sandcastle demo cannot stall a sweep leg.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { OriginRewriteRefusal } from "./lib/sandcastle2-origin-rewrite.mjs";

const source = fs.readFileSync(
  new URL("./sandcastle-smoke.mjs", import.meta.url),
  "utf8",
);

function load(run, mutate = (text) => text) {
  const start = source.indexOf("async function withDemoDeadline(");
  const end = source.indexOf("async function runSweepDemoBody(", start);
  assert.ok(start > 0 && end > start);
  return vm.runInNewContext(
    mutate(source.slice(start, end)) + "\n({withDemoDeadline, runSweepDemo});",
    {
      setTimeout,
      clearTimeout,
      OriginRewriteRefusal,
      DEMO_TIMEOUT_MS: 20,
      BASE: "http://localhost:8096",
      buildSandcastle2Url: ({ id }) => "http://localhost:8096/" + id,
      isNoViewerId: () => false,
      runSweepDemoBody: run,
    },
  );
}

async function assertBounded(runSweepDemo) {
  let timer;
  try {
    const result = await Promise.race([
      runSweepDemo({}, "wedged", { renderer: "webgpu" }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("still pending"), 300);
      }),
    ]);
    assert.notEqual(
      result,
      "still pending",
      "the demo completes within the outer test bound",
    );
    assert.equal(result.outcome, "TIMEOUT");
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.match(
      result.errors[0],
      /FAILED-TIMEOUT: demo=wedged; bound=20ms; lastFrameNumber=17/,
    );
    return result;
  } finally {
    clearTimeout(timer);
  }
}

test("a non-settling demo records its last frame, closes, and lets the next demo run", async () => {
  const closed = [];
  const { runSweepDemo } = load((_browser, id, _options, progress) => {
    progress.close = async () => {
      closed.push(id);
    };
    if (id === "next") return { outcome: "PASS", ok: true };
    progress.lastFrameNumber = 17;
    return new Promise(() => {});
  });
  await assertBounded(runSweepDemo);
  assert.deepEqual(closed, ["wedged"]);
  assert.equal((await runSweepDemo({}, "next", {})).outcome, "PASS");
});

test("the same bounded assertion rejects an inert deadline", async () => {
  const { runSweepDemo } = load(
    (_browser, _id, _options, progress) => {
      progress.lastFrameNumber = 17;
      return new Promise(() => {});
    },
    (text) => {
      const anchor = "timer = setTimeout(() => resolve(expired), timeoutMs);";
      assert.equal(text.split(anchor).length - 1, 1);
      return text.replace(anchor, "timer = setTimeout(() => {}, timeoutMs);");
    },
  );
  await assert.rejects(
    assertBounded(runSweepDemo),
    /the demo completes within the outer test bound/,
  );
});

test("a startup that never creates a context also reaches the deadline", async () => {
  const { runSweepDemo } = load(() => new Promise(() => {}));
  const result = await runSweepDemo({}, "startup", {});
  assert.equal(result.outcome, "TIMEOUT");
  assert.match(result.errors[0], /lastFrameNumber=unobserved/);
});

test("origin refusal before the deadline is preserved", async () => {
  const refusal = new OriginRewriteRefusal(
    "WRONG_ORIGIN",
    "fixture origin breach",
  );
  const { withDemoDeadline } = load();
  await assert.rejects(
    withDemoDeadline(
      () => {
        throw refusal;
      },
      {},
      20,
    ),
    (error) => error === refusal,
  );
});

test("origin refusal from timeout cleanup is preserved", async () => {
  const refusal = new OriginRewriteRefusal(
    "WRONG_ORIGIN",
    "cleanup origin breach",
  );
  const { withDemoDeadline } = load();
  await assert.rejects(
    withDemoDeadline(
      () => new Promise(() => {}),
      {
        close: async () => {
          throw refusal;
        },
      },
      10,
    ),
    (error) => error === refusal,
  );
});

test("unresponsive cleanup has its own bound and refuses the unverified origin", async () => {
  const { withDemoDeadline } = load();
  await assert.rejects(
    withDemoDeadline(
      () => new Promise(() => {}),
      { close: () => new Promise(() => {}) },
      10,
      10,
    ),
    (error) => error.code === "DEMO_CLEANUP_TIMEOUT",
  );
});

test("invalid deadline values are rejected", async () => {
  const { withDemoDeadline } = load();
  for (const value of [0, -1, Infinity, NaN]) {
    await assert.rejects(
      withDemoDeadline(() => {}, {}, value),
      /positive finite/,
    );
  }
});
