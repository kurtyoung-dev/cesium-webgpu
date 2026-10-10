// voxel-probe-routing.spec.mjs — the voxel family's migration onto the runtime.
// Pure Node: no browser, no network, no GPU.
//
// @purpose Drives the eleven migrated voxel probes through runProbe against a stub browser, so each is known to take its origin from the runtime, open every page in one order (error gate installed, viewer and loading indicator waited for with a real timeout, widget chrome stripped, device armed) before any capture, capture only the widget canvas under its banked frame names, reach a receipt with every clause green on a passing fixture, carry exit 1 on a failing one, refuse a run missing a backend it measures or a page with anything left over the canvas, count every injected console, page and gate error in its error clauses, and fail closed on corner or far frames that cannot be compared.
// @status ACTIVE
//
// WHAT THIS CHECKS AND WHAT IT CANNOT. `probe-fleet-contract.spec.mjs` asks
// whether a probe has a watchdog, `runtime-residency-contract.spec.mjs` whether
// it re-rolls something the runtime owns; both stay green over a descriptor
// whose Node half throws on its first line. So this file runs the real
// descriptors, the way `cloud-demo-probe-routing.spec.mjs` runs the cloud
// family: `runProbe`'s `launch` seam hands each one a stub browser whose page
// answers every `page.evaluate` by the text of the function it was handed and
// whose element screenshots are synthetic PNGs built for that probe's
// measurements. Argv, lifecycle, Edge slot, cells, the Node-side metrics,
// verdicts, receipt and exit code all run for real.
//
// The in-page halves do NOT run: every answer the stub gives
// (`fixtures/voxel-probe-routing/stub-browser.mjs`) is a fixture chosen to put
// each clause on a known side of its bar, so no number here is evidence about
// the renderer. The equivalence leg — each migrated probe against its
// pre-migration run on one served tree — is an Edge measurement and is owed by
// the wave's Edge job, not claimed here. An in-page callback the stub does not
// recognise throws, so a probe that grows a new one fails here loudly rather
// than being answered with the wrong shape.
//
// THE ERROR PATH IS DRIVEN, NOT ASSUMED. Every error clause of the eleven
// probes depends on one path: the kit's `attachPageDiagnostics` listeners
// (attached by `lib/voxel-probe-page.mjs`), the WebGPU gate armed on the page
// and read back. So the stub page keeps the listeners it is given and delivers
// console messages and page errors to them on navigation, and its gate reports
// a device error only on a page that was armed. A8 injects one fault per run
// and requires exactly the probe's error clauses red; with the collection, the
// arming or the read-back made inert, A8 goes red.
//
// THE CHROME STRIP IS DRIVEN TOO. An element capture of the viewer canvas
// composites the widgets stacked over it (`lib/strip-viewer-widgets.mjs`), so
// every page is opened through the kit's strip before its first frame. The
// stub page answers the strip and records, per page, the calls the open
// sequence and the captures make, in order: A2 requires the gate installed
// before navigation, a viewer wait that carries its timeout in the options
// slot and also waits for the loading indicator, then the strip, then the
// arming, and no frame before the strip; every page's `chromeRemoved` reaches
// the receipt. A12 leaves an element over the canvas and requires a refusal
// that names it, before any frame of that backend.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { removeLaneTmp } from "../lib/lane-tmp.mjs";
import { errorGateInit } from "../lib/webgpu-error-gate.mjs";
import {
  BENIGN_WARNING,
  ECHO_LINE,
  INJECTED_DEVICE_ERROR,
  LEFTOVER_OVERLAY,
  PROBES,
  STRIPPED_WIDGETS,
  drive,
  readReport,
  redIds,
} from "./fixtures/voxel-probe-routing/stub-browser.mjs";
import { PROBE_EXIT_CODES } from "./lib/probe-runtime.mjs";
import { loadRigs } from "./lib/rig-registry.mjs";
import { VOXEL_PAGE_OPEN_BUDGET_MS } from "./lib/voxel-probe-page.mjs";
import { descriptor as megatexture } from "./probe-voxel-megatexture.mjs";
import { descriptor as octreeL3plus } from "./probe-voxel-octree-l3plus.mjs";
import { descriptor as octree } from "./probe-voxel-octree.mjs";

// ===========================================================================

test("A1: every migrated voxel probe reaches a receipt with every clause green on its passing fixture", async () => {
  for (const entry of PROBES) {
    const { code, root, out, log } = await drive(entry);
    try {
      const written = readdirSync(out).sort();
      const report = JSON.parse(
        readFileSync(
          path.join(out, `${entry.descriptor.name}-report.json`),
          "utf8",
        ),
      );
      const red = report.verdicts.filter((verdict) => verdict.pass !== true);
      assert.deepEqual(
        red.map((verdict) => verdict.id),
        [],
        `${entry.file}: red on the passing fixture`,
      );
      assert.equal(code, PROBE_EXIT_CODES.OK, `${entry.file}: exit code`);
      assert.ok(report.verdicts.length > 0, `${entry.file}: no verdicts`);
      // The banked frame names are the pre-migration file names, one per
      // capture, directly under the output directory.
      assert.deepEqual(
        written,
        [
          ...entry.captures.map((name) => `${name}.png`),
          `${entry.descriptor.name}-report.json`,
          `${entry.descriptor.name}-summary.md`,
        ].sort(),
        `${entry.file}: artifacts`,
      );
      assert.equal(log.launches, 1, `${entry.file}: one browser per run`);
      assert.equal(log.closes, 1, `${entry.file}: the browser was closed`);
    } finally {
      removeLaneTmp(root);
    }
  }
});

test("A2: every navigation is the rig's viewer page on the runtime's origin, every page is opened in one order with its chrome stripped before any frame, and every frame is the widget canvas", async () => {
  for (const entry of PROBES) {
    const { root, out, log } = await drive(entry);
    try {
      assert.ok(log.pages.length > 0, `${entry.file}: opened no page`);
      for (const events of log.pages) {
        // The open sequence, in order: the gate installed before navigation,
        // the viewer wait (timeout in the OPTIONS slot, not the argument
        // slot, and the loading indicator waited for), the strip, the arming.
        assert.deepEqual(
          events.slice(0, 5).map((event) => event.kind),
          ["init", "goto", "wait", "strip", "arm"],
          `${entry.file}: open sequence`,
        );
        assert.equal(events[0].script, errorGateInit, entry.file);
        const wait = events[2];
        assert.equal(wait.arg, null, `${entry.file}: wait argument`);
        assert.deepEqual(
          wait.options,
          { timeout: VOXEL_PAGE_OPEN_BUDGET_MS },
          `${entry.file}: wait options`,
        );
        assert.ok(
          wait.source.includes("window.viewer") &&
            wait.source.includes("loadingIndicator"),
          `${entry.file}: wait predicate`,
        );
        // One strip per page, before the page's first frame.
        const kinds = events.map((event) => event.kind);
        assert.equal(kinds.filter((kind) => kind === "strip").length, 1);
        assert.ok(
          kinds.indexOf("shot") === -1 ||
            kinds.indexOf("shot") > kinds.indexOf("strip"),
          `${entry.file}: a frame before the strip`,
        );
      }
      // Every opened page publishes what the strip removed.
      const published =
        JSON.stringify(readReport(out, entry).cells).split(
          `"chromeRemoved":${STRIPPED_WIDGETS}`,
        ).length - 1;
      assert.equal(published, log.pages.length, `${entry.file}: chromeRemoved`);
      assert.ok(log.gotos.length > 0, `${entry.file}: never navigated`);
      for (const url of log.gotos) {
        const parsed = new URL(url);
        assert.equal(parsed.origin, "http://localhost:8137", entry.file);
        assert.equal(parsed.pathname, "/Apps/CesiumViewer/index.html");
        assert.ok(
          entry.renderers.includes(parsed.searchParams.get("renderer")),
        );
      }
      assert.deepEqual(
        [...new Set(log.selectors)],
        [".cesium-widget canvas"],
        `${entry.file}: captured something other than the widget canvas`,
      );
      for (const viewport of log.viewports) {
        assert.deepEqual(viewport, { width: 1024, height: 768 }, entry.file);
      }
    } finally {
      removeLaneTmp(root);
    }
  }
});

test("A3: a failing fixture carries exit 1 and names the clause it broke", async () => {
  for (const entry of PROBES) {
    const { code, root, out } = await drive(entry, { fail: true });
    try {
      assert.equal(code, PROBE_EXIT_CODES.FAILURE, `${entry.file}: exit code`);
      const report = JSON.parse(
        readFileSync(
          path.join(out, `${entry.descriptor.name}-report.json`),
          "utf8",
        ),
      );
      const red = report.verdicts
        .filter((verdict) => verdict.pass !== true)
        .map((verdict) => verdict.id);
      assert.ok(
        red.includes(entry.failing),
        `${entry.file}: expected ${entry.failing} red, got ${JSON.stringify(red)}`,
      );
    } finally {
      removeLaneTmp(root);
    }
  }
});

test("A4: a run without a backend the probe measures refuses (exit 3) and writes no receipt", async () => {
  for (const entry of PROBES) {
    const missing = entry.renderers.includes("webgl") ? "webgpu" : "webgl";
    const { code, root, out } = await drive(entry, {
      argv: ["--renderer", missing],
    });
    try {
      assert.equal(code, PROBE_EXIT_CODES.REFUSAL, `${entry.file}: exit code`);
      assert.deepEqual(
        readdirSync(out).filter((name) => name.endsWith("-report.json")),
        [],
        `${entry.file}: a refused run published a receipt`,
      );
    } finally {
      removeLaneTmp(root);
    }
  }
});

test("A5: every descriptor's work budget is finite, positive and grows with the renderers it runs", () => {
  for (const entry of PROBES) {
    const both = entry.descriptor.workBudgetMs({
      renderers: ["webgl", "webgpu"],
    });
    assert.ok(Number.isSafeInteger(both) && both > 0, entry.file);
    const one = entry.descriptor.workBudgetMs({ renderers: ["webgpu"] });
    assert.ok(one > 0 && one <= both, entry.file);
    assert.deepEqual(
      entry.descriptor.servedArtifacts,
      ["Build/CesiumUnminified/index.js"],
      entry.file,
    );
    assert.equal(entry.descriptor.receiptEnvelope, "runtime", entry.file);
  }
});

test("A6 MUTATION control: a verdict function that cannot fail reports GREEN on every failing fixture", async () => {
  // A3 is only evidence if the red comes from the probe's own clauses. Swap
  // each descriptor's verdicts for one that passes everything, keep the
  // failing fixture, and the run must come back GREEN — so A3's exit 1 is the
  // verdict function's doing, not the stub's.
  for (const entry of PROBES) {
    const inert = {
      ...entry.descriptor,
      verdicts: (cells) =>
        entry.descriptor
          .verdicts(cells)
          .map((verdict) => ({ ...verdict, pass: true })),
    };
    const { code, root } = await drive(entry, {
      fail: true,
      descriptor: inert,
    });
    try {
      assert.equal(code, PROBE_EXIT_CODES.OK, entry.file);
    } finally {
      removeLaneTmp(root);
    }
  }
});

test("A7: every voxel rig's camera is a unit-direction pose looking at the origin", async () => {
  const rigs = (await loadRigs()).filter((rig) => rig.tags.includes("voxel"));
  assert.equal(rigs.length, 21, "the voxel rig census moved");
  const length = (v) => Math.hypot(v[0], v[1], v[2]);
  for (const rig of rigs) {
    const { position, direction, up } = rig.camera;
    assert.ok(Math.abs(length(direction) - 1) < 1e-12, `${rig.id}: direction`);
    assert.ok(Math.abs(length(up) - 1) < 1e-12, `${rig.id}: up`);
    // `up` is NOT required to be orthogonal to `direction`: the off-axis and
    // oblique poses keep the +Z up the pre-migration probes passed with them.
    // Every voxel scene is centred on the ECEF origin, so every pose looks at
    // it: the direction is the normalised negated position, to the last bit
    // for the off-axis and oblique poses the probes used to derive in-page.
    const toward = position.map((c) => -c / length(position));
    for (let i = 0; i < 3; i++) {
      assert.ok(
        Math.abs(direction[i] - toward[i]) < 1e-12,
        `${rig.id}: does not look at the origin`,
      );
    }
    assert.deepEqual(rig.viewport, { width: 1024, height: 768 }, rig.id);
  }
});

test("A8: one console error, page error or gate error on a backend's pages turns exactly that probe's error clauses red", async () => {
  for (const entry of PROBES) {
    for (const kind of ["console", "pageerror"]) {
      for (const renderer of entry.renderers) {
        const { code, root, out } = await drive(entry, {
          inject: { kind, renderer },
        });
        try {
          assert.deepEqual(
            redIds(readReport(out, entry)),
            [...entry.errorClauses].sort(),
            `${entry.file}: a ${kind} error on ${renderer}`,
          );
          assert.equal(code, PROBE_EXIT_CODES.FAILURE, entry.file);
        } finally {
          removeLaneTmp(root);
        }
      }
    }
    // The gate's device errors: red in the probes whose clause counts them,
    // and published in the receipt (ungated) by every probe.
    const { code, root, out } = await drive(entry, {
      inject: { kind: "device", renderer: "webgpu" },
    });
    try {
      const report = readReport(out, entry);
      assert.deepEqual(
        redIds(report),
        [...entry.deviceClauses].sort(),
        `${entry.file}: a device error on webgpu`,
      );
      assert.equal(
        code,
        entry.deviceClauses.length > 0
          ? PROBE_EXIT_CODES.FAILURE
          : PROBE_EXIT_CODES.OK,
        entry.file,
      );
      assert.ok(
        JSON.stringify(report).includes(INJECTED_DEVICE_ERROR),
        `${entry.file}: the device error is missing from the receipt`,
      );
    } finally {
      removeLaneTmp(root);
    }
  }
});

test("A9: corner A frames of different sizes are no match, so megatexture's reupload evidence is red", async () => {
  const entry = PROBES.find(
    (candidate) => candidate.descriptor === megatexture,
  );
  const { code, root, out } = await drive(entry, { resizeA2: true });
  try {
    const report = readReport(out, entry);
    assert.deepEqual(redIds(report), ["part3/reupload-evidence/run0"]);
    assert.equal(code, PROBE_EXIT_CODES.FAILURE);
    const verdict = report.verdicts.find(
      (candidate) => candidate.id === "part3/reupload-evidence/run0",
    );
    assert.equal(verdict.detail.diffA.comparable, false);
    assert.equal(verdict.detail.pixelsMatch, false);
    assert.ok(
      verdict.detail.failures.includes(
        "restored A frame does not reproduce the first A frame",
      ),
      JSON.stringify(verdict.detail.failures),
    );
  } finally {
    removeLaneTmp(root);
  }
});

test("A10: only the megatexture probe echoes its page's PROBE: trace, once per echoing page, and no probe prints a console warning", async () => {
  for (const entry of PROBES) {
    const { root, log } = await drive(entry);
    try {
      const echoed = log.printed.filter((line) => line === ECHO_LINE).length;
      // PART 1 is the one page opened with the echo prefix.
      assert.equal(
        echoed,
        entry.descriptor === megatexture ? 1 : 0,
        entry.file,
      );
      assert.ok(
        !log.printed.some((line) => line.includes(BENIGN_WARNING)),
        entry.file,
      );
    } finally {
      removeLaneTmp(root);
    }
  }
});

test("A11: far frames of different sizes are no measurement, so each octree probe's far-view clause is red", async () => {
  // Both far frames are black; WebGPU's is one row taller, then one row
  // shorter. Scored over the shorter of two misaligned value lists either
  // pair read 0 and passed; both must fail, and only that clause may.
  for (const descriptor of [octree, octreeL3plus]) {
    const entry = PROBES.find(
      (candidate) => candidate.descriptor === descriptor,
    );
    for (const resizeFar of [1, -1]) {
      const { code, root, out } = await drive(entry, { resizeFar });
      try {
        const report = readReport(out, entry);
        const what = `${entry.file}, WebGPU far ${resizeFar} row(s)`;
        assert.deepEqual(redIds(report), ["far-diff/run0"], what);
        assert.equal(code, PROBE_EXIT_CODES.FAILURE, what);
        const verdict = report.verdicts.find(
          (candidate) => candidate.id === "far-diff/run0",
        );
        // NaN in the cell; a JSON receipt prints it as null.
        assert.equal(verdict.detail.farDiff, null, what);
        assert.ok(verdict.claim.includes("NaN"), verdict.claim);
      } finally {
        removeLaneTmp(root);
      }
    }
  }
});

test("A12: a page with anything left over the canvas after the widget strip refuses (exit 3) before any frame of that backend, and names what is left", async () => {
  for (const entry of PROBES) {
    for (const renderer of entry.renderers) {
      const { code, root, out, log } = await drive(entry, {
        leftover: { renderer },
      });
      try {
        assert.equal(
          code,
          PROBE_EXIT_CODES.REFUSAL,
          `${entry.file} on ${renderer}`,
        );
        assert.equal(
          existsSync(path.join(out, `${entry.descriptor.name}-report.json`)),
          false,
          `${entry.file}: a refused run published a receipt`,
        );
        const incident = JSON.parse(
          readFileSync(
            path.join(out, `${entry.descriptor.name}-refusal.json`),
            "utf8",
          ),
        );
        assert.equal(incident.refusal.reason, "viewer-chrome-leftover");
        assert.deepEqual(incident.refusal.details.leftovers, [
          LEFTOVER_OVERLAY,
        ]);
        assert.equal(incident.refusal.details.renderer, renderer);
        assert.ok(incident.refusal.message.includes(LEFTOVER_OVERLAY));
        // The refusing page took no frame, and no page opened after it.
        const refused = log.pages.at(-1);
        assert.deepEqual(
          refused.map((event) => event.kind),
          ["init", "goto", "wait", "strip"],
          entry.file,
        );
        assert.equal(log.closes, 1, `${entry.file}: the browser was closed`);
      } finally {
        removeLaneTmp(root);
      }
    }
  }
});
