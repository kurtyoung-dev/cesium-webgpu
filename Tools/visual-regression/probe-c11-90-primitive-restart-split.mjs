#!/usr/bin/env node
/**
 * Historical entry point retained for C11-90 evidence continuity. The Split
 * UI is not an authority on Sandcastle standalone routes, so the implementation
 * now runs strict WebGL2 and WebGPU pages in an isolated Tools-only harness.
 */

import {
  OUTER_WATCHDOG_GRACE_MS,
  WATCHDOG_MS,
  assessWatchdogOrdering,
  runPrimitiveRestartProbe,
} from "./lib/c11-90-primitive-restart-probe.mjs";
import { chromium } from "playwright";

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
  await runPrimitiveRestartProbe(async () => {
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
  });
} finally {
  clearTimeout(watchdog);
  if (browser) {
    await browser.close().catch(() => undefined);
  }
}
