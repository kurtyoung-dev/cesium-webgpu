/**
 * Self-test for the shared WebGPU error/crash gate (Tools/lib/webgpu-error-gate.mjs).
 *
 * Proves the gate actually does its job — the whole point is that it would have
 * caught FORK-34. Three checks, all in one headless Edge session:
 *
 *   1. CLEAN — arm a fresh device, do only valid work → gate stays empty.
 *   2. FAULT — inject a guaranteed uncaptured validation error
 *      (queue.writeBuffer past the buffer end) → gate.errors grows.
 *   3. TEARDOWN — device.destroy() resolves device.lost with reason
 *      "destroyed"; the gate must IGNORE that (normal teardown, not a crash).
 *
 * Exit 0 = all three behave; 1 = the gate is broken; 2 = environment (no WebGPU).
 *
 * Usage: node Tools/visual-regression/probe-error-gate-selftest.mjs
 *   PROBE_BASE (default http://localhost:8134) only needs to serve any page so
 *   the browser has a navigator.gpu context.
 */
import { chromium } from "playwright";
import { errorGateInit, collectGateErrors } from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage();
await page.addInitScript(errorGateInit);
await page.goto(`${BASE}/Apps/CesiumViewer/index.html`, {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});

// 1 + 2: arm a fresh standalone device, run clean work, snapshot, then inject a
// fault and snapshot again.
const result = await page.evaluate(async () => {
  if (!navigator.gpu) {
    return { noGpu: true };
  }
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  window.__armWebGPUDevice(device, "selftest");

  // CLEAN: a valid buffer + valid write.
  const buf = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  device.queue.writeBuffer(buf, 0, new Uint8Array(64));
  await device.queue.onSubmittedWorkDone();
  await new Promise((r) => setTimeout(r, 100));
  const cleanCount = window.__webgpuGate.errors.length;

  // FAULT: write 256 bytes into the 64-byte buffer → uncaptured validation
  // error → onuncapturederror must fire.
  device.queue.writeBuffer(buf, 0, new Uint8Array(256));
  await new Promise((r) => setTimeout(r, 200));
  const faultCount = window.__webgpuGate.errors.length;
  const faultMsg =
    window.__webgpuGate.errors[window.__webgpuGate.errors.length - 1] || null;

  // TEARDOWN: destroy() → device.lost reason "destroyed" → must be ignored.
  device.destroy();
  await new Promise((r) => setTimeout(r, 200));
  const deviceLost = window.__webgpuGate.deviceLost;

  return { cleanCount, faultCount, faultMsg, deviceLost };
});

if (result.noGpu) {
  console.log("SKIP — navigator.gpu unavailable in this browser context");
  await browser.close();
  process.exit(2);
}

const gate = await collectGateErrors(page);
await browser.close();

const checks = [
  { name: "clean run produced no gate errors", pass: result.cleanCount === 0 },
  {
    name: "injected fault was caught",
    pass: result.faultCount > result.cleanCount && !!result.faultMsg,
  },
  {
    name: "device.destroy() teardown NOT flagged as a crash",
    pass: result.deviceLost === null,
  },
];

console.log("=== webgpu-error-gate self-test ===");
for (const c of checks) {
  console.log(`  ${c.pass ? "PASS" : "FAIL"} — ${c.name}`);
}
console.log(`  caught fault message: ${result.faultMsg}`);
console.log(
  `  final gate snapshot: errors=${gate.errors.length} deviceLost=${gate.deviceLost ? "YES" : "no"} armed=${gate.armedDevices}`,
);

const allPass = checks.every((c) => c.pass);
console.log(
  allPass ? "\nALL PASS — gate is functional" : "\nFAILED — gate is broken",
);
process.exit(allPass ? 0 : 1);
