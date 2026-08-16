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
  await runVoxelInsideCameraProbe(async () => {
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
