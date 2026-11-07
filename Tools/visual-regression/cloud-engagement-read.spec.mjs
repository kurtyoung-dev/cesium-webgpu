// cloud-engagement-read.spec.mjs - the engine engagement flags the weather-dial cells read.
//
// @purpose Node spec for lib/cloud-engagement-read.mjs: the page function runs REAL inside a page world that holds only what a case gives it, so a flag the page does not hold answers NOT AVAILABLE naming its seam and a reader that invents a value goes red (the cache's populations and vertical request flags, the owned weather provider's useWorkers; a non-boolean, a missing cache, a missing step are each NOT AVAILABLE, never false), the Node reader names every flag it asked for and survives a page that throws, the expectation a cell puts on a page (populations true on the on page and false on the off page, the others true), the per-page judgement (FAIL when a read flag differs, NOT AVAILABLE when one cannot be read and none differs, PASS otherwise) and its fold across pages (a failure outranks an unread flag); with inertness mutants that make the value check, the unread branch, the off-page expectation and the failure precedence unreachable, each re-running the behaviour assertion against the mutant.
// @status ACTIVE
//
// The pages are the fake browser's vm worlds (`engagementWorld`): nothing here
// launches a browser or reads a PNG.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as realModule from "./lib/cloud-engagement-read.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { makeFakeBrowser } from "./lib/landing-fake-browser.mjs";

const MODULE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "lib",
  "cloud-engagement-read.mjs",
);

const CACHE_SEAM = "viewer.scene.context._cloudCache";
const OWNED_SEAM =
  "viewer.scene.globe.defaultCloudCollection._weatherState._owned.useWorkers";

/** A page world with a cloud cache holding `cache` and an owned provider with `owned`. */
const world = ({ cache, owned } = {}) => ({
  viewer: {
    scene: {
      context: cache === undefined ? {} : { _cloudCache: cache },
      globe: {
        defaultCloudCollection:
          owned === undefined ? {} : { _weatherState: { _owned: owned } },
      },
    },
  },
});

/** A fake page whose engagement read sees `globals`. */
async function pageWith(globals) {
  const browser = makeFakeBrowser(
    { events: [], scripts: [], urls: [], selectors: [], contexts: [] },
    { engagementWorld: () => globals },
  );
  return (await browser.newContext({})).newPage();
}

const NAMES = realModule.ENGAGEMENT_FLAG_NAMES;

/** Every behaviour of the page read and its record builder, asserted against `mod`. */
async function behaviourRead(mod) {
  // A page that holds all three flags answers each as the page has it.
  const full = await pageWith(
    world({
      cache: {
        weatherPopulationsRequested: true,
        weatherVerticalRequested: false,
      },
      owned: { useWorkers: true },
    }),
  );
  assert.deepEqual(await mod.readCloudEngagement(full, [...NAMES]), {
    populationsRequested: { available: true, value: true },
    verticalRequested: { available: true, value: false },
    workersEnabled: { available: true, value: true },
  });

  // A page that holds nothing answers NOT AVAILABLE for each, naming the seam;
  // no flag reads as false.
  const empty = await mod.readCloudEngagement(await pageWith({}), [...NAMES]);
  for (const name of NAMES) {
    assert.equal(empty[name].available, false, `${name} is not a default`);
    assert.equal(Object.hasOwn(empty[name], "value"), false);
    assert.match(empty[name].reason, /^NOT AVAILABLE: viewer\./);
    assert.ok(
      empty[name].reason.includes(mod.ENGAGEMENT_FLAGS[name].seam),
      `${name} names ${mod.ENGAGEMENT_FLAGS[name].seam}`,
    );
  }
  assert.match(empty.populationsRequested.reason, /viewer is not an object/);

  // A cache without the field (the WebGL page, an engine without the seam):
  // the missing step is named.
  const noField = await mod.readCloudEngagement(
    await pageWith(world({ cache: {} })),
    ["populationsRequested"],
  );
  assert.equal(noField.populationsRequested.available, false);
  assert.match(
    noField.populationsRequested.reason,
    /_cloudCache\.weatherPopulationsRequested is not a boolean/,
  );

  // A missing cache: the step before the field is named.
  const noCache = await mod.readCloudEngagement(await pageWith(world()), [
    "verticalRequested",
  ]);
  assert.ok(noCache.verticalRequested.reason.includes(CACHE_SEAM));
  assert.match(
    noCache.verticalRequested.reason,
    /viewer\.scene\.context\._cloudCache is not an object/,
  );

  // A value that is not a boolean is not read as one.
  const notBoolean = await mod.readCloudEngagement(
    await pageWith(world({ owned: { useWorkers: 1 } })),
    ["workersEnabled"],
  );
  assert.equal(notBoolean.workersEnabled.available, false);
  assert.ok(notBoolean.workersEnabled.reason.includes(OWNED_SEAM));
  assert.match(notBoolean.workersEnabled.reason, /useWorkers is not a boolean/);

  // A provider that is missing in the middle of the path names the step.
  const noProvider = await mod.readCloudEngagement(
    await pageWith({
      viewer: {
        scene: { globe: { defaultCloudCollection: { _weatherState: {} } } },
      },
    }),
    ["workersEnabled"],
  );
  assert.match(
    noProvider.workersEnabled.reason,
    /_weatherState\._owned is not an object/,
  );

  // Only the named flags are read.
  const onlyOne = await mod.readCloudEngagement(
    await pageWith(world({ cache: { weatherVerticalRequested: true } })),
    ["verticalRequested"],
  );
  assert.deepEqual(Object.keys(onlyOne), ["verticalRequested"]);

  // A page whose read throws leaves every flag NOT AVAILABLE, naming the throw.
  const thrown = await mod.readCloudEngagement(
    {
      evaluate: async () => {
        throw new Error("Execution context was destroyed");
      },
    },
    ["populationsRequested", "workersEnabled"],
  );
  for (const name of ["populationsRequested", "workersEnabled"]) {
    assert.equal(thrown[name].available, false);
    assert.match(thrown[name].reason, /the read threw: Execution context/);
  }

  // An answer that is nothing, or lacks a flag, never becomes a value.
  const nothing = mod.buildEngagementRecord(null, ["verticalRequested"]);
  assert.equal(nothing.verticalRequested.available, false);
  assert.match(nothing.verticalRequested.reason, /returned nothing/);
  const unknown = mod.buildEngagementRecord({}, ["nonsense"]);
  assert.match(unknown.nonsense.reason, /unknown engagement flag/);
}

test("a: the page function reads each flag from the page's own state, and answers NOT AVAILABLE naming the seam for anything it cannot read", async () => {
  await behaviourRead(realModule);
});

const CELL = Object.freeze({
  populationsCoverage: { off: "single-layer", on: "populations" },
  engagement: ["populationsRequested"],
});
const VERTICAL_CELL = Object.freeze({ engagement: ["verticalRequested"] });
const read = (value) => ({ available: true, value });
const unread = (seam) => ({
  available: false,
  reason: `NOT AVAILABLE: ${seam}`,
});

/** The expectation, the per-page judgement and its fold, asserted against `mod`. */
function behaviourJudge(mod) {
  // The populations flag is true on the on page and false on the off page; a
  // page that is neither is not judged; the other flags are true wherever
  // they are judged.
  assert.equal(
    mod.engagementExpectation(CELL, "populationsRequested", "populations"),
    true,
  );
  assert.equal(
    mod.engagementExpectation(CELL, "populationsRequested", "single-layer"),
    false,
  );
  assert.equal(
    mod.engagementExpectation(CELL, "populationsRequested", "elsewhere"),
    undefined,
  );
  assert.equal(
    mod.engagementExpectation(VERTICAL_CELL, "verticalRequested", "scene"),
    true,
  );
  assert.equal(mod.wantsEngagement(CELL), true);
  assert.equal(mod.wantsEngagement({}), false);
  assert.equal(mod.wantsEngagement({ engagement: [] }), false);

  const on = (flag) => ({ populationsRequested: flag });
  assert.equal(
    mod.judgeEngagement(CELL, "populations", on(read(true))).outcome,
    "PASS",
  );
  assert.equal(
    mod.judgeEngagement(CELL, "single-layer", on(read(false))).outcome,
    "PASS",
  );

  // The population march did not run: the flag is false on the on page.
  const notRun = mod.judgeEngagement(CELL, "populations", on(read(false)));
  assert.equal(notRun.outcome, "FAIL");
  assert.match(notRun.reasons[0], /the population march did not run/);
  assert.deepEqual(notRun.flags, {
    populationsRequested: { expected: true, value: false },
  });

  // It ran on the single-layer page.
  const ranOnOff = mod.judgeEngagement(CELL, "single-layer", on(read(true)));
  assert.equal(ranOnOff.outcome, "FAIL");
  assert.match(ranOnOff.reasons[0], /ran on the single-layer page/);

  // A flag the page could not read is NOT AVAILABLE, naming the seam; so is a
  // record with no engagement at all.
  const seam = "viewer.scene.context._cloudCache.weatherPopulationsRequested";
  const na = mod.judgeEngagement(CELL, "populations", on(unread(seam)));
  assert.equal(na.outcome, "NOT AVAILABLE");
  assert.ok(na.reasons[0].includes(seam));
  assert.equal(na.flags.populationsRequested.value, null);
  const missing = mod.judgeEngagement(CELL, "populations", undefined);
  assert.equal(missing.outcome, "NOT AVAILABLE");
  assert.ok(missing.reasons[0].includes(seam));

  // The vertical and workers flags fail when false.
  const vertical = mod.judgeEngagement(VERTICAL_CELL, "scene", {
    verticalRequested: read(false),
  });
  assert.equal(vertical.outcome, "FAIL");
  assert.match(vertical.reasons[0], /vertical weather march did not run/);
  const workers = mod.judgeEngagement(
    { engagement: ["workersEnabled"] },
    "scene",
    {
      workersEnabled: read(false),
    },
  );
  assert.match(workers.reasons[0], /does not use workers/);

  // Across pages a failure outranks an unread flag; an unread flag outranks a pass.
  const pass = { outcome: "PASS", reasons: [], flags: {} };
  const fail = { outcome: "FAIL", reasons: ["f"], flags: {} };
  const unreadJudged = { outcome: "NOT AVAILABLE", reasons: ["u"], flags: {} };
  assert.deepEqual(mod.foldEngagement([pass, pass]), {
    outcome: "PASS",
    reasons: [],
  });
  assert.deepEqual(mod.foldEngagement([unreadJudged, fail]), {
    outcome: "FAIL",
    reasons: ["f", "u"],
  });
  assert.deepEqual(mod.foldEngagement([pass, unreadJudged]), {
    outcome: "NOT AVAILABLE",
    reasons: ["u"],
  });
}

test("b: the expectation, the per-page judgement and the fold across pages", () => {
  behaviourJudge(realModule);
});

// ---------------------------------------------------------------------------
// Inertness mutants: each makes one clause unreachable and the SAME behaviour
// assertions, run against the mutant, must throw an AssertionError. The
// unmutated module passes them first, so a red is the mutant's.
// ---------------------------------------------------------------------------

/** The unmutated module passes the behaviour; the mutant must fail it by an assertion. */
async function assertRed(behaviour, mutated) {
  await behaviour(realModule);
  await assert.rejects(
    async () => behaviour(mutated),
    (error) => error instanceof assert.AssertionError,
  );
}

const MUTANTS = Object.freeze([
  {
    name: "the value check of a read flag is unreachable",
    behaviour: behaviourJudge,
    from: "    if (read.value !== expected) {",
    to: "    if (false && read.value !== expected) {",
  },
  {
    name: "the unread-flag branch records no reason",
    behaviour: behaviourJudge,
    from: "      unavailable.push(\n        read?.reason ??",
    to: "      false &&\n        unavailable.push(\n        read?.reason ??",
  },
  {
    name: "the off page expects nothing",
    behaviour: behaviourJudge,
    from: "    if (pair?.off === pageName) {",
    to: "    if (false && pair?.off === pageName) {",
  },
  {
    name: "a failure no longer outranks an unread flag",
    behaviour: behaviourJudge,
    from: '    failures.length > 0 ? "FAIL" : unread.length > 0 ? "NOT AVAILABLE" : "PASS";',
    to: '    false && failures.length > 0 ? "FAIL" : unread.length > 0 ? "NOT AVAILABLE" : "PASS";',
  },
  {
    name: "a step that is not an object is no longer named",
    behaviour: behaviourRead,
    from: "        missing = `${walked} is not an object`;",
    to: "        missing = null;",
  },
  {
    name: "a value that is not a boolean is read as one",
    behaviour: behaviourRead,
    from: '    if (missing === null && typeof at !== "boolean") {',
    to: '    if (false && missing === null && typeof at !== "boolean") {',
  },
]);

for (const mutant of MUTANTS) {
  test(`c: mutant, ${mutant.name}, goes red by the behaviour assertions`, async () => {
    const mutated = await importMutated(MODULE, [[mutant.from, mutant.to]]);
    await assertRed(mutant.behaviour, mutated);
  });
}
