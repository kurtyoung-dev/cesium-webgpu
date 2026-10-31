// landing-perf-metrics-inputs.mjs - shared in-memory inputs for the landing-perf-metrics specs.
// @purpose Builders of the raw startup record (makeRawStartupRecord) and the pass-cost result (makePassCostResult) that more than one landing-perf-metrics spec part feeds the PF metric functions.
// @status ACTIVE
//
// Moved verbatim out of landing-perf-metrics.spec.mjs when that spec was split by concern
// (row DX-KIT-LANDING-SPECS-OVER-SIZE); the startup and contention parts share the startup
// record, the frame-pass and contention parts share the pass-cost result.

export const makeRawStartupRecord = ({
  viewerReadyAtMs = 200,
  stagedAtMs = 300,
  firstFrameAtMs = 500,
  firstCloudFrameAtMs = 1200,
  tilesLoadedAtMs = 1800,
  outcome = "settled",
  compile = { shaderModules: { syncMs: 10, count: 1 } },
} = {}) => ({
  startup: {
    viewerReadyAtMs,
    stagedAtMs,
    firstFrameAtMs,
    firstCloudFrameAtMs,
    tilesLoadedAtMs,
    outcome,
  },
  compile,
});

export const makePassCostResult = ({
  available = true,
  enabled = true,
  reason,
  frameAvgMs = 10.0,
  frameCount = 60,
  passes = {},
  sampleLedgerBalanced = true,
  coverageRatio = 1.0,
} = {}) => ({
  available,
  enabled,
  reason,
  frameAvgMs,
  frameCount,
  passes,
  sampleLedgerBalanced,
  coverageRatio,
});
