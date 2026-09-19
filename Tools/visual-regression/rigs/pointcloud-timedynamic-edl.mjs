// Rig record for the wave-end scene "pointcloud-timedynamic-edl" (scenes.json), the source generateScenesJson() regenerates byte-identically.
//
// @purpose Rig record for the wave-end scene "pointcloud-timedynamic-edl" (scenes.json), the source generateScenesJson() regenerates byte-identically.
// @status ACTIVE

export default Object.freeze({
  id: "pointcloud-timedynamic-edl",
  tags: ["wave-end"],
  url: "http://localhost:8080/Apps/WebGPUTest/split-screen-comparison.html",
  renderers: ["webgl", "webgpu"],
  description:
    "VR-BASELINE-SCENES-VOXEL-POINTCLOUD-SPLAT (C18-V2) — TimeDynamicPointCloud on the DEDICATED renderer path (not the PNTS/Model path, where WebGPU attenuation and EDL are silently inert per PNTS-MODEL-PATH-EDL-INERT), driving attenuation (maximumAttenuation 10, pointSize 8) and eye-dome lighting (strength 1.0, radius 2.0) together. Frames are the in-tree Apps/SampleData PointCloudTimeDynamic .pnts set; the clock is pinned to the first interval so exactly one frame is ever resolved. Camera is a fixed pose on a hard-coded bounding sphere, because TimeDynamicPointCloud.boundingSphere lags the first render and framing from it would make the capture a function of load timing. EXPECTED MISMATCH: none, and that is a MEASURED correction of this scene's original RED prediction rather than a normalization — the threshold is still the suite default and was never widened; see expectedMismatch below for the numbers and for the gain the gate cannot see.",
  camera: null,
  clock: "2018-07-19T15:18:00Z",
  setupFile: "scenes/subsystem-parity-setup.js",
  setupParams: {
    subsystem: "pointcloud",
    sceneName: "pointcloud-timedynamic-edl",
    pinnedTimeIso: "2018-07-19T15:18:00Z",
  },
  viewport: {
    width: 1600,
    height: 800,
  },
  readiness: {
    kind: "settleFrames",
    frames: 30,
  },
  expectedMismatch: [
    {
      gate: "crossBackend",
      expect: "PASS",
      trackedBy: "PARITY-POINTCLOUD-COLOR-TINT",
      rationale:
        "CORRECTED after the first run measured 0.55% where this field predicted FAIL. The prediction was transcribed from the tint row without checking that the row's captures share this scene's configuration, and they do not. Measured offline from the run's own PNGs under the tint row's OWN raw-ds4 metric, this scene's per-channel WebGL/WebGPU gains are 0.996 / 0.996 / 0.996 with ds4 0.44% - the recorded 0.78 / 0.72 / 0.69 is absent, not merely under tolerance. Metric blindness is excluded by construction: replaying the row's gains onto this scene's actual pixels under the suite's tolerance-16 rule yields 3.19% (row gains) and 3.51% (the gains measured on the tinted historical capture), both above the 2.00% ceiling, so this gate WOULD have caught the recorded tint. Of the four historical WebGPU point-cloud captures on disk only one carries the tint (probe-pc-edl EDL-off); the EDL-on leg of that same invocation and both probe-point-sprite legs are at gains ~1.00 against a WebGL reference that is invariant across all of them. PASS is therefore a falsifiable prediction: a red here at or above 2% is the tint appearing and is a finding to file against the row, never a threshold to widen. KNOWN SENSITIVITY FLOOR: this gate stops seeing a uniform gain at about 0.80 (0.78 scores 2.04%, 0.90 scores 0.49%), so a weakened tint can pass it - closing that needs a per-channel gain assertion, not a tighter pixel ceiling. The row stays OPEN: its EDL-off configuration is unmeasured at HEAD and its format-decode defects are untouched by this scene.",
    },
  ],
  legacyOrder: 8,
  legacyExtraOrder: ["setupFile", "setupParams"],
});
