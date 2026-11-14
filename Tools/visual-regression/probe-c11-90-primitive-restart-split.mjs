#!/usr/bin/env node
/**
 * Historical entry point retained for C11-90 evidence continuity. The Split
 * UI is not an authority on Sandcastle standalone routes, so the implementation
 * now runs strict WebGL2 and WebGPU pages in an isolated Tools-only harness.
 * @purpose Thin retained entry point running the C11-90 primitive-restart WebGL2-vs-WebGPU harness from lib/c11-90-primitive-restart-probe.mjs
 * @status ACTIVE
 *
 */

import {
  OUTER_WATCHDOG_GRACE_MS,
  WATCHDOG_MS,
  assessWatchdogOrdering,
  runPrimitiveRestartProbe,
} from "./lib/c11-90-primitive-restart-probe.mjs";
import { PROBE_EXIT_CODES, ProbeRefusal } from "./lib/probe-refusal.mjs";
import { parseOutputOnlyArgs } from "./lib/probe-runtime.mjs";
import { chromium } from "playwright";

// Usage: PROBE_BASE=http://localhost:8094 node Tools/visual-regression/probe-c11-90-primitive-restart-split.mjs [--output <dir>]
// --output redirects every file the probe writes (frames, run archive, the
// canonical artifact and the write-once first-red) under <dir>, mirroring the
// Tools/visual-regression/output/ layout. An unset PROBE_BASE, or one on port
// 8080, refuses (exit 3) before a browser is launched.
let outputDirectory;
try {
  ({ outputDirectory } = parseOutputOnlyArgs(process.argv.slice(2)));
} catch (error) {
  console.error(`[C11-90] ${error.message}`);
  process.exit(PROBE_EXIT_CODES.ERROR);
}

const outerWatchdogMs = WATCHDOG_MS + OUTER_WATCHDOG_GRACE_MS;
if (!assessWatchdogOrdering(WATCHDOG_MS, outerWatchdogMs)) {
  throw new Error("C11-90 outer watchdog must lose to the artifact watchdog");
}
const watchdog = setTimeout(() => {
  console.error(`[C11-90] outer watchdog exceeded ${outerWatchdogMs} ms`);
  process.exit(2);
}, outerWatchdogMs);

let browser;
try {
  await runPrimitiveRestartProbe(
    async () => {
      browser = await chromium.launch({
        channel: "msedge",
        headless: process.env.PROBE_HEADED !== "1",
        args: [
          "--enable-unsafe-webgpu",
          "--enable-features=Vulkan",
          "--use-vulkan",
        ],
      });
      return browser;
    },
    { outputDirectory },
  );
} catch (error) {
  if (!(error instanceof ProbeRefusal)) {
    throw error;
  }
  console.error(
    `probe-c11-90-primitive-restart-split: REFUSED (${error.reason}) - ${error.message}`,
  );
  process.exitCode = PROBE_EXIT_CODES.REFUSAL;
} finally {
  clearTimeout(watchdog);
  if (browser) {
    await browser.close().catch(() => undefined);
  }
}
