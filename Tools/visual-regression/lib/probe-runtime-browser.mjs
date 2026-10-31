// probe-runtime-browser.mjs — launching Edge and installing the Sandcastle2 origin rewrite for the probe runtime.
//
// @purpose Companion of probe-runtime.mjs: EDGE_LAUNCH_ARGS (the one launch flag the fleet shares), launchEdge (Edge per run through Playwright's msedge channel) and installSandcastle2OriginRewrite (the lazily imported origin rewrite for probes that open the built app).
// @status ACTIVE
//
// WHY A PIECE. The browser-facing half of the runtime moved out of
// `probe-runtime.mjs` when that module passed 1,000 lines
// (DX-KIT-DECOMPOSE-RUNTIME-WATER). The runtime re-exports all three names, so
// no importer changed; `runProbe` still takes `launch` through its injection
// seam and defaults it to the `launchEdge` exported here.

import { computeSandcastle2Origins } from "./sandcastle2-origin-rewrite.mjs";

/**
 * The Edge flag the fleet actually shares, and the ONLY one the runtime adds
 * on its own.
 *
 * A census of the 647 top-level probes taken while writing this module: 562
 * pass `--enable-unsafe-webgpu`, 210 pass `--use-vulkan`, and exactly one
 * (`probe-aec-perf.mjs`) passes `--enable-precise-memory-info`. A runtime
 * that quietly handed all four to every migrated probe would be changing the
 * measurement conditions of 437 probes that have never run under Vulkan and
 * 646 that have never run with un-bucketed `performance.memory` — and it
 * would do it invisibly, because a launch flag leaves no trace in a receipt.
 * Both of those flags are measurement-affecting here specifically:
 * `--use-vulkan` moves ANGLE and Dawn off the Windows D3D default, which is
 * pipeline-compile behaviour, and pipeline-compile counters are precisely what
 * the cold-start probe publishes; `--enable-precise-memory-info` un-buckets
 * `usedJSHeapSize`, which the cold-start harness reads and the probe reports
 * per cell.
 *
 * So the default is the common denominator and nothing more. A probe that
 * genuinely needs others declares `descriptor.launchArgs`, which puts the
 * change in the probe, in review, and in the runtime receipt.
 */
export const EDGE_LAUNCH_ARGS = Object.freeze(["--enable-unsafe-webgpu"]);

/**
 * Launch Edge. Channel `msedge` is not a preference: Playwright's bundled
 * Firefox is Nightly and has no WebGPU, so a Firefox run measures WebGL twice.
 *
 * @param {object} options Options.
 * @param {boolean} options.headed Whether to show the browser.
 * @param {string[]} [options.launchArgs] Flags to pass instead of {@link EDGE_LAUNCH_ARGS}.
 * @param {object} [options.chromium] Playwright's chromium namespace; imported lazily when absent.
 * @returns {Promise<object>} The launched browser.
 */
export async function launchEdge({ headed, launchArgs, chromium }) {
  const impl = chromium ?? (await import("playwright")).chromium;
  return impl.launch({
    channel: "msedge",
    headless: !headed,
    args: [...(launchArgs ?? EDGE_LAUNCH_ARGS)],
  });
}

/**
 * Install the Sandcastle2 origin rewrite on a context or page, for probes that
 * open the built app. Lazily imported so probes that never touch Sandcastle2
 * do not pay for it.
 *
 * @param {{route: Function}} contextOrPage A Playwright context or page.
 * @param {object} options Options.
 * @param {number|string} options.servedPort Port the app is served on.
 * @param {number|string} options.bucketPort Port the run/bucket frame is served on.
 * @returns {Promise<object>} The computed origins.
 */
export async function installSandcastle2OriginRewrite(
  contextOrPage,
  { servedPort, bucketPort },
) {
  const origins = computeSandcastle2Origins({ servedPort, bucketPort });
  const { installOriginRewrite } =
    await import("./sandcastle2-origin-rewrite.mjs");
  await installOriginRewrite(contextOrPage, origins);
  return origins;
}
