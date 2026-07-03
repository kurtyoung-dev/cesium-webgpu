import fs from "fs";
import path from "path";
import { performance } from "perf_hooks";
import { fileURLToPath, URL } from "url";

import chokidar from "chokidar";
import compression from "compression";
import express from "express";
import yargs from "yargs";

import ContextCache from "./scripts/ContextCache.js";
import createRoute from "./scripts/createRoute.js";

import {
  createCesiumJs,
  createCombinedSpecList,
  glslToJavaScript,
  wgslToJavaScript,
  createIndexJs,
  buildCesium,
  buildEngine,
  buildWidgets,
} from "./scripts/build.js";

const argv = await yargs(process.argv)
  .options({
    port: {
      default: 8080,
      description: "Port to listen on.",
    },
    sandcastlePort: {
      default: 8081,
      description:
        "Port for the Sandcastle mirror server (main port + 1 by convention).",
    },
    public: {
      type: "boolean",
      description: "Run a public server that listens on all interfaces.",
    },
    production: {
      type: "boolean",
      description: "If true, skip build step and serve existing built files.",
    },
    embeddings: {
      type: "boolean",
      default: true,
      description:
        "Generate Sandcastle semantic search embeddings. Pass --no-embeddings to skip. Can also be set via SANDCASTLE_NO_EMBEDDINGS=1.",
    },
  })
  .help().argv;

// These functions will not exist in the production zip file but they also won't be run
const { getSandcastleConfig, buildSandcastleGallery, buildSandcastleApp } =
  argv.production ? {} : await import("./scripts/buildSandcastle.js");

const outputDirectory = path.join("Build", "CesiumDev");

function formatTimeSinceInSeconds(start) {
  return Math.ceil((performance.now() - start) / 100) / 10;
}

/**
 * Returns CesiumJS bundles configured for development.
 *
 * @returns {Bundles} The bundles.
 */
async function generateDevelopmentBuild() {
  const startTime = performance.now();

  // Build @cesium/engine index.js
  console.log("[1/3] Building @cesium/engine...");
  const engineContexts = await buildEngine({
    incremental: true,
    minify: false,
    write: false,
  });

  // Build @cesium/widgets index.js
  console.log("[2/3] Building @cesium/widgets...");
  const widgetContexts = await buildWidgets({
    incremental: true,
    minify: false,
    write: false,
  });

  // Build CesiumJS and save returned contexts for rebuilding upon request
  console.log("[3/3] Building CesiumJS...");
  const contexts = await buildCesium({
    iife: true,
    incremental: true,
    minify: false,
    node: false,
    outputDirectory: outputDirectory,
    removePragmas: false,
    sourcemap: true,
    write: false,
  });

  console.log(
    `Cesium built in ${formatTimeSinceInSeconds(startTime)} seconds.`,
  );

  return { ...contexts, engine: engineContexts, widgets: widgetContexts };
}

// Delay execution of the callback until a short time has elapsed since it was last invoked, preventing
// calls to the same function in quick succession from triggering multiple builds.
const throttleDelay = 500;
const throttle = (callback) => {
  let timeout;
  return () =>
    new Promise((resolve) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      timeout = setTimeout(() => {
        resolve(callback());
      }, throttleDelay);
    });
};

(async function () {
  const gzipHeader = Buffer.from("1F8B08", "hex");
  const production = argv.production;

  let contexts;
  if (!production) {
    contexts = await generateDevelopmentBuild();
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    if (
      buildSandcastleApp &&
      !fs.existsSync(path.join(__dirname, "/Apps/Sandcastle2/index.html"))
    ) {
      // Sandcastle takes a bit of time to build and is unlikely to change often
      // Only build it when we detect it doesn't exist to save on dev time
      console.log("Building Sandcastle...");
      const startTime = performance.now();
      const noEmbeddings =
        !argv.embeddings || !!process.env.SANDCASTLE_NO_EMBEDDINGS;
      await buildSandcastleApp({
        outputToBuildDir: false,
        includeDevelopment: true,
        outerOrigin: `http://localhost:${argv.port}`,
        innerOrigin: `http://localhost:${argv.sandcastlePort}`,
        generateEmbeddings: noEmbeddings ? false : undefined,
      });
      console.log(
        `Sandcastle built in ${formatTimeSinceInSeconds(startTime)} seconds.`,
      );
    }
  }

  const app = express();

  app.use(function (req, res, next) {
    // *NOTE* Any changes you make here must be mirrored in web.config.
    const extensionToMimeType = {
      ".czml": "application/json",
      ".json": "application/json",
      ".geojson": "application/json",
      ".topojson": "application/json",
      ".wasm": "application/wasm",
      ".ktx2": "image/ktx2",
      ".gltf": "model/gltf+json",
      ".bgltf": "model/gltf-binary",
      ".glb": "model/gltf-binary",
      ".b3dm": "application/octet-stream",
      ".pnts": "application/octet-stream",
      ".i3dm": "application/octet-stream",
      ".cmpt": "application/octet-stream",
      ".geom": "application/octet-stream",
      ".vctr": "application/octet-stream",
      ".glsl": "text/plain",
    };
    const extension = path.extname(req.url);
    if (extensionToMimeType[extension]) {
      res.contentType(extensionToMimeType[extension]);
    }
    next();
  });

  app.use(compression());
  //eslint-disable-next-line no-unused-vars
  app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept",
    );
    next();
  });

  function checkGzipAndNext(req, res, next) {
    const baseURL = `${req.protocol}://${req.headers.host}/`;
    const reqUrl = new URL(req.url, baseURL);
    const filePath = reqUrl.pathname.substring(1);

    const readStream = fs.createReadStream(filePath, { start: 0, end: 2 });
    //eslint-disable-next-line no-unused-vars
    readStream.on("error", function (err) {
      next();
    });

    readStream.on("data", function (chunk) {
      if (chunk.equals(gzipHeader)) {
        res.header("Content-Encoding", "gzip");
      }
      next();
    });
  }

  const knownTilesetFormats = [
    /\.b3dm/,
    /\.pnts/,
    /\.i3dm/,
    /\.cmpt/,
    /\.glb/,
    /\.geom/,
    /\.vctr/,
    /\.subtree/,
    /tileset.*\.json$/,
  ];
  app.get(knownTilesetFormats, checkGzipAndNext);

  if (!production) {
    const iifeWorkersCache = new ContextCache(contexts.iifeWorkers);
    const iifeCache = createRoute(
      app,
      "Build/CesiumUnminified/Cesium.js",
      "/Build/CesiumUnminified/Cesium.js{.map}",
      contexts.iife,
      [iifeWorkersCache],
    );
    const esmCache = createRoute(
      app,
      "Build/CesiumUnminified/index.js",
      "/Build/CesiumUnminified/index.js{.map}",
      contexts.esm,
    );
    const workersCache = createRoute(
      app,
      "Build/CesiumUnminified/Workers/*",
      "/Build/CesiumUnminified/Workers/*file.js",
      contexts.workers,
    );
    const engineBundleCache = createRoute(
      app,
      "packages/engine/Build/Unminified/index.js",
      "/packages/engine/Build/Unminified/index.js{.map}",
      contexts.engine.esm,
    );
    const widgetsBundleCache = createRoute(
      app,
      "packages/widgets/Build/Unminified/index.js",
      "/packages/widgets/Build/Unminified/index.js{.map}",
      contexts.widgets.esm,
    );

    const glslWatcher = chokidar.watch("packages/engine/Source/Shaders", {
      ignored: (path, stats) => {
        // Watch BOTH .glsl and .wgsl. The original filter was .glsl-only
        // which silently masked .wgsl edits — dev server kept serving
        // the stale in-memory bundle even after gulp build wrote new
        // .wgsl/.js to disk, making WebGPU shader fixes look like they
        // weren't taking effect.
        if (!stats?.isFile()) {
          return false;
        }
        return !path.endsWith(".glsl") && !path.endsWith(".wgsl");
      },
      ignoreInitial: true,
    });
    glslWatcher.on("all", async function (event, filePath) {
      void event;
      // Regenerate the appropriate .js mirror based on file extension.
      // Both .glsl and .wgsl edits invalidate the same bundle caches.
      if (filePath?.endsWith(".wgsl")) {
        await wgslToJavaScript(false, "Build/minifyShaders.state", "engine");
      } else {
        await glslToJavaScript(false, "Build/minifyShaders.state", "engine");
      }
      esmCache.clear();
      engineBundleCache.clear();
      iifeCache.clear();
    });

    // Watch `.js` AND `.ts` source files. Original watcher only matched
    // `.js`, which silently masked TypeScript edits during dev — the
    // dev server kept serving a stale in-memory bundle until restart,
    // making it look like fixes weren't propagating. Found while
    // debugging the Translucent Classification depth-copy validation:
    // hours of "fix is in the bundle on disk but doesn't run" turned
    // out to be `chokidar.watch` filtering out `.ts` change events.
    const isWatchedSource = (filePath, stats) => {
      if (!stats?.isFile()) {
        return false;
      }
      return !(filePath.endsWith(".js") || filePath.endsWith(".ts"));
    };
    const engineSourceWatcher = chokidar.watch(["packages/engine/Source"], {
      ignored: [
        "packages/engine/Source/Shaders",
        "packages/engine/Source/ThirdParty",
        isWatchedSource,
      ],
      ignoreInitial: true,
    });
    const widgetsSourceWatcher = chokidar.watch(["packages/widgets/Source"], {
      ignored: ["packages/widgets/Source/ThirdParty", isWatchedSource],
      ignoreInitial: true,
    });

    function clearTopLevelCaches() {
      esmCache.clear();
      iifeCache.clear();
      workersCache.clear();
      iifeWorkersCache.clear();
    }

    engineSourceWatcher.on("all", async () => {
      clearTopLevelCaches();
      engineBundleCache.clear();

      await createIndexJs("engine");
      await createCesiumJs();
    });

    widgetsSourceWatcher.on("all", async () => {
      clearTopLevelCaches();
      widgetsBundleCache.clear();

      await createIndexJs("widgets");
      await createCesiumJs();
    });

    const testWorkersCache = createRoute(
      app,
      "TestWorkers/*",
      "/Build/Specs/TestWorkers/*file",
      contexts.testWorkers,
    );
    chokidar
      .watch(["Specs/TestWorkers/*.js"], { ignoreInitial: true })
      .on("all", testWorkersCache.clear);

    const specsCache = createRoute(
      app,
      "Specs/*",
      "/Build/Specs/*file",
      contexts.specs,
    );
    const specWatcher = chokidar.watch(
      ["packages/engine/Specs", "packages/widgets/Specs", "Specs"],
      {
        ignored: [
          "packages/engine/Specs/SpecList.js",
          "packages/widgets/Specs/SpecList.js",
          "Specs/SpecList.js",
          "Specs/e2e",
          (path, stats) => {
            return !!stats?.isFile() && !path.endsWith("Spec.js");
          },
        ],
        ignoreInitial: true,
      },
    );
    specWatcher.on("all", async (event) => {
      if (event === "add" || event === "unlink") {
        await createCombinedSpecList();
      }

      specsCache.clear();
    });

    if (!production && getSandcastleConfig && buildSandcastleGallery) {
      const { configPath, root, gallery } = await getSandcastleConfig();
      const baseDirectory = path.relative(root, path.dirname(configPath));
      const galleryFiles = gallery.files.map((pattern) =>
        path.join(baseDirectory, pattern),
      );
      const galleryWatcher = chokidar.watch(galleryFiles, {
        ignoreInitial: true,
      });

      galleryWatcher.on(
        "all",
        throttle(async () => {
          const startTime = performance.now();
          const noEmbeddings =
            !argv.embeddings || !!process.env.SANDCASTLE_NO_EMBEDDINGS;
          try {
            await buildSandcastleGallery({
              includeDevelopment: true,
              generateEmbeddings: noEmbeddings ? false : undefined,
            });
            console.log(
              `Gallery built in ${formatTimeSinceInSeconds(startTime)} seconds.`,
            );
          } catch (e) {
            console.error(e);
          }
        }),
      );
    }

    // Serve any static files starting with "Build/CesiumUnminified" from the
    // development build instead. That way, previous build output is preserved
    // while the latest is being served
    app.use("/Build/CesiumUnminified", express.static("Build/CesiumDev"));
  }

  // Dev-only same-origin proxy for the weather-data ingest (live OGC API-EDR and
  // friends). The browser fetches an external open-weather feed via
  // `/proxy?url=<encoded>` from the app's own origin, so CORS on the upstream
  // can't block it. ALLOWLISTED to a few known public weather hosts — this is
  // NOT an open proxy, and it only exists on the dev server (never shipped).
  // See migration_doc/WEATHER_DATA_INGEST_ROADMAP.md + Scene/Weather/EdrWeatherSource.
  const WEATHER_PROXY_ALLOW = [
    "data-api.mdl.nws.noaa.gov",
    "edr-api-c.mdl.nws.noaa.gov",
    "api.weather.gc.ca",
    "geo.weather.gc.ca",
    "aviationweather.gov",
  ];
  app.get("/proxy", async function (req, res) {
    const target = req.query.url;
    if (typeof target !== "string" || !/^https?:\/\//i.test(target)) {
      res
        .status(400)
        .json({ error: "proxy: ?url= must be an absolute http(s) URL" });
      return;
    }
    let host;
    try {
      host = new URL(target).host;
    } catch {
      res.status(400).json({ error: "proxy: malformed url" });
      return;
    }
    const allowed = WEATHER_PROXY_ALLOW.some(
      (h) => host === h || host.endsWith(`.${h}`),
    );
    if (!allowed) {
      res.status(403).json({ error: `proxy: host not allowlisted: ${host}` });
      return;
    }
    try {
      const upstream = await fetch(target, {
        signal: AbortSignal.timeout(25000),
        headers: { Accept: req.headers.accept || "application/json" },
      });
      res.status(upstream.status);
      const ct = upstream.headers.get("content-type");
      if (ct) {
        res.set("content-type", ct);
      }
      res.set("access-control-allow-origin", "*");
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
      res
        .status(502)
        .json({ error: `proxy upstream failed: ${String(e?.message ?? e)}` });
    }
  });

  // Dev-only mock OGC API-EDR endpoint (Weather Phase 3 — offline pipeline test).
  // Serves the committed CoverageJSON fixture for ANY `/mock-edr/...` path, so a
  // probe can point `new EdrWeatherSource({ baseUrl: "<origin>/mock-edr", ... })`
  // at it — `buildUrl` appends `/collections/<id>/cube?...`, all of which this
  // route ignores and answers with the fixture. This proves the EDR fetch ->
  // CoverageJSON parse -> packer -> weatherTex -> clouds chain WITHOUT the live
  // (CORS-uncertain, dev-lab) network, which retroactively completes Phase 1's
  // end-to-end verification. Never shipped (dev server only).
  //eslint-disable-next-line no-unused-vars
  app.get(/^\/mock-edr(\/.*)?$/, function (req, res) {
    const fixturePath = path.resolve(
      "Tools/visual-regression/fixtures/edr-cube-tcc.json",
    );
    res.set("access-control-allow-origin", "*");
    res.set("content-type", "application/prs.coverage+json");
    res.sendFile(fixturePath, function (err) {
      if (err) {
        res
          .status(500)
          .json({ error: `mock-edr: fixture read failed: ${String(err)}` });
      }
    });
  });

  // Dev-only mock METAR endpoint (Weather Phase 3 — Batch 425). Serves the
  // committed station-obs fixture for ANY `/mock-metar/...` path so a probe can
  // point `new MetarWeatherSource({ url: "<origin>/mock-metar" })` at it and
  // exercise the parse + IDW rasterize + full-RGBA pack chain WITHOUT the live
  // (CORS-uncertain) aviationweather.gov feed. Never shipped (dev server only).
  //eslint-disable-next-line no-unused-vars
  app.get(/^\/mock-metar(\/.*)?$/, function (req, res) {
    const fixturePath = path.resolve(
      "Tools/visual-regression/fixtures/metar-stations.json",
    );
    res.set("access-control-allow-origin", "*");
    res.set("content-type", "application/json");
    res.sendFile(fixturePath, function (err) {
      if (err) {
        res
          .status(500)
          .json({ error: `mock-metar: fixture read failed: ${String(err)}` });
      }
    });
  });

  // Dev-only mock OGC API-Coverages (MSC GeoMet / "WCS") endpoint (Weather Phase
  // 3 — Batch 425). Serves the committed CoverageJSON coverage fixture for ANY
  // `/mock-wcs/...` path so a probe can point a `WcsCoveragesWeatherSource` at it
  // — `buildUrl` appends `/collections/<id>/coverage?...`, which this route
  // ignores and answers with the fixture. Proves the OGC Coverages fetch ->
  // CoverageJSON parse (shared with EDR) -> packer -> clouds chain WITHOUT the
  // live (CORS-uncertain) network. Never shipped (dev server only).
  //eslint-disable-next-line no-unused-vars
  app.get(/^\/mock-wcs(\/.*)?$/, function (req, res) {
    const fixturePath = path.resolve(
      "Tools/visual-regression/fixtures/wcs-coverage.json",
    );
    res.set("access-control-allow-origin", "*");
    res.set("content-type", "application/prs.coverage+json");
    res.sendFile(fixturePath, function (err) {
      if (err) {
        res
          .status(500)
          .json({ error: `mock-wcs: fixture read failed: ${String(err)}` });
      }
    });
  });

  app.use(express.static(path.resolve(".")));

  const server = app.listen(
    argv.port,
    argv.public ? undefined : "localhost",
    function () {
      if (argv.public) {
        console.log(
          `Cesium development server running publicly.  Connect to http://localhost:${server.address()?.port}/`,
        );
      } else {
        console.log(
          `Cesium development server running locally.  Connect to http://localhost:${server.address()?.port}/`,
        );
      }
    },
  );

  server.on("error", function (/** @type {NodeJS.ErrnoException} */ e) {
    if (e.code === "EADDRINUSE") {
      console.log(
        `Error: Port ${argv.port} is already in use, select a different port.`,
      );
      console.log(`Example: node server.js --port ${argv.port + 1}`);
    } else if (e.code === "EACCES") {
      console.log(
        `Error: This process does not have permission to listen on port ${argv.port}.`,
      );
      if (argv.port < 1024) {
        console.log("Try a port number higher than 1024.");
      }
    }

    throw e;
  });

  server.on("close", function () {
    console.log("Cesium development server stopped.");
  });

  const sandcastleServer = app.listen(
    argv.sandcastlePort,
    "localhost",
    function () {
      // This "mirror" server runs on a separate port to create origin separation between
      // the main Sandcastle app and the viewer page for security
      // We use the same express `app` to reuse the auto re-building of assets when the source changes
      console.log(
        `Sandcastle mirror server running on port ${argv.sandcastlePort}`,
      );
    },
  );

  sandcastleServer.on(
    "error",
    function (/** @type {NodeJS.ErrnoException} */ e) {
      if (e.code === "EADDRINUSE") {
        console.log(
          `Error: Port ${argv.sandcastlePort} is already in use, please free it and try again`,
        );
      } else if (e.code === "EACCES") {
        console.log(
          `Error: This process does not have permission to listen on port ${argv.sandcastlePort}.`,
        );
      }

      throw e;
    },
  );

  sandcastleServer.on("close", function () {
    console.log("Sandcastle mirror server stopped.");
  });

  let isFirstSig = true;
  process.on("SIGINT", function () {
    if (isFirstSig) {
      console.log("\nCesium development servers shutting down.");

      if (!production) {
        contexts.esm.dispose();
        contexts.iife.dispose();
        contexts.workers.dispose();
        contexts.specs.dispose();
        contexts.testWorkers.dispose();
      }

      server.close(() => {
        sandcastleServer.close(() => process.exit(0));
      });

      isFirstSig = false;
    } else {
      throw new Error("Cesium development server force kill.");
    }
  });
})();
