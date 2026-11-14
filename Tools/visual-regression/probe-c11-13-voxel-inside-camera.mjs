#!/usr/bin/env node
// @purpose Thin entry point running the shared C11-13 voxel camera-inside-volume probe from lib/, with an outer watchdog ordered to lose to the inner.
// @status ACTIVE

import { chromium } from "playwright";

import {
  OUTER_WATCHDOG_GRACE_MS,
  WATCHDOG_MS,
  assessWatchdogOrdering,
  runVoxelInsideCameraProbe,
} from "./lib/c11-13-voxel-inside-camera-probe.mjs";
import { PROBE_EXIT_CODES, ProbeRefusal } from "./lib/probe-refusal.mjs";
import { parseOutputOnlyArgs } from "./lib/probe-runtime.mjs";

// Usage: PROBE_BASE=http://localhost:8094 node Tools/visual-regression/probe-c11-13-voxel-inside-camera.mjs [--output <dir>]
// --output redirects every file the probe writes (frames, run archive, the
// canonical artifact and the write-once first-red) under <dir>, mirroring the
// Tools/visual-regression/output/ layout. An unset PROBE_BASE, or one on port
// 8080, refuses (exit 3) before a browser is launched.
let outputDirectory;
try {
  ({ outputDirectory } = parseOutputOnlyArgs(process.argv.slice(2)));
} catch (error) {
  console.error(`[C11-13] ${error.message}`);
  process.exit(PROBE_EXIT_CODES.ERROR);
}

const outerWatchdogMs = WATCHDOG_MS + OUTER_WATCHDOG_GRACE_MS;
if (!assessWatchdogOrdering(WATCHDOG_MS, outerWatchdogMs)) {
  throw new Error("C11-13 outer watchdog must lose to the artifact watchdog");
}
const watchdog = setTimeout(() => {
  console.error(`[C11-13] outer watchdog exceeded ${outerWatchdogMs} ms`);
  process.exit(2);
}, outerWatchdogMs);

let browser;
try {
  await runVoxelInsideCameraProbe(
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
    `probe-c11-13-voxel-inside-camera: REFUSED (${error.reason}) - ${error.message}`,
  );
  process.exitCode = PROBE_EXIT_CODES.REFUSAL;
} finally {
  clearTimeout(watchdog);
  if (browser) {
    await browser.close().catch(() => undefined);
  }
}
