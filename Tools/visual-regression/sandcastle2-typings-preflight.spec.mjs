/**
 * Spec: the Sandcastle2 typings preflight refuses a served tree without typings.
 * @purpose Pin the refusal, its actionable message, and the HEAD→GET fallback, so a missing `gulp buildTs` can never present as a flaky engine again.
 * @status ACTIVE
 *
 * Run: node --test Tools/visual-regression/sandcastle2-typings-preflight.spec.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  SANDCASTLE2_TYPINGS,
  assertSandcastle2Typings,
  checkSandcastle2Typings,
  scoreTypingsPreflight,
} from "./lib/sandcastle2-typings-preflight.mjs";

const BASE = "http://localhost:8080";

/** A fetch stand-in driven by a path → status (or thrown error) table. */
function fetchStub(table, log = []) {
  return async (url, init) => {
    const path = new URL(url).pathname;
    log.push(`${init?.method ?? "GET"} ${path}`);
    const entry = table[path];
    if (entry === undefined) {
      throw new Error(`unexpected request for ${path}`);
    }
    if (entry instanceof Error) {
      throw entry;
    }
    const status =
      typeof entry === "number" ? entry : entry[init?.method ?? "GET"];
    if (status === undefined) {
      throw new Error(`no ${init?.method} entry for ${path}`);
    }
    return {
      status,
      ok: status === 200,
      body: { cancel: async () => {} },
    };
  };
}

test("the checked paths are exactly the two `gulp buildTs` outputs", () => {
  assert.deepEqual(
    [...SANDCASTLE2_TYPINGS],
    ["/packages/engine/index.d.ts", "/packages/widgets/index.d.ts"],
    "the preflight must check both typings the built app points Monaco at",
  );
});

test("a served tree with both typings passes", async () => {
  const verdict = await checkSandcastle2Typings({
    base: BASE,
    fetchImpl: fetchStub({
      "/packages/engine/index.d.ts": 200,
      "/packages/widgets/index.d.ts": 200,
    }),
  });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.missing, []);
  assert.match(verdict.reason, /typings resolve/);
});

test("a missing engine typing refuses and names the remedy", async () => {
  const verdict = await checkSandcastle2Typings({
    base: BASE,
    fetchImpl: fetchStub({
      "/packages/engine/index.d.ts": 404,
      "/packages/widgets/index.d.ts": 200,
    }),
  });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.missing, ["/packages/engine/index.d.ts (HTTP 404)"]);
  assert.match(
    verdict.reason,
    /gulp buildTs/,
    "the message must name the build step that produces the file",
  );
  assert.match(
    verdict.reason,
    /intermittently|intermittent|hang/i,
    "the message must say what the absence otherwise looks like, or a reader " +
      "will assume the sweep is simply broken",
  );
});

test("a missing widgets typing is caught too", async () => {
  const verdict = await checkSandcastle2Typings({
    base: BASE,
    fetchImpl: fetchStub({
      "/packages/engine/index.d.ts": 200,
      "/packages/widgets/index.d.ts": 404,
    }),
  });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.missing, [
    "/packages/widgets/index.d.ts (HTTP 404)",
  ]);
});

test("a server that refuses HEAD is re-probed with GET", async () => {
  const log = [];
  const verdict = await checkSandcastle2Typings({
    base: BASE,
    fetchImpl: fetchStub(
      {
        "/packages/engine/index.d.ts": { HEAD: 405, GET: 200 },
        "/packages/widgets/index.d.ts": { HEAD: 405, GET: 200 },
      },
      log,
    ),
  });
  assert.equal(
    verdict.ok,
    true,
    "a server without HEAD support must not read as missing typings",
  );
  assert.deepEqual(log, [
    "HEAD /packages/engine/index.d.ts",
    "GET /packages/engine/index.d.ts",
    "HEAD /packages/widgets/index.d.ts",
    "GET /packages/widgets/index.d.ts",
  ]);
});

test("a 404 is NOT re-probed with GET — absent is absent", async () => {
  const log = [];
  await checkSandcastle2Typings({
    base: BASE,
    fetchImpl: fetchStub(
      {
        "/packages/engine/index.d.ts": { HEAD: 404 },
        "/packages/widgets/index.d.ts": { HEAD: 200 },
      },
      log,
    ),
  });
  assert.deepEqual(log, [
    "HEAD /packages/engine/index.d.ts",
    "HEAD /packages/widgets/index.d.ts",
  ]);
});

test("an unreachable server refuses with the transport error", async () => {
  const verdict = await checkSandcastle2Typings({
    base: BASE,
    fetchImpl: fetchStub({
      "/packages/engine/index.d.ts": new Error("ECONNREFUSED"),
      "/packages/widgets/index.d.ts": 200,
    }),
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.missing[0], /ECONNREFUSED/);
});

test("the scorer is a pure function of the probe results", () => {
  assert.equal(scoreTypingsPreflight([{ path: "/a", status: 200 }]).ok, true);
  const bad = scoreTypingsPreflight([
    { path: "/a", status: 200 },
    { path: "/b", status: 500 },
  ]);
  assert.equal(bad.ok, false, "a 500 is not a resolvable typing either");
  assert.deepEqual(bad.missing, ["/b (HTTP 500)"]);
});

test("the asserting entry point throws a coded refusal", async () => {
  await assert.rejects(
    () =>
      assertSandcastle2Typings({
        base: BASE,
        fetchImpl: fetchStub({
          "/packages/engine/index.d.ts": 404,
          "/packages/widgets/index.d.ts": 404,
        }),
      }),
    (error) => {
      assert.equal(error.code, "SANDCASTLE2_TYPINGS_MISSING");
      assert.equal(error.missing.length, 2);
      assert.match(error.message, /^REFUSED: /);
      return true;
    },
  );

  const passing = await assertSandcastle2Typings({
    base: BASE,
    fetchImpl: fetchStub({
      "/packages/engine/index.d.ts": 200,
      "/packages/widgets/index.d.ts": 200,
    }),
  });
  assert.equal(passing.ok, true, "a good tree must not throw");
});
