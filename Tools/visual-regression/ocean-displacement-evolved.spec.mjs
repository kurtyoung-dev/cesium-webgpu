// ocean-displacement-evolved.spec.mjs - lane TAR-ALDARION (Belen). Pure Node: no browser, no GPU.
//
// @purpose Exercises the evolved-epoch readback of ocean-displacement-readback.mjs (the displacement field read at a later pinned clock, the clock restored) and its kernel-identity verdict, and the cross-page evolved entry of metrics/landing-cross-page.mjs, over a fake page whose clock the readback moves, each with an inertness mutant.
// @status ACTIVE
//
// Split from ocean-displacement-readback.spec.mjs to keep both files under the
// size rule. The fake page answers the page functions by identity
// (pageSetClock, pageReadOceanDisplacement) and derives the wave time from the
// clock it is called under, as the engine does; what it cannot show (the real
// sea evolving under the real compute chain) is for the Edge job.

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CLOCK_STEPS_MODULE_URL, pageSetClock } from "./lib/clock-steps.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import {
  crossPageVerdicts,
  kernelIdentityComparisons,
} from "./lib/metrics/landing-cross-page.mjs";
import {
  OCEAN_EVOLVED_ADVANCE_SECONDS,
  OCEAN_READBACK_DEFAULT_FRAMES,
  compareDisplacementReadbacks,
  evolvedClockIso,
  evolvedKernelIdentityVerdict,
  pageReadOceanDisplacement,
  readOceanDisplacementEvolved,
} from "./lib/ocean-displacement-readback.mjs";

const MODULE = fileURLToPath(
  new URL("./lib/ocean-displacement-readback.mjs", import.meta.url),
);
const CROSS_PAGE_MODULE = fileURLToPath(
  new URL("./lib/metrics/landing-cross-page.mjs", import.meta.url),
);

// A comparable readback record (the same shape as the sibling spec's).
function leg(overrides = {}) {
  return {
    available: true,
    format: "rgba16float",
    width: 8,
    height: 8,
    hash: "aa",
    nonZero: 40,
    kernel: "stockham",
    simulationSeconds: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The evolved-epoch readback (a later pinned clock) and its verdict.
// ---------------------------------------------------------------------------

const CLOCK = "2026-06-21T16:00:00Z";

test("evolvedClockIso: the instant `advance` seconds later, and a TypeError for a bad clock or advance", () => {
  assert.equal(evolvedClockIso(CLOCK, 30), "2026-06-21T16:00:30.000Z");
  assert.equal(
    evolvedClockIso("2026-06-21T23:59:50Z", 20),
    "2026-06-22T00:00:10.000Z",
    "the advance carries across midnight",
  );
  assert.equal(
    evolvedClockIso("2026-06-21T18:00:00+02:00", 1.5),
    "2026-06-21T16:00:01.500Z",
    "an offset clock is read as the instant it names",
  );
  assert.equal(OCEAN_EVOLVED_ADVANCE_SECONDS, 30);
  assert.ok(Number.isInteger(OCEAN_EVOLVED_ADVANCE_SECONDS));
  for (const clock of [
    "",
    "June 21 2026",
    "2026-06-21",
    "2026-06-21T16:00:00",
    "2026-13-45T99:99:99Z",
    null,
    undefined,
    20260621,
  ]) {
    assert.throws(() => evolvedClockIso(clock, 30), TypeError, String(clock));
  }
  for (const advance of [0, -1, NaN, Infinity, "30", null, undefined]) {
    assert.throws(
      () => evolvedClockIso(CLOCK, advance),
      TypeError,
      String(advance),
    );
  }
});

// A page whose clock the readback moves: the set-clock function records the
// instant, the displacement read answers with a wave time derived from the
// clock it is called under, as the engine's `simulationSeconds` is.
function makeClockPage(options = {}) {
  const {
    base = CLOCK,
    setFails = null,
    setThrows = null,
    restoreFails = null,
    readThrows = null,
    kernel = "stockham",
  } = options;
  const state = { clock: base, calls: [] };
  const page = {
    state,
    async evaluate(fn, arg) {
      if (fn === pageSetClock) {
        state.calls.push({ op: "set", iso: arg.iso, moduleUrl: arg.moduleUrl });
        const restoring = arg.iso === base;
        if (restoring ? restoreFails : setFails) {
          return { ok: false, reason: restoring ? restoreFails : setFails };
        }
        if (!restoring && setThrows) {
          throw new Error(setThrows);
        }
        state.clock = arg.iso;
        return { ok: true, observed: arg.iso.replace(/\.000Z$/, "Z") };
      }
      if (fn === pageReadOceanDisplacement) {
        state.calls.push({ op: "read", clock: state.clock, arg });
        if (readThrows) {
          throw new Error(readThrows);
        }
        return leg({
          kernel,
          simulationSeconds:
            (Date.parse(state.clock) - Date.parse(base)) / 1000,
          hash: `h${state.clock}`,
        });
      }
      throw new Error("unexpected page function");
    },
  };
  return page;
}

test("evolved read: the clock is set, the field read at it, then the clock restored - in that order", async () => {
  const page = makeClockPage();
  const record = await readOceanDisplacementEvolved(page, {
    clockIso: CLOCK,
    advanceSeconds: 45,
    frames: 3,
    includeValues: true,
    moduleUrl: "/m.js",
  });
  assert.deepEqual(
    page.state.calls.map((call) => [call.op, call.iso ?? call.clock]),
    [
      ["set", "2026-06-21T16:00:45.000Z"],
      ["read", "2026-06-21T16:00:45.000Z"],
      ["set", CLOCK],
    ],
  );
  assert.equal(page.state.calls[0].moduleUrl, "/m.js");
  assert.equal(page.state.calls[2].moduleUrl, "/m.js");
  assert.deepEqual(page.state.calls[1].arg, { frames: 3, includeValues: true });
  assert.equal(page.state.clock, CLOCK, "the clock ends at the rig's instant");
  assert.equal(record.available, true);
  assert.equal(record.simulationSeconds, 45, "the sea was read 45 s on");
  assert.equal(record.advanceSeconds, 45);
  assert.equal(record.evolvedClock, "2026-06-21T16:00:45Z");
  assert.equal(record.restoredClock, CLOCK);
  assert.equal("restoreReason" in record, false);
});

test("evolved read: the defaults are the exported advance, the readback's frame count and the clock dial's module", async () => {
  const page = makeClockPage();
  const record = await readOceanDisplacementEvolved(page, { clockIso: CLOCK });
  assert.equal(record.advanceSeconds, OCEAN_EVOLVED_ADVANCE_SECONDS);
  assert.equal(record.simulationSeconds, OCEAN_EVOLVED_ADVANCE_SECONDS);
  assert.deepEqual(page.state.calls[1].arg, {
    frames: OCEAN_READBACK_DEFAULT_FRAMES,
    includeValues: false,
  });
  assert.equal(page.state.calls[0].moduleUrl, CLOCK_STEPS_MODULE_URL);
});

test("evolved read: bad arguments are a TypeError before the clock moves", async () => {
  for (const options of [
    { clockIso: "not a clock" },
    { clockIso: CLOCK, advanceSeconds: 0 },
    { clockIso: CLOCK, advanceSeconds: NaN },
    { clockIso: CLOCK, frames: -1 },
    { clockIso: CLOCK, frames: 1.5 },
    {},
  ]) {
    const page = makeClockPage();
    await assert.rejects(
      readOceanDisplacementEvolved(page, options),
      TypeError,
      JSON.stringify(options),
    );
    assert.deepEqual(page.state.calls, [], "no page call was made");
  }
});

test("evolved read: a clock that cannot be set is unavailable and nothing else runs", async () => {
  for (const options of [
    { setFails: "the page has no viewer" },
    { setThrows: "the page was closed" },
  ]) {
    const page = makeClockPage(options);
    const record = await readOceanDisplacementEvolved(page, {
      clockIso: CLOCK,
    });
    assert.equal(record.available, false);
    assert.match(
      record.reason,
      options.setFails
        ? /could not be moved.*no viewer/
        : /threw: the page was/,
    );
    assert.equal(record.advanceSeconds, OCEAN_EVOLVED_ADVANCE_SECONDS);
    assert.equal(record.evolvedClock, null);
    assert.equal(record.restoredClock, null);
    assert.deepEqual(
      page.state.calls.map((call) => call.op),
      ["set"],
      "no read and no restore after a failed set",
    );
    assert.equal(
      compareDisplacementReadbacks(record, leg()).measured,
      false,
      "an unavailable evolved record is never a measurement",
    );
  }
});

test("evolved read: a read that throws still restores the clock; a restore that fails is recorded, not thrown", async () => {
  const thrown = makeClockPage({ readThrows: "the device was lost" });
  const unavailable = await readOceanDisplacementEvolved(thrown, {
    clockIso: CLOCK,
  });
  assert.equal(unavailable.available, false);
  assert.match(
    unavailable.reason,
    /reading the evolved field threw: the device/,
  );
  assert.deepEqual(
    thrown.state.calls.map((call) => call.op),
    ["set", "read", "set"],
  );
  assert.equal(thrown.state.clock, CLOCK);
  assert.equal(unavailable.restoredClock, CLOCK);

  const stuck = makeClockPage({ restoreFails: "the viewer went away" });
  const record = await readOceanDisplacementEvolved(stuck, {
    clockIso: CLOCK,
  });
  assert.equal(record.available, true, "the field was read");
  assert.equal(record.restoredClock, null);
  assert.match(record.restoreReason, /could not be restored.*went away/);
});

// A kernel's t = 0 record and its evolved one, as the page would return them.
function t0(kernel, hash = "f0") {
  return leg({ kernel, hash, simulationSeconds: 0 });
}
function t1(kernel, hash = "f30", extra = {}) {
  return leg({
    kernel,
    hash,
    simulationSeconds: 30,
    advanceSeconds: 30,
    ...extra,
  });
}
function evolvedLegs(overrides = {}) {
  return {
    a0: t0("stockham"),
    b0: t0("pingpong"),
    a1: t1("stockham"),
    b1: t1("pingpong"),
    advanceSeconds: 30,
    ...overrides,
  };
}

function assertEvolvedVerdict(verdict) {
  const pass = verdict("cell-x:webgpu:run1", evolvedLegs());
  assert.equal(pass.id, "cell-x:webgpu:run1:ifft-kernel-identity-evolved");
  assert.equal(pass.pass, true);
  assert.equal("notRun" in pass, false);
  assert.equal(pass.advanceSeconds, 30);
  assert.equal(pass.comparison.identical, true);

  const fail = verdict("cell-x", evolvedLegs({ b1: t1("pingpong", "other") }));
  assert.equal(fail.pass, false);
  assert.equal("notRun" in fail, false, "a measured mismatch is a fail");
  assert.equal(fail.comparison.identical, false);

  const withValues = verdict(
    "cell-x",
    evolvedLegs({
      a1: t1("stockham", "f30", { values: [1, 2] }),
      b1: t1("pingpong", "other", { values: [1, 5] }),
    }),
  );
  assert.equal(withValues.pass, false);
  assert.equal(withValues.comparison.maxAbsDelta, 3);

  const notRun = (legs, pattern, label) => {
    const result = verdict("cell-x", legs);
    assert.equal(result.pass, false, label);
    assert.equal(result.notRun, true, label);
    assert.equal(result.id, "cell-x:ifft-kernel-identity-evolved", label);
    assert.match(result.reason, pattern, label);
    assert.match(result.comparison.reason, pattern, label);
  };
  for (const advanceSeconds of [0, -30, NaN, undefined, null, "30"]) {
    notRun(
      evolvedLegs({ advanceSeconds }),
      /no positive finite advance/,
      `advance ${String(advanceSeconds)}`,
    );
  }
  notRun(
    evolvedLegs({
      b1: { available: false, reason: "no primitive", kernel: "pingpong" },
    }),
    /readback B is unavailable: no primitive/,
    "an unavailable evolved read",
  );
  notRun(
    evolvedLegs({ b1: t1("pingpong", "f30", { simulationSeconds: 31 }) }),
    /different wave times/,
    "evolved reads at unequal wave times",
  );
  notRun(
    evolvedLegs({ a0: leg({ kernel: "stockham", simulationSeconds: 1 }) }),
    /readback A was not taken 30 s after its t = 0 read.*did not move the sea/,
    "A moved only 29 s",
  );
  notRun(
    evolvedLegs({ b0: null }),
    /readback B was not taken 30 s after/,
    "no t = 0 record for B",
  );
  notRun(
    evolvedLegs({ a0: leg({ kernel: "stockham", simulationSeconds: null }) }),
    /readback A was not taken 30 s after/,
    "no t = 0 wave time for A",
  );
  notRun(
    evolvedLegs({
      a1: t1("stockham", "f0"),
      b1: t1("pingpong", "f0"),
    }),
    /the sea did not evolve/,
    "both fields unchanged since t = 0 (and equal, so a pass without the guard)",
  );
  notRun(
    evolvedLegs({ b1: t1("pingpong", "f0"), a1: t1("stockham", "f30") }),
    /readback B field at \+30 s hashes the same as at t = 0/,
    "one field unchanged since t = 0",
  );
  notRun(
    evolvedLegs({ b1: t1("stockham"), b0: t0("stockham") }),
    /two different kernels/,
    "one kernel against itself",
  );
  notRun(
    evolvedLegs({ a1: t1(null) }),
    /two different kernels/,
    "a leg that names no kernel",
  );
}

test("evolved verdict: pass or fail only for a measured pair whose sea moved; every other case is notRun", () => {
  assertEvolvedVerdict(evolvedKernelIdentityVerdict);
});

function evolvedPage(page, kernel, run, fields) {
  return {
    cell: "E-FFT-ifft",
    renderer: "webgpu",
    run,
    page,
    displacement: t0(kernel),
    ...fields,
  };
}

function crossPagePages(withEvolved, hashB = "f30") {
  return [
    evolvedPage(
      "stockham",
      "stockham",
      1,
      withEvolved ? { displacementEvolved: t1("stockham") } : {},
    ),
    evolvedPage(
      "pingpong",
      "pingpong",
      1,
      withEvolved ? { displacementEvolved: t1("pingpong", hashB) } : {},
    ),
  ];
}

function assertCrossPage(compare, verdictsOf) {
  const plain = compare(crossPagePages(false));
  assert.equal(plain.length, 1, "pages without evolved records: as before");
  assert.equal("evolved" in plain[0], false);
  assert.equal(
    plain[0].verdict.id,
    "E-FFT-ifft:webgpu:run1:ifft-kernel-identity",
  );
  assert.equal(plain[0].verdict.pass, true);
  assert.deepEqual(
    Object.keys(plain[0]).sort(),
    ["cell", "comparison", "pages", "renderer", "run", "verdict"],
    "the t = 0 entry keeps its shape",
  );

  const both = compare(crossPagePages(true));
  assert.equal(both.length, 2);
  assert.deepEqual(
    both[0],
    plain[0],
    "the t = 0 entry is untouched by the evolved pair",
  );
  assert.equal(both[1].evolved, true);
  assert.equal(both[1].advanceSeconds, 30);
  assert.deepEqual(both[1].pages, ["stockham", "pingpong"]);
  assert.equal(
    both[1].verdict.id,
    "E-FFT-ifft:webgpu:run1:ifft-kernel-identity-evolved",
  );
  assert.equal(both[1].verdict.pass, true);
  assert.equal(both[1].comparison, both[1].verdict.comparison);

  const verdicts = verdictsOf({ kernelIdentity: both });
  assert.deepEqual(
    verdicts.map((verdict) => [verdict.id, verdict.pass]),
    [
      ["E-FFT-ifft:webgpu:run1:ifft-kernel-identity", true],
      ["E-FFT-ifft:webgpu:run1:ifft-kernel-identity-evolved", true],
    ],
    "the evolved verdict is reported beside the t = 0 one",
  );

  const split = compare(crossPagePages(true, "diverged"));
  assert.equal(split[0].verdict.pass, true, "t = 0 identical");
  assert.equal(split[1].verdict.pass, false, "evolved fields differ");
  assert.equal("notRun" in split[1].verdict, false);

  const oneSided = compare([crossPagePages(true)[0], crossPagePages(false)[1]]);
  assert.equal(oneSided.length, 2);
  assert.equal(oneSided[1].verdict.notRun, true);
  assert.equal(oneSided[1].verdict.pass, false);

  const advances = compare([
    crossPagePages(true)[0],
    evolvedPage("pingpong", "pingpong", 1, {
      displacementEvolved: t1("pingpong", "f30", { advanceSeconds: 31 }),
    }),
  ]);
  assert.equal(advances[1].advanceSeconds, null);
  assert.equal(advances[1].verdict.notRun, true);

  const runs = compare([
    ...crossPagePages(true),
    ...crossPagePages(true).map((page) => ({ ...page, run: 2 })),
  ]);
  assert.deepEqual(
    runs.map((entry) => [entry.run, entry.evolved === true]),
    [
      [1, false],
      [1, true],
      [2, false],
      [2, true],
    ],
  );
}

test("cross-page: an evolved entry and verdict appear beside the t = 0 ones only for pages that carry the record", () => {
  assertCrossPage(kernelIdentityComparisons, crossPageVerdicts);
});

test("evolved-epoch: inertness mutants - each new behaviour made unreachable turns its check red", async () => {
  const assertRead = async (readEvolved) => {
    const page = makeClockPage();
    const record = await readEvolved(page, { clockIso: CLOCK });
    assert.deepEqual(
      page.state.calls.map((call) => [call.op, call.iso ?? call.clock]),
      [
        ["set", "2026-06-21T16:00:30.000Z"],
        ["read", "2026-06-21T16:00:30.000Z"],
        ["set", CLOCK],
      ],
    );
    assert.equal(record.simulationSeconds, 30);
    assert.equal(record.restoredClock, CLOCK);
  };
  await assertRead(readOceanDisplacementEvolved);

  const readCases = [
    [
      "the evolved readback skipped: the t = 0 read, the clock never moved",
      `set = await page.evaluate(pageSetClock, { iso: evolvedIso, moduleUrl });`,
      `set = { ok: true, observed: null };`,
    ],
    [
      "the restore skipped: the clock is left at the evolved instant",
      `const restore = await page.evaluate(pageSetClock, {\n      iso: clockIso,\n      moduleUrl,\n    });`,
      `const restore = { ok: true, observed: null };`,
    ],
  ];
  for (const [label, anchor, replacement] of readCases) {
    const mutated = await importMutated(MODULE, [[anchor, replacement]]);
    await assert.rejects(
      assertRead(mutated.readOceanDisplacementEvolved),
      (error) => error instanceof assert.AssertionError,
      label,
    );
  }

  const verdictCases = [
    [
      "the advance guard",
      `!(advanceSeconds > 0)\n  ) {\n    return notRun(`,
      `!(advanceSeconds > 0) && false\n  ) {\n    return notRun(`,
    ],
    [
      "the not-measured guard",
      `if (comparison.measured !== true) {\n    return notRun(comparison.reason);`,
      `if (false && comparison.measured !== true) {\n    return notRun(comparison.reason);`,
    ],
    [
      "the clock-did-not-move-the-sea guard",
      `!Number.isFinite(t0) ||\n      !(Math.abs(t1 - t0 - advanceSeconds) <= WAVE_TIME_TOLERANCE_SECONDS)`,
      `false`,
    ],
    [
      "the sea-did-not-evolve guard",
      `if (start.hash === evolved.hash) {`,
      `if (false && start.hash === evolved.hash) {`,
    ],
    [
      "the two-different-kernels guard",
      `comparison.kernelB === comparison.kernelA\n  ) {\n    return notRun(`,
      `false\n  ) {\n    return notRun(`,
    ],
    [
      "the pass is the hash identity",
      `return { id, pass: comparison.identical, advanceSeconds, comparison };`,
      `return { id, pass: true, advanceSeconds, comparison };`,
    ],
  ];
  for (const [label, anchor, replacement] of verdictCases) {
    const mutated = await importMutated(MODULE, [[anchor, replacement]]);
    assert.throws(
      () => assertEvolvedVerdict(mutated.evolvedKernelIdentityVerdict),
      (error) => error instanceof assert.AssertionError,
      label,
    );
  }

  const crossMutants = [
    [
      "the evolved branch",
      `if (a1 !== null || b1 !== null) {`,
      `if (false && (a1 !== null || b1 !== null)) {`,
    ],
    ["the evolved marker", `evolved: true,`, `evolved: false,`],
    [
      "the advance agreement",
      `a1?.advanceSeconds === b1?.advanceSeconds`,
      `true`,
    ],
  ];
  for (const [label, anchor, replacement] of crossMutants) {
    const mutated = await importMutated(CROSS_PAGE_MODULE, [
      [anchor, replacement],
    ]);
    assert.throws(
      () =>
        assertCrossPage(
          mutated.kernelIdentityComparisons,
          mutated.crossPageVerdicts,
        ),
      (error) => error instanceof assert.AssertionError,
      label,
    );
  }
});
