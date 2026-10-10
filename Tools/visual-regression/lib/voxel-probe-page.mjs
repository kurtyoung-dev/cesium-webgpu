// voxel-probe-page.mjs — the one page-opening step the eleven voxel probes share.
//
// @purpose Open the CesiumViewer page of a voxel rig on one backend through the runtime's origin, with its error-type console messages and page errors collected by the kit's attachPageDiagnostics, the WebGPU error gate armed and the viewer's widget chrome stripped by the kit's strip-viewer-widgets (a page with anything left over the canvas is refused), plus the per-page, per-frame and per-capture budgets the voxel probes derive their lifecycle deadline from.
// @status ACTIVE
//
// WHY A FAMILY MODULE. Every voxel probe opens the same viewer page the same
// way before its own in-page setup runs: a viewport, error collection,
// `networkidle` navigation, a wait for `window.viewer`. Eleven private copies
// of that sequence drifted in small ways (one probe added `offline=true`, one
// echoed `PROBE:` console lines, and every copy passed its `{ timeout }` to
// `page.waitForFunction` in the ARGUMENT slot, where Playwright ignores it).
// The pieces of the sequence are the kit's, and this module only fixes the
// order they run in: `Tools/lib/attach-page-diagnostics.mjs` collects the
// console and page errors, `Tools/lib/webgpu-error-gate.mjs` is installed
// before navigation and armed on the viewer's device (which is also what lets
// `captureElement` confirm the device is alive before it banks a frame), and
// `lib/capture.mjs`'s `captureUrlFor` re-bases the rig's page onto the
// runtime's origin. What the kit has no piece for is opening a page for a
// probe's OWN setup: `capture.mjs`'s `defaultCellWork` navigates and
// screenshots a rig but cannot run a setup, and `lib/probe-runtime.mjs` hands
// a probe a browser, not a page. The probes keep only what is genuinely
// theirs: the in-page setup, the measurement and the clauses.
//
// WHAT IT COLLECTS, AND WHAT IT DOES NOT DECIDE. The diagnostics filter keeps
// every `error`-type console message and every uncaught page error, exactly as
// the probes counted them — deliberately wider than `attachConsoleErrorGate`'s
// WebGPU-fault filter, because the probes' "no console errors" clauses were
// stated over all of them. The two streams are merged back into arrival order
// by the kit's `seq`. A page error's text is the error's message (the kit's
// record format; the retired listeners stored `String(error)`, which adds the
// `Error: ` name in front); the clauses read the count. The gate's device
// errors are reported beside them, and whether a probe gates on them is the
// probe's decision.
//
// THE CHROME IS GONE BEFORE ANY FRAME. Every voxel frame is an element
// capture of the widget canvas, and on this page that capture composites the
// DOM stacked inside the canvas's rectangle: the toolbar, the navigation-help
// panel, the animation clock, the timeline and the credits
// (`lib/strip-viewer-widgets.mjs` records the defect). A pixel metric over
// such a frame measures chrome as well as the scene, so once the viewer exists
// the kit's `STRIP_WIDGETS_SOURCE` removes those widgets, and a page with
// anything still over the canvas afterwards is refused (`ProbeRefusal`
// `viewer-chrome-leftover`, exit 3, naming what is left) rather than measured.
// How many widgets were removed is published per page as `chromeRemoved`,
// beside the error counts. The viewer wait also waits for the page's loading
// indicator to be hidden: `Apps/CesiumViewer/CesiumViewer.js` sets
// `window.viewer` before it hides that element, which `CesiumViewer.css`
// centres over the canvas at 66 x 66, and it hides it after the first
// rendered frame or after 10 s (`CesiumViewerLoadingIndicator.js`), so a strip
// taken at the bare viewer wait could find it and refuse a page that was only
// still loading. Three pick probes (pick, refined-pick, cell-pick) draw their
// pick markers after this step, for their banked frames; pick-logdepth draws
// none, and none of the four pick probes scores a pixel.

import { attachPageDiagnostics } from "../../lib/attach-page-diagnostics.mjs";
import {
  armWebGPUDevices,
  collectGateErrors,
  errorGateInit,
} from "../../lib/webgpu-error-gate.mjs";
import { captureUrlFor } from "./capture.mjs";
import { ProbeRefusal } from "./probe-refusal.mjs";
import { STRIP_WIDGETS_SOURCE } from "./strip-viewer-widgets.mjs";

/** The widget canvas: the only element a voxel frame is taken from. */
export const VOXEL_CANVAS_SELECTOR = ".cesium-widget canvas";

/** Playwright's navigation bound, and separately the wait for `window.viewer`. */
export const VOXEL_PAGE_OPEN_BUDGET_MS = 90_000;

/** A slow-frame allowance for each in-page `scene.render()` a probe runs. */
export const VOXEL_FRAME_BUDGET_MS = 250;

/** One element capture, its liveness read and the Node-side decode. */
export const VOXEL_CAPTURE_BUDGET_MS = 15_000;

/** How many widgets the strip removed on each opened page. */
const chromeRemovedByPage = new WeakMap();

/**
 * The work budget of a voxel probe run, from what it does: each page is two
 * bounded waits (navigation and the viewer), each rendered frame gets the
 * slow-frame allowance and each capture its own bound. The runtime adds the
 * preflight, launch and settlement margins on top.
 *
 * @param {{pages: number, frames: number, captures: number}} work
 * @returns {number} Milliseconds.
 */
export function voxelWorkBudgetMs({ pages, frames, captures }) {
  return (
    pages * 2 * VOXEL_PAGE_OPEN_BUDGET_MS +
    frames * VOXEL_FRAME_BUDGET_MS +
    captures * VOXEL_CAPTURE_BUDGET_MS
  );
}

/**
 * The records a voxel probe's error clauses count: every `error`-type console
 * message and every uncaught page error. The filter handed to the kit's
 * `attachPageDiagnostics`.
 *
 * @param {{type: string}} record A kit diagnostics record.
 * @returns {boolean}
 */
export function isVoxelErrorRecord(record) {
  return record.type === "error" || record.type === "pageerror";
}

/**
 * Open a rig's viewer page on one backend.
 *
 * The url is the rig's page re-based onto the runtime's origin by the kit's
 * `captureUrlFor`, with any extra query the probe needs and `renderer` last.
 *
 * @param {object} options
 * @param {object} options.browser The run's browser.
 * @param {string} options.origin The runtime's origin.
 * @param {string} options.renderer `webgl` or `webgpu`.
 * @param {object} options.rig The rig whose page and viewport are opened.
 * @param {Record<string, string>} [options.query] Extra query parameters.
 * @param {string} [options.echoPrefix] Console lines starting with this are
 *   kept too, in a second kit handle (`echo`), for the probe to print.
 * @returns {Promise<{page: object, diagnostics: object, echo: object|null, chromeRemoved: number}>}
 *   `diagnostics` is the kit handle {@link voxelPageErrors} reads;
 *   `chromeRemoved` is how many viewer widgets the strip removed.
 * @throws {ProbeRefusal} `viewer-chrome-leftover` when anything still
 *   overlaps the canvas after the strip.
 */
export async function openVoxelViewer({
  browser,
  origin,
  renderer,
  rig,
  query = {},
  echoPrefix,
}) {
  const page = await browser.newPage({ viewport: { ...rig.viewport } });
  // Attached before navigation: Playwright delivers console and page errors
  // only to listeners already attached when they fire.
  const diagnostics = attachPageDiagnostics(page, {
    filter: isVoxelErrorRecord,
  });
  const echo = echoPrefix
    ? attachPageDiagnostics(page, {
        filter: (record) =>
          record.type !== "pageerror" && record.text.startsWith(echoPrefix),
      })
    : null;
  await page.addInitScript(errorGateInit);
  const url = new URL(captureUrlFor({ rig, origin }));
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("renderer", renderer);
  await page.goto(url.href, {
    waitUntil: "networkidle",
    timeout: VOXEL_PAGE_OPEN_BUDGET_MS,
  });
  await page.waitForFunction(
    () => {
      if (!window.viewer) {
        return false;
      }
      const indicator = document.getElementById("loadingIndicator");
      return !indicator || getComputedStyle(indicator).display === "none";
    },
    null,
    { timeout: VOXEL_PAGE_OPEN_BUDGET_MS },
  );
  const chrome = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);
  if (chrome.leftovers.length > 0) {
    throw new ProbeRefusal(
      "viewer-chrome-leftover",
      `${rig.id} on ${renderer}: ${chrome.leftovers.length} element(s) still ` +
        `overlap the widget canvas after the widget strip ` +
        `(${chrome.leftovers.join(", ")}); a frame captured now would score ` +
        "DOM chrome as well as the scene",
      {
        rig: rig.id,
        renderer,
        removed: chrome.removed,
        leftovers: chrome.leftovers,
      },
    );
  }
  chromeRemovedByPage.set(page, chrome.removed);
  await armWebGPUDevices(page);
  return { page, diagnostics, echo, chromeRemoved: chrome.removed };
}

/**
 * What a page's error sources recorded, and how much viewer chrome was
 * stripped before its first frame, as one object a cell can carry.
 *
 * @param {object} page The page.
 * @param {{console: Array<{text: string, seq: number}>, errors: Array<{text: string, seq: number}>}} diagnostics
 *   The kit handle {@link openVoxelViewer} returned.
 * @returns {Promise<{consoleErrors: string[], deviceErrors: string[], deviceLost: string|null, chromeRemoved: number|null}>}
 *   `consoleErrors` holds the console errors and page errors together, in
 *   the order they arrived; `chromeRemoved` is null for a page that
 *   {@link openVoxelViewer} did not open.
 */
export async function voxelPageErrors(page, diagnostics) {
  const gate = await collectGateErrors(page);
  const records = [...diagnostics.console, ...diagnostics.errors].sort(
    (a, b) => a.seq - b.seq,
  );
  return {
    consoleErrors: records.map((record) => record.text),
    deviceErrors: gate.errors,
    deviceLost: gate.deviceLost,
    chromeRemoved: chromeRemovedByPage.get(page) ?? null,
  };
}

/**
 * Refuse a run whose `--renderer` selection lacks a backend the probe needs.
 * Returns the refusal's arguments rather than throwing, so the caller raises
 * the runtime's own `ProbeRefusal` (one import, one class).
 *
 * @param {string[]} selected The run's renderers.
 * @param {string[]} required The backends the probe measures.
 * @returns {string[]} The missing backends; empty when the run can proceed.
 */
export function missingRenderers(selected, required) {
  return required.filter((renderer) => !selected.includes(renderer));
}
