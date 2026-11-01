// probe-water-cells-wave-epoch.spec.mjs - lane KT-2 (Nardol). Pure Node: no browser, no GPU.
//
// @purpose Asserts the 2g wave-epoch repeat band: ON run 0 against run 1 within its band per renderer, NOT RUN with the readback's reason or an ON page's own reason, asking for --runs 2 or more only when the arm ran one, and judged on AFTER only.
// @status ACTIVE
//
// One subject of the water-cells spec, split out of probe-water-cells.spec.mjs (row DX-KIT-WATER-CELLS-SPEC-OVERSIZE);
// the shared stub browser, run frame and fixtures live in fixtures/probe-water-cells-support.mjs.

import assert from "node:assert/strict";
import test from "node:test";

import {
  descriptor,
  summarizeWaterRecords,
  waterVerdicts,
} from "./probe-water-cells.mjs";
import {
  CLOCK,
  makeStore,
  record,
  near,
  cleanGate,
  verdict,
  verdictsWhere,
  flat,
  moved,
} from "./fixtures/probe-water-cells-support.mjs";

// 2g: the pinned-epoch repeat of each ON rig (A2-1).

const epochApplied = { requested: CLOCK, observed: CLOCK, applied: true };

/** ON pages of a mask cell on both renderers, `images[renderer]` per run. */
function epochRecords(store, cell, images, waveEpoch = () => epochApplied) {
  const out = [];
  for (const [renderer, runs] of Object.entries(images)) {
    runs.forEach((img, run) => {
      out.push(
        record(store, cell, "on", renderer, run, img, {
          gate: cleanGate,
          waterDialsAbsent: [],
          waveEpoch: waveEpoch(renderer, run),
        }),
      );
    });
  }
  return out;
}

function judge2g(cell, images, { arm = "after", waveEpoch } = {}) {
  const store = makeStore();
  const records = epochRecords(store, cell, images, waveEpoch);
  const summary = summarizeWaterRecords(records, {
    loadImage: store.loadImage,
  });
  return {
    summary,
    verdicts: waterVerdicts(records, summary, null, {
      arm,
      loadImage: store.loadImage,
    }),
  };
}

test("V10 (A2-1): 2g passes iff ON run 0 against run 1 at tolerance 16 is at most 0.05 pp, per renderer and rig", () => {
  const twice = (second) => ({
    webgl: [flat(), second],
    webgpu: [flat(), flat()],
  });
  const at = (second) =>
    judge2g("coast-50km", twice(second)).verdicts.filter((v) =>
      v.id.includes(":2g-wave-epoch-repeat:"),
    );
  const five = at(moved(5));
  assert.deepEqual(five.map((v) => v.id).sort(), [
    "coast-50km:2g-wave-epoch-repeat:webgl",
    "coast-50km:2g-wave-epoch-repeat:webgpu",
  ]);
  const gl = five.find((v) => v.renderer === "webgl");
  assert.equal(gl.pass, true, "5 px = 0.05 pp is within");
  near(gl.repeatPct, 0.05, "repeat");
  assert.equal(gl.rig, "water-coast-50km");
  assert.equal(gl.epoch, CLOCK);
  assert.equal(gl.bandPp, 0.05);
  const six = at(moved(6)).find((v) => v.renderer === "webgl");
  assert.equal(six.pass, false, "6 px = 0.06 pp is over");
  assert.equal(six.notRun, undefined, "a measured repeat is not NOT RUN");
  assert.equal(
    at(moved(6)).find((v) => v.renderer === "webgpu").pass,
    true,
    "renderers are judged apart",
  );
  assert.equal(
    at(moved(4000, 16)).find((v) => v.renderer === "webgl").pass,
    true,
    "a tolerance-16 difference is not a difference",
  );
});

test("V10 (A2-1): an epoch that read back applied false makes 2g NOT RUN on that renderer, with the readback's reason", () => {
  const { verdicts } = judge2g(
    "orbit-disc",
    { webgl: [flat(), flat()], webgpu: [flat(), flat()] },
    {
      waveEpoch: (renderer, run) =>
        renderer === "webgpu" && run === 1
          ? {
              requested: CLOCK,
              observed: null,
              applied: false,
              reason: "stub: no handler",
            }
          : epochApplied,
    },
  );
  const gpu = verdict(verdicts, "orbit-disc", ":2g-wave-epoch-repeat:webgpu");
  assert.equal(gpu.pass, false);
  assert.equal(gpu.notRun, true);
  assert.ok(gpu.reason.startsWith("waterSimulationEpoch applied: false"));
  assert.ok(gpu.reason.includes("run1: stub: no handler"), gpu.reason);
  assert.equal(
    verdict(verdicts, "orbit-disc", ":2g-wave-epoch-repeat:webgl").pass,
    true,
  );
  const missing = judge2g(
    "great-lakes",
    { webgl: [flat(), flat()] },
    { waveEpoch: () => undefined },
  ).verdicts.find((v) => v.id.includes(":2g-"));
  assert.equal(missing.notRun, true);
  assert.ok(missing.reason.includes("no wave-epoch readback"), missing.reason);
});

test("V10 (A2-1, A3-2): 2g on a single-run arm is NOT RUN asking for --runs 2 or more, never 'two captured ON runs'", () => {
  const { verdicts } = judge2g("great-lakes", { webgl: [flat()] });
  const gl = verdict(verdicts, "great-lakes", ":2g-wave-epoch-repeat:webgl");
  assert.equal(gl.notRun, true);
  assert.equal(gl.reason, "2g needs --runs 2 or more (this arm ran 1)");
  assert.equal(gl.repeatPct, null);
  const store = makeStore();
  const records = epochRecords(store, "great-lakes", { webgl: [flat()] });
  const declared = verdict(
    waterVerdicts(
      records,
      summarizeWaterRecords(records, { loadImage: store.loadImage }),
      null,
      { arm: "after", runs: 1, loadImage: store.loadImage },
    ),
    "great-lakes",
    ":2g-wave-epoch-repeat:webgl",
  );
  assert.equal(declared.reason, "2g needs --runs 2 or more (this arm ran 1)");
});

// A3-2 (N8): 2g names the cause that kept it from being measured.

/** The 2g verdict on WebGL for ON pages built by `pages(store)`. */
function judge2gPages(pages, runs) {
  const store = makeStore();
  const records = pages(store);
  const verdicts = waterVerdicts(
    records,
    summarizeWaterRecords(records, { loadImage: store.loadImage }),
    null,
    { arm: "after", runs, loadImage: store.loadImage },
  );
  return verdict(verdicts, "coast-50km", ":2g-wave-epoch-repeat:webgl");
}

const onPage = (store, run, extra) =>
  record(store, "coast-50km", "on", "webgl", run, flat(), {
    gate: cleanGate,
    waterDialsAbsent: [],
    waveEpoch: epochApplied,
    ...extra,
  });

test("V13 (A3-2): an ON page NOT RUN for another reason makes 2g NOT RUN with that page's own reason, not the run count", () => {
  const unsettled = "the scene did not settle (stub)";
  const chrome =
    "capture-chrome-over-canvas: water-coast-50km: stub chrome left over the canvas";
  for (const reason of [unsettled, chrome]) {
    const g = judge2gPages(
      (store) => [
        onPage(store, 0),
        { ...onPage(store, 1), capture: undefined, notRun: reason },
      ],
      2,
    );
    assert.equal(g.notRun, true);
    assert.equal(g.pass, false);
    assert.equal(g.reason, `ON page NOT RUN (run1: ${reason})`);
    assert.ok(!g.reason.includes("--runs"), g.reason);
  }
});

test("V13 (A3-2): a page refused before staging reads 'page refused before staging', not 'no wave-epoch readback'", () => {
  const g = judge2gPages(
    (store) => [
      onPage(store, 0),
      {
        ...onPage(store, 1),
        capture: undefined,
        waveEpoch: undefined,
        notRun: "stub-refusal: refused before the stage ran",
      },
    ],
    2,
  );
  assert.equal(g.notRun, true);
  assert.equal(
    g.reason,
    "page refused before staging (run1: stub-refusal: refused before the stage ran)",
  );
  assert.ok(!g.reason.includes("no wave-epoch readback"), g.reason);
  assert.ok(!g.reason.includes("applied: false"), g.reason);
});

test("V13 (A3-2): 'two captured ON runs' appears only when --runs >= 2 was given and fewer than two ON runs were captured", () => {
  const short = judge2gPages((store) => [onPage(store, 0)], 2);
  assert.equal(short.notRun, true);
  assert.equal(
    short.reason,
    "2g needs two captured ON runs at the pinned epoch (--runs 2, 1 captured)",
  );
  const single = judge2gPages((store) => [onPage(store, 0)], 1);
  assert.ok(!single.reason.includes("two captured ON runs"), single.reason);
  const measured = judge2gPages(
    (store) => [onPage(store, 0), onPage(store, 1)],
    2,
  );
  assert.equal(measured.pass, true);
  assert.equal(measured.reason, undefined);
  // The descriptor hands the arm's --runs to the verdicts.
  const one = [onPage(makeStore(), 0)];
  const through = (runs) =>
    verdict(
      descriptor.verdicts(one, { options: { arm: "after", runs } }),
      "coast-50km",
      ":2g-wave-epoch-repeat:webgl",
    ).reason;
  assert.equal(
    through(2),
    "2g needs two captured ON runs at the pinned epoch (--runs 2, 1 captured)",
  );
  assert.equal(through(1), "2g needs --runs 2 or more (this arm ran 1)");
});

test("V10 (A2-1): 2g is judged on AFTER only, and never on the lake-only cell", () => {
  const images = { webgl: [flat(), moved(500)], webgpu: [flat(), flat()] };
  assert.equal(
    verdictsWhere(
      judge2g("coast-50km", images, { arm: "before" }).verdicts,
      "coast-50km",
      ":2g-",
    ).length,
    0,
  );
  const lakeonly = judge2g("great-lakes-lakeonly", images);
  assert.equal(
    verdictsWhere(lakeonly.verdicts, "great-lakes-lakeonly", ":2g-").length,
    0,
  );
  assert.equal(
    lakeonly.summary["great-lakes-lakeonly"].waveEpochRepeat,
    undefined,
  );
});
