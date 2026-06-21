"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");

module.exports = function (config) {
  // EdgeHeadlessCI invocation contract: run with BOTH
  //   --browsers=EdgeHeadlessCI  AND  CHROME_BIN=<path to msedge.exe>
  // Karma's Chrome launcher honors CHROME_BIN; Edge is Chromium so it runs the
  // Jasmine specs INCLUDING real-GPUDevice WebGPU specs (see the project's
  // gulp-test-via-Edge note). Without CHROME_BIN it falls back to Chrome, which
  // is not installed in this environment.
  //
  // Clean up stale karma-edge-* temp profiles (>1h old) left by prior runs. A
  // surviving Edge owning an old profile is the real back-to-back "Chrome failed
  // to start" cause; concurrency:1 only covers intra-run collisions. Best-effort:
  // never block the run, and only touch profiles old enough that no live run owns
  // them (the dir name carries the launch Date.now()).
  try {
    const tmp = os.tmpdir();
    const STALE_MS = 60 * 60 * 1000;
    const now = Date.now();
    for (const name of fs.readdirSync(tmp)) {
      const m = name.match(/^karma-edge-(\d+)-/);
      if (m && now - Number(m[1]) > STALE_MS) {
        fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
      }
    }
  } catch {
    // best-effort cleanup; never block the test run
  }

  const options = {
    // base path that will be used to resolve all patterns (eg. files, exclude)
    basePath: "..",

    // Disable module load timeout
    waitSeconds: 0,

    // frameworks to use
    // available frameworks: https://npmjs.org/browse/keyword/karma-adapter
    frameworks: ["jasmine", "detectBrowsers"],

    client: {
      captureConsole: false,
      jasmine: {
        random: false,
      },
    },

    detectBrowsers: {
      enabled: false,
      usePhantomJS: false,
    },

    // list of files / patterns to load in the browser
    files: [
      { pattern: "Specs/Data/**", included: false },
      { pattern: "Specs/TestWorkers/**/*.wasm", included: false },
      { pattern: "Build/CesiumUnminified/Cesium.js", included: true },
      { pattern: "Build/CesiumUnminified/Cesium.js.map", included: false },
      { pattern: "Build/CesiumUnminified/**", included: false },
      { pattern: "Build/Specs/karma-main.js", included: true, type: "module" },
      { pattern: "Build/Specs/TestWorkers/**", included: false },
      { pattern: "Build/Specs/SpecList.js", included: true, type: "module" },
    ],

    proxies: {
      "/Data": "/base/Specs/Data",
      "/Specs/TestWorkers": "/base/Specs/TestWorkers",
      "/Build/Specs/TestWorkers": "/base/Build/Specs/TestWorkers",
    },

    // list of files to exclude
    exclude: ["Specs/SpecList.js", "Specs/SpecRunner.js", "Specs/spec-main.js"],

    // preprocess matching files before serving them to the browser
    // available preprocessors: https://npmjs.org/browse/keyword/karma-preprocessor
    preprocessors: {
      "**/*.js": ["sourcemap"],
    },

    // test results reporter to use
    // possible values: 'dots', 'progress'
    // available reporters: https://npmjs.org/browse/keyword/karma-reporter
    reporters: ["spec", "longest"],
    longestSpecsToReport: 10,

    // web server port
    port: 9876,

    // enable / disable colors in the output (reporters and logs)
    colors: true,

    // level of logging
    // possible values: config.LOG_DISABLE || config.LOG_ERROR || config.LOG_WARN || config.LOG_INFO || config.LOG_DEBUG
    logLevel: config.LOG_ERROR,

    // enable / disable watching file and executing tests whenever any file changes
    autoWatch: false,

    // start these browsers
    // available browser launchers: https://npmjs.org/browse/keyword/karma-launcher

    //During CI, we need to run with the no-sandbox flag
    customLaunchers: {
      ChromeDebugging: {
        base: "Chrome",
        flags: ["--remote-debugging-port=9333"],
      },
      EdgeHeadlessCI: {
        // base "Chrome" (not "ChromeHeadless") so we control the flag set
        // fully: this Edge build only goes headless with --headless=new, and
        // needs an isolated --user-data-dir so it doesn't forward to a running
        // interactive Edge session and exit immediately.
        base: "Chrome",
        flags: [
          "--headless=new",
          "--no-sandbox",
          // NOT --disable-gpu: that disables the GPU process WebGPU requires, so
          // any real-GPUDevice WebGPU spec silently cannot run (the launcher
          // would only be usable for webglStub specs). Enable WebGPU instead —
          // this mirrors the Playwright probe args (channel msedge + headless).
          "--enable-unsafe-webgpu",
          "--disable-dev-shm-usage",
          `--user-data-dir=${os.tmpdir()}\\karma-edge-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
        ],
      },
    },

    // Ridiculous large values because CI can be slow.
    captureTimeout: 120000,
    browserDisconnectTolerance: 3,
    browserDisconnectTimeout: 120000,
    browserNoActivityTimeout: 120000,

    // Continuous Integration mode
    // if true, Karma captures browsers, runs the tests and exits
    singleRun: true,

    // Edge consolidates into a single process; concurrent launches collide.
    concurrency: 1,

    browsers: ["Chrome"],
  };

  config.set(options);
};
