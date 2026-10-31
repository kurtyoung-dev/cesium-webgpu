/**
 * The weather-map probe's capture names across `--runs N`, and the capture manifest it writes beside its report.
 * @purpose Pure naming rule (a capture file keeps its bare name for one run and takes the kit's `-run<N>` suffix for several, so every run's PNGs survive side by side), the per-capture record the probe puts in each run's report cell, and the adapter from those records to the pages and rigs lib/landing-capture-manifest.mjs builds a validated capture-seam manifest from, with the throw-safe writer the probe's receipt calls so contact-sheet.mjs can sheet every file of every run.
 * @status ACTIVE
 *
 * WHY A PIECE. `probe-weather-map.mjs` named each capture after its view only
 * (`located-off-lon-120-lat45`), so with `--runs 3` run 1 overwrote run 0 and
 * only the last run's PNGs stayed on disk, and a run-to-run pixel diff could
 * not be taken from one invocation. The landing and water probes name repeats
 * `<stem>-run<N>` (`probe-landing-cells.mjs`, `probe-water-cells.mjs`), the
 * kit's one convention, and this probe now does the same. The probe also wrote
 * no capture manifest; the builder is `landing-capture-manifest.mjs`'s and is
 * imported, not copied.
 *
 * THE NAMING RULE. {@link weatherMapCaptureName}: one run keeps the bare stem
 * (the names earlier evidence banked), several runs append `-run<N>` with the
 * runtime's 0-based run number. A first-frame retry puts its own marker in the
 * stem (`<view>-retry<n>`), so its file is `<view>-retry<n>-run<N>`.
 *
 * WHAT BECOMES AN ENTRY. One manifest entry per FILE: `weather-map:<file
 * stem>`, so every run's every PNG (the located views, the two wide views and
 * a discarded first-frame retry) has its own entry and the sheet shows them
 * all. The builder otherwise shows only an arm's first capture. Each entry
 * stages a rig synthesised from the capture's own view (position, map on or
 * off, settle frames), shared by the same view of every run, so two runs of
 * one view carry the same replay key. All cells are WebGPU AFTER cells and
 * every BEFORE cell reads UNMEASURED ("no --base-report"): the probe compares
 * map ON with map OFF inside one run and carries no base report, and the
 * manifest holds no verdict.
 *
 * REPORT PATHS ARE RELATIVE. A report cell records each capture's `file` (its
 * name inside the output directory), never an absolute path; the writer joins
 * it onto the receipt context's output directory.
 *
 * @module Tools/visual-regression/lib/weather-map-capture-manifest
 */

import path from "node:path";

import {
  runtimeReportFileName,
  writeLandingCaptureManifestOrViolations,
} from "./landing-capture-manifest.mjs";

/** The cell name every weather-map manifest entry carries. */
export const WEATHER_MAP_MANIFEST_CELL = "weather-map";

/** How a weather-map entry's description names its cell. */
export const WEATHER_MAP_ENTRY_LABEL = "Weather-map capture";

const RENDERER = "webgpu";

/**
 * The file stem a capture is written under.
 *
 * @param {string} stem The capture's name for one run.
 * @param {{run: number, runs: number}} plan The run's number and the invocation's run count.
 * @returns {string} The bare stem for a single run, else `<stem>-run<N>`.
 */
export function weatherMapCaptureName(stem, { run, runs }) {
  return runs > 1 ? `${stem}-run${run}` : stem;
}

/**
 * One capture as a run's report cell records it. Pure.
 *
 * @param {object} fields Fields.
 * @param {string} fields.name The file stem as written (run suffix included).
 * @param {string} fields.base The view's stem, without run or retry markers.
 * @param {"located"|"wide"} fields.kind Which view family.
 * @param {{lon: number, lat: number, height: number, frames: number,
 *   weatherOn: boolean}} fields.view The view the capture shows.
 * @param {number} [fields.retry] 0 for the first take, n for the n-th re-settle.
 * @param {boolean} [fields.accepted] False for a discarded first-frame retry take.
 * @param {number} fields.run The runtime's 0-based run number.
 * @param {{sha256: string, byteLength: number}} fields.shot The capture seam's record.
 * @param {string} fields.url The page URL the capture was taken from.
 * @param {string} fields.capturedAt ISO instant.
 * @returns {object}
 */
export function weatherMapCaptureRecord({
  name,
  base,
  kind,
  view,
  retry = 0,
  accepted = true,
  run,
  shot,
  url,
  capturedAt,
}) {
  return {
    name,
    file: `${name}.png`,
    base,
    kind,
    run,
    retry,
    accepted,
    view: {
      lon: view.lon,
      lat: view.lat,
      height: view.height,
      frames: view.frames,
      weatherOn: view.weatherOn,
    },
    sha256: shot.sha256,
    byteLength: shot.byteLength,
    url,
    capturedAt,
  };
}

const rigIdOf = (record) => `weather-map-probe-${record.base}`;

/**
 * The page records the landing builder reads: one per capture file of every
 * run. Pure.
 *
 * @param {object[]} cells The probe's per-run report cells (`run`, `captures`).
 * @param {string} outputDirectory Where the captures were written.
 * @returns {object[]}
 */
export function weatherMapManifestPages(cells, outputDirectory) {
  return (cells ?? []).flatMap((cell) =>
    (cell.captures ?? []).map((record) => ({
      cell: WEATHER_MAP_MANIFEST_CELL,
      rig: rigIdOf(record),
      renderer: RENDERER,
      page: record.name,
      run: cell.run,
      capture: {
        path: path.resolve(outputDirectory, record.file),
        sha256: record.sha256,
        url: record.url,
        capturedAt: record.capturedAt,
      },
    })),
  );
}

/**
 * The rigs the pages name, synthesised from each capture's view. Pure.
 *
 * @param {object[]} cells The probe's per-run report cells.
 * @param {{viewport: {width: number, height: number}, page: string}} staged
 *   The viewport the probe opens and the page it loads.
 * @returns {Map<string, object>}
 */
export function weatherMapManifestRigs(cells, { viewport, page }) {
  const rigs = new Map();
  for (const cell of cells ?? []) {
    for (const record of cell.captures ?? []) {
      const id = rigIdOf(record);
      if (rigs.has(id)) {
        continue;
      }
      const { lon, lat, height, frames, weatherOn } = record.view;
      rigs.set(id, {
        id,
        tags: ["weather"],
        page,
        renderers: [RENDERER],
        description:
          `Weather-map probe ${record.kind} view with the weather map ${weatherOn ? "on" : "off"}: ` +
          `nadir at ${lon}, ${lat}, ${height} m, ${frames} settle frames.`,
        camera: {
          lon,
          lat,
          height,
          heading: 0,
          pitch: -Math.PI / 2,
          roll: 0,
        },
        clock: null,
        dials: { cloudWeatherMap: weatherOn },
        viewport: { ...viewport },
        readiness: { kind: "settleFrames", frames },
      });
    }
  }
  return rigs;
}

/**
 * Write the probe's manifest beside its report. A manifest either validator
 * refuses, and a builder throw, write none and remove a stale one; the answer
 * comes back as violations so the receipt can say why and the run is kept.
 * Warns once on stderr when nothing was written.
 *
 * @param {object} inputs Inputs.
 * @param {string} inputs.probe The probe descriptor's `name`.
 * @param {object[]} inputs.cells The probe's per-run report cells.
 * @param {{viewport: object, page: string}} inputs.staged See
 *   {@link weatherMapManifestRigs}.
 * @param {{options?: object, origin: string, outputDirectory: string,
 *   generatedAt: string}} inputs.context The runtime's receipt context.
 * @param {object} [inputs.fs] Injected I/O, as the builder's writer takes it.
 * @returns {{path: string|null, written: boolean, violations: string[],
 *   files: string[]}} `path` is the manifest's file name beside the report.
 */
export function writeWeatherMapManifest({ probe, cells, staged, context, fs }) {
  const result = writeLandingCaptureManifestOrViolations({
    ...(fs && { fs }),
    pages: weatherMapManifestPages(cells, context.outputDirectory),
    rigsById: weatherMapManifestRigs(cells, staged),
    origins: { AFTER: context.origin },
    generatedAt: context.generatedAt,
    servedBuildAssertion:
      context.options?.servedBuild === false ? "waived" : "enforced",
    receipt: runtimeReportFileName(probe),
    outputDirectory: context.outputDirectory,
    entryLabel: WEATHER_MAP_ENTRY_LABEL,
  });
  if (!result.written) {
    console.warn(
      `[probe-${probe}] capture manifest refused: ${result.violations.slice(0, 3).join("; ")}`,
    );
  }
  return {
    ...result,
    path: result.path === null ? null : path.basename(result.path),
  };
}
