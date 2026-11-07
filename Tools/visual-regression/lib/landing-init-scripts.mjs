/**
 * The page init scripts a landing cell's page needs, installed in one place,
 * and the records the opt-in ones leave to read back.
 * @purpose Installs the init scripts a landing cell's page runs before any page script (the WebGPU error gate, the GPU device census, the cloud probe harness, and for a cell that opts in the bind-group-layout census, the default-limits device dial and the engine engagement flags) and reads the opt-in records back (readCellInitRecords), installs and reads the --readers page readers (installReaderInitScripts, readReaderRecords), so the probe holds no per-script branching and a cell without an opt-in field installs no new script and gets no new record field.
 * @status ACTIVE
 *
 * OPT-INS ARE CELL TABLE FIELDS. `layoutCensus` (a non-empty list of bind
 * group layout labels) installs `lib/bind-group-layout-census.mjs`;
 * `deviceLimits: "webgpu-default"` installs `lib/device-limits-dial.mjs`. Both
 * go in front of the page's own scripts, because a layout created or a device
 * requested before the script ran would be invisible to it.
 *
 * @module Tools/visual-regression/lib/landing-init-scripts
 */

import { errorGateInit } from "../../lib/webgpu-error-gate.mjs";
import {
  BIND_GROUP_LAYOUT_CENSUS_INIT_SOURCE,
  readBindGroupLayoutCensus,
} from "./bind-group-layout-census.mjs";
import { installCloudProbeHarness } from "./cloud-probe-harness.mjs";
import {
  DEVICE_LIMITS_DIAL_INIT_SOURCE,
  DEVICE_LIMITS_MODE,
  readDeviceLimits,
} from "./device-limits-dial.mjs";
import {
  readCloudEngagement,
  wantsEngagement,
} from "./cloud-engagement-read.mjs";
import { GPU_DEVICE_CENSUS_INIT_SOURCE } from "./gpu-device-census.mjs";
import {
  readCaptureReaders,
  readerInitSources,
  readersOf,
} from "./landing-page-readers.mjs";

/**
 * Whether a cell asks for the layout census.
 *
 * @param {object} cell A landing cell table entry.
 * @returns {boolean}
 */
export function wantsLayoutCensus(cell) {
  return Array.isArray(cell?.layoutCensus) && cell.layoutCensus.length > 0;
}

/**
 * Whether a cell asks for the default-limits device.
 *
 * @param {object} cell A landing cell table entry.
 * @returns {boolean}
 */
export function wantsDefaultLimits(cell) {
  return cell?.deviceLimits === DEVICE_LIMITS_MODE;
}

/**
 * Install what a cell's page needs, before the page loads: the always-on
 * scripts, then the opt-in ones. The identity cell's window.onmessage sentinel
 * stays with the probe, which also reads it.
 *
 * @param {object} page A Playwright page.
 * @param {object} cell A landing cell table entry.
 * @returns {Promise<void>}
 */
export async function installLandingInitScripts(page, cell) {
  await page.addInitScript(errorGateInit);
  await page.addInitScript({ content: GPU_DEVICE_CENSUS_INIT_SOURCE });
  await page.addInitScript(installCloudProbeHarness);
  if (wantsLayoutCensus(cell)) {
    await page.addInitScript({ content: BIND_GROUP_LAYOUT_CENSUS_INIT_SOURCE });
  }
  if (wantsDefaultLimits(cell)) {
    await page.addInitScript({ content: DEVICE_LIMITS_DIAL_INIT_SOURCE });
  }
}

/**
 * Install what the opt-in page readers (`--readers`, `lib/landing-page-readers.mjs`)
 * need before the page loads. With no reader named nothing is installed.
 *
 * @param {object} page A Playwright page.
 * @param {{readers?: string}} [options] The probe options.
 * @returns {Promise<void>}
 */
export async function installReaderInitScripts(page, options = {}) {
  for (const content of readerInitSources(readersOf(options))) {
    await page.addInitScript({ content });
  }
}

/**
 * The page-record fields the opt-in scripts leave: `layoutCensus` (the rows of
 * the cell's labels) and `deviceLimits` (what the page asked for, what the
 * device reports, and the comparison with the WebGPU defaults) and `engagement`
 * (the engine's own engagement flags the cell names, `lib/cloud-engagement-read.mjs`).
 * A cell with no opt-in yields an empty object.
 *
 * @param {object} page A Playwright page.
 * @param {object} cell A landing cell table entry.
 * @returns {Promise<{layoutCensus?: object, deviceLimits?: object,
 *   engagement?: object}>}
 */
export async function readCellInitRecords(page, cell) {
  const records = {};
  if (wantsLayoutCensus(cell)) {
    records.layoutCensus = await readBindGroupLayoutCensus(
      page,
      cell.layoutCensus,
    );
  }
  if (wantsDefaultLimits(cell)) {
    records.deviceLimits = await readDeviceLimits(page);
  }
  if (wantsEngagement(cell)) {
    records.engagement = await readCloudEngagement(page, cell.engagement);
  }
  return records;
}

/**
 * The capture-time records of the opt-in page readers, under `readers`; an
 * empty object when no reader is named.
 *
 * @param {object} page A Playwright page.
 * @param {{readers?: string}} [options] The probe options.
 * @returns {Promise<{readers?: object}>}
 */
export async function readReaderRecords(page, options = {}) {
  const readers = readersOf(options);
  return readers.length > 0
    ? { readers: await readCaptureReaders(page, readers) }
    : {};
}
