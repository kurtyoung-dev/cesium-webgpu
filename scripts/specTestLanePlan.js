/**
 * What `gulp test` builds and serves for each lane, in one place: the lane its
 * arguments select, the lane's full and narrow builds, the freshness handshake
 * for that lane, and the files Karma serves. The handshake reads the records
 * of exactly the directories this plan serves (`specTestLanes` in
 * `specBundleFreshness.js`), so the code a lane checks and the code Karma runs
 * cannot drift apart.
 */

import {
  ENGINE_WORKERS_DIRECTORY,
  TEST_WORKERS_DIRECTORY,
  ensureSpecLaneFresh,
  getSpecTestLane,
  resolveSpecTestLane,
} from "./specBundleFreshness.js";

const scope = "cesium";

/**
 * @typedef {object} SpecLaneBuilds
 * @property {(options: object) => Promise<unknown>} buildEngine
 * @property {(options: object) => Promise<unknown>} buildWidgets
 * @property {(options: object) => Promise<unknown>} buildCesium
 * @property {(options: object) => Promise<unknown>} buildTestWorkers
 * @property {(options: object) => Promise<unknown>} buildCombinedSpecBundle
 * @property {(workspace: string, options: object) => Promise<unknown>} buildWorkspaceSpecBundle
 */

/**
 * @typedef {object} KarmaFilePattern
 * @property {string} pattern
 * @property {boolean} included
 * @property {string} [type]
 */

/**
 * The lane arguments of `gulp test`: `--workspace` (with or without the
 * `@cesium/` scope) and `--release`.
 *
 * @param {{workspace?: unknown, release?: unknown}} argv
 * @returns {{workspace: string|undefined, release: boolean}}
 */
export function specTestLaneArguments(argv) {
  const workspace = argv.workspace
    ? String(argv.workspace).replaceAll(`@${scope}/`, "")
    : undefined;
  return { workspace, release: Boolean(argv.release) };
}

/**
 * The files and proxies Karma serves for a lane.
 *
 * @param {string} laneKey
 * @returns {{files: KarmaFilePattern[], proxies: Record<string, string>|undefined}}
 */
export function karmaFilesForLane(laneKey) {
  const lane = getSpecTestLane(laneKey);
  if (laneKey === "release") {
    return {
      files: [
        { pattern: "Specs/Data/**", included: false },
        { pattern: "Specs/TestWorkers/**/*.wasm", included: false },
        { pattern: "Specs/ThirdParty/**", included: false, type: "module" },
        { pattern: `${lane.outputDirectory}/Cesium.js`, included: true },
        { pattern: `${lane.outputDirectory}/Cesium.js.map`, included: false },
        { pattern: `${lane.outputDirectory}/**`, included: false },
        { pattern: "Build/Specs/karma-main.js", included: true },
        { pattern: "Build/Specs/SpecList.js", included: true, type: "module" },
        { pattern: `${TEST_WORKERS_DIRECTORY}/**.js`, included: false },
      ],
      proxies: undefined,
    };
  }
  if (laneKey === "combined") {
    return {
      files: [
        { pattern: "Specs/Data/**", included: false },
        { pattern: "Specs/TestWorkers/**/*.wasm", included: false },
        { pattern: `${lane.outputDirectory}/Cesium.js`, included: true },
        { pattern: `${lane.outputDirectory}/Cesium.js.map`, included: false },
        { pattern: `${lane.outputDirectory}/**`, included: false },
        {
          pattern: "Build/Specs/karma-main.js",
          included: true,
          type: "module",
        },
        { pattern: "Build/Specs/SpecList.js", included: true, type: "module" },
        { pattern: `${TEST_WORKERS_DIRECTORY}/**.js`, included: false },
      ],
      proxies: undefined,
    };
  }
  // A workspace lane serves its own spec bundle, the engine's static assets
  // and third-party files straight from Source, and the engine workers, the
  // engine package being the lowest-level dependency of both workspaces.
  const bundleDirectory = `packages/${laneKey}/Build/Specs`;
  return {
    files: [
      {
        pattern: `${bundleDirectory}/karma-main.js`,
        included: true,
        type: "module",
      },
      {
        pattern: `${bundleDirectory}/SpecList.js`,
        included: true,
        type: "module",
      },
      { pattern: "Specs/Data/**", included: false },
      { pattern: "Specs/TestWorkers/**/*.wasm", included: false },
      { pattern: `${ENGINE_WORKERS_DIRECTORY}/**`, included: false },
      { pattern: "packages/engine/Source/Assets/**", included: false },
      { pattern: "packages/engine/Source/ThirdParty/**", included: false },
      { pattern: "packages/engine/Source/Widget/*.css", included: false },
      { pattern: `${TEST_WORKERS_DIRECTORY}/**.js`, included: false },
    ],
    proxies: {
      "/base/Build/CesiumUnminified/Assets/":
        "/base/packages/engine/Source/Assets/",
      "/base/Build/CesiumUnminified/ThirdParty/":
        "/base/packages/engine/Source/ThirdParty/",
      "/base/Build/CesiumUnminified/Widgets/CesiumWidget/":
        "/base/packages/engine/Source/Widget/",
      "/base/Build/CesiumUnminified/Workers/": `/base/${ENGINE_WORKERS_DIRECTORY}/`,
    },
  };
}

/**
 * @typedef {object} SpecTestLanePlan
 * @property {string} lane
 * @property {string|undefined} workspace
 * @property {boolean} release
 * @property {((laneKey?: string, context?: {snapshot?: object}) => Promise<void>)|undefined} full
 *   Builds everything the lane serves; absent for a lane the test task cannot build.
 * @property {(specTarget?: string, context?: {snapshot?: object}) => Promise<unknown>} narrow
 *   Rebuilds only the lane's spec bundle.
 * @property {(options?: {cwd?: string, log?: (message: string) => void}) => ReturnType<typeof ensureSpecLaneFresh>} ensureFresh
 *   The freshness handshake for this plan's own lane, with this plan's builds:
 *   the test task calls it before Karma serves `files`.
 * @property {KarmaFilePattern[]} files
 * @property {Record<string, string>|undefined} proxies
 */

/**
 * The plan `gulp test` runs for its arguments.
 *
 * @param {{workspace?: unknown, release?: unknown}} argv
 * @param {SpecLaneBuilds} builds
 * @returns {SpecTestLanePlan}
 */
export function planSpecTestLane(argv, builds) {
  const { workspace, release } = specTestLaneArguments(argv);
  const laneKey = resolveSpecTestLane({ workspace, release });
  const lane = getSpecTestLane(laneKey);

  // The handshake names the lane or spec bundle it rebuilds; a plan only ever
  // builds its own.
  const assertOwn = (requested, own) => {
    if (requested !== own) {
      throw new Error(
        `The "${laneKey}" lane's plan cannot rebuild "${requested}".`,
      );
    }
  };

  /** @type {SpecTestLanePlan["full"]} */
  let full;
  if (laneKey === "combined") {
    full = async (requested = laneKey, context = {}) => {
      assertOwn(requested, laneKey);
      const snapshot = context.snapshot;
      // The combined lane bundles `Source/Cesium.js`, whose bare
      // `@cesium/engine` / `@cesium/widgets` specifiers resolve to the package
      // barrels on disk; a source file added or removed since the last full
      // build leaves them disagreeing unless the engine and widgets builds run
      // first, exactly as the plain `build` task does.
      await builds.buildEngine({ snapshot });
      await builds.buildWidgets({ snapshot });
      await builds.buildCesium({
        iife: true,
        // `clean: false` keeps the last successful build's files on disk, and
        // therefore servable, until this run's own write succeeds (Q-95); the
        // directory's record is removed before the first write all the same.
        clean: false,
        snapshot,
      });
    };
  } else if (lane.canRebuild) {
    full = async (requested = laneKey, context = {}) => {
      assertOwn(requested, laneKey);
      const snapshot = context.snapshot;
      // The workspace lanes serve the engine workers, so the engine build is a
      // real dependency of both, and the test workers every lane serves.
      await builds.buildEngine({ snapshot });
      if (laneKey === "widgets") {
        await builds.buildWidgets({ snapshot });
      }
      await builds.buildTestWorkers({ snapshot });
    };
  }

  /** @type {SpecTestLanePlan["narrow"]} */
  const narrow = async (requested = lane.specTarget, context = {}) => {
    assertOwn(requested, lane.specTarget);
    return lane.specTarget === "combined"
      ? builds.buildCombinedSpecBundle({ snapshot: context.snapshot })
      : builds.buildWorkspaceSpecBundle(lane.specTarget, {
          snapshot: context.snapshot,
        });
  };

  /** @type {SpecTestLanePlan["ensureFresh"]} */
  const ensureFresh = (options = {}) =>
    ensureSpecLaneFresh(laneKey, { ...options, full, narrow });

  const { files, proxies } = karmaFilesForLane(laneKey);
  return {
    lane: laneKey,
    workspace,
    release,
    full,
    narrow,
    ensureFresh,
    files,
    proxies,
  };
}
