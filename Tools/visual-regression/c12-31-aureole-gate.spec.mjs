import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import {
  C12_31_AUREOLE_ARTIFACT_PREFIX,
  C12_31_AUREOLE_CAPTURE_METHOD,
  C12_31_AUREOLE_DAY_ISO,
  C12_31_AUREOLE_DIAGNOSTICS_SCHEMA,
  C12_31_AUREOLE_MAX_SETTLE_FRAMES,
  C12_31_AUREOLE_NIGHT_ISO,
  C12_31_AUREOLE_PROVENANCE_KEYS,
  C12_31_AUREOLE_PUBLICATION_ORDER,
  C12_31_AUREOLE_RENDERERS,
  C12_31_AUREOLE_SCHEMA,
  C12_31_AUREOLE_SCOPE,
  C12_31_AUREOLE_SHOTS,
  C12_31_AUREOLE_SITE,
  C12_31_AUREOLE_SOURCE_KEYS,
  C12_31_AUREOLE_VIEWPORT,
  evaluateC1231Aureole,
  finalizeC1231AureoleReport,
  inspectAureolePng,
  requestedAureoleShotState,
  validateC1231AureoleFinalArtifact,
} from "./lib/c12-31-aureole-gate.mjs";
import {
  beginC1231AureoleEvidence,
  c1231AureoleEvidencePaths,
  finalizeC1231AureoleEvidence,
} from "./probe-sky-aureole-anchor.mjs";

const FIXED_RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(Buffer.concat([typeBytes, data])),
    8 + data.byteLength,
  );
  return chunk;
}

function encodeRgbaPng(pixels, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const scanlines = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const target = y * (stride + 1);
    scanlines[target] = 0;
    pixels.copy(scanlines, target + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function syntheticPixels(kind, width, height) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let code;
      if (kind === "toward") code = 110;
      else if (kind === "anti") code = 45;
      else if (kind === "left60")
        code = Math.round(20 + (120 * x) / (width - 1));
      else if (kind === "right60")
        code = Math.round(140 - (120 * x) / (width - 1));
      else code = 2;
      const offset = (y * width + x) * 4;
      pixels[offset] = code;
      pixels[offset + 1] = code;
      pixels[offset + 2] = code;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function makeFixture(
  kind,
  width = C12_31_AUREOLE_VIEWPORT.width,
  height = C12_31_AUREOLE_VIEWPORT.height,
) {
  const bytes = encodeRgbaPng(
    syntheticPixels(kind, width, height),
    width,
    height,
  );
  const inspected = inspectAureolePng(bytes);
  return { kind, bytes, inspected };
}

const FIXTURES = Object.fromEntries(
  C12_31_AUREOLE_SHOTS.map((shot) => [shot, makeFixture(shot)]),
);
for (const fixture of Object.values(FIXTURES)) {
  assert.equal(
    fixture.inspected.ok,
    true,
    fixture.inspected.reasons?.join("; "),
  );
}

function wgs84Frame() {
  const longitude = (C12_31_AUREOLE_SITE.longitudeDegrees * Math.PI) / 180;
  const latitude = (C12_31_AUREOLE_SITE.latitudeDegrees * Math.PI) / 180;
  const a = 6_378_137;
  const e2 = 6.6943799901413165e-3;
  const sinLat = Math.sin(latitude);
  const cosLat = Math.cos(latitude);
  const sinLon = Math.sin(longitude);
  const cosLon = Math.cos(longitude);
  const radius = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  const height = C12_31_AUREOLE_SITE.heightMeters;
  return {
    position: [
      (radius + height) * cosLat * cosLon,
      (radius + height) * cosLat * sinLon,
      (radius * (1 - e2) + height) * sinLat,
    ],
    east: [-sinLon, cosLon, 0],
    north: [-sinLat * cosLon, -sinLat * sinLon, cosLat],
    up: [cosLat * cosLon, cosLat * sinLon, sinLat],
  };
}

function localToFixed(local, frame) {
  return [0, 1, 2].map(
    (index) =>
      frame.east[index] * local[0] +
      frame.north[index] * local[1] +
      frame.up[index] * local[2],
  );
}

function dot(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function normalize(vector) {
  const magnitude = Math.hypot(...vector);
  return vector.map((value) => value / magnitude);
}

function sunAndCamera(shotId) {
  const frame = wgs84Frame();
  const night = shotId === "night";
  const azimuth = night ? 90 : 180;
  const elevation = night ? -15 : 45;
  const azimuthRadians = (azimuth * Math.PI) / 180;
  const elevationRadians = (elevation * Math.PI) / 180;
  const local = [
    Math.sin(azimuthRadians) * Math.cos(elevationRadians),
    Math.cos(azimuthRadians) * Math.cos(elevationRadians),
    Math.sin(elevationRadians),
  ];
  const initialDirection = localToFixed(local, frame);
  const fixed = frame.position.map(
    (value, index) => value + initialDirection[index] * 100_000_000_000,
  );
  const direction = normalize(
    fixed.map((value, index) => value - frame.position[index]),
  );
  const resolvedLocal = [
    dot(direction, frame.east),
    dot(direction, frame.north),
    dot(direction, frame.up),
  ];
  const resolvedAzimuth =
    ((Math.atan2(resolvedLocal[0], resolvedLocal[1]) * 180) / Math.PI + 360) %
    360;
  const resolvedElevation = (Math.asin(resolvedLocal[2]) * 180) / Math.PI;
  const offsets = { toward: 0, left60: -60, right60: 60, anti: 180, night: 0 };
  const heading = (resolvedAzimuth + offsets[shotId] + 360) % 360;
  const headingRadians = (heading * Math.PI) / 180;
  const pitchRadians = (32 * Math.PI) / 180;
  const directionLocal = [
    Math.sin(headingRadians) * Math.cos(pitchRadians),
    Math.cos(headingRadians) * Math.cos(pitchRadians),
    Math.sin(pitchRadians),
  ];
  const rightLocal = [Math.cos(headingRadians), -Math.sin(headingRadians), 0];
  const upLocal = [
    rightLocal[1] * directionLocal[2],
    -rightLocal[0] * directionLocal[2],
    rightLocal[0] * directionLocal[1] - rightLocal[1] * directionLocal[0],
  ];
  return {
    camera: {
      positionWC: frame.position,
      directionWC: localToFixed(directionLocal, frame),
      upWC: localToFixed(upLocal, frame),
      rightWC: localToFixed(rightLocal, frame),
      headingDegrees: heading,
      pitchDegrees: 32,
      rollDegrees: 0,
    },
    sunFrame: {
      inertialWC: fixed,
      icrfToFixedMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      fixedWC: fixed,
      directionWC: direction,
      localENU: resolvedLocal,
      azimuthDegrees: resolvedAzimuth,
      elevationDegrees: resolvedElevation,
    },
  };
}

function fingerprint(seed, file = `${seed}.js`) {
  const bytes = Buffer.from(seed.repeat(8));
  return {
    file,
    exists: true,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function shotFixture(shotId, failing) {
  return failing && shotId !== "night" ? FIXTURES.anti : FIXTURES[shotId];
}

function makeShot(runId, renderer, shotId, failing = false) {
  const requestedState = requestedAureoleShotState(shotId);
  const frame = sunAndCamera(shotId);
  const timeIso =
    shotId === "night" ? C12_31_AUREOLE_NIGHT_ISO : C12_31_AUREOLE_DAY_ISO;
  const fixture = shotFixture(shotId, failing);
  const file = `${C12_31_AUREOLE_ARTIFACT_PREFIX}.${runId}.${renderer}.${shotId}.png`;
  return {
    id: shotId,
    requestedState,
    observedState: {
      timeIso,
      clock: {
        currentTimeIso: timeIso,
        startTimeIso: timeIso,
        stopTimeIso: timeIso,
        shouldAnimate: false,
        multiplier: 0,
      },
      ...frame,
      scene: structuredClone(requestedState.scene),
    },
    readiness: {
      bounded: true,
      maximumFrames: C12_31_AUREOLE_MAX_SETTLE_FRAMES,
      frames: 4,
      settled: true,
      globeTilesLoaded: true,
      icrfToFixedResolved: true,
      transformMethod: "Transforms.computeIcrfToFixedMatrix",
      ecefFallbackUsed: false,
    },
    drawWitness: {
      armedBeforeCapture: true,
      ownerIsSkyAtmosphere: true,
      commandIsEnvironmentSkyAtmosphere: true,
      skyAtmosphereVisible: true,
      // The three frame numbers agree because the render, the toDataURL that
      // read its pixels, and the seal all ran in one synchronous task. A
      // witness where they disagree is bound to a frame other than the one the
      // PNG shows, which is the defect this shape exists to make visible.
      snapshotFrameNumber: 42,
      executedFrameNumber: 42,
      postToDataUrlFrameNumber: 42,
      executionCountAtSnapshot: 1,
      witnessSealedBeforeDecode: true,
      executeRestoredBeforeDecode: true,
    },
    image: {
      file,
      pngProof: structuredClone(fixture.inspected.proof),
      immutableFile: {
        file,
        exists: true,
        byteLength: fixture.bytes.byteLength,
        sha256: sha256(fixture.bytes),
        linkCount: 1,
      },
      captureSha256: sha256(fixture.bytes),
      captureByteLength: fixture.bytes.byteLength,
      scoredSha256: sha256(fixture.bytes),
      scoredByteLength: fixture.bytes.byteLength,
      singleCapture: true,
    },
    metrics: structuredClone(fixture.inspected.metrics),
  };
}

function makeReport(runId = FIXED_RUN_ID, { failing = false } = {}) {
  const filesAtStart = Object.fromEntries(
    C12_31_AUREOLE_PROVENANCE_KEYS.map((key) => [key, fingerprint(key)]),
  );
  const buildEntry = filesAtStart.buildEntry;
  return finalizeC1231AureoleReport({
    schema: C12_31_AUREOLE_SCHEMA,
    scope: C12_31_AUREOLE_SCOPE,
    runId,
    captureMethod: C12_31_AUREOLE_CAPTURE_METHOD,
    viewport: { ...C12_31_AUREOLE_VIEWPORT },
    sessions: C12_31_AUREOLE_RENDERERS.map((renderer) => ({
      requestedRenderer: renderer,
      observedRenderer: renderer,
      rendererTruth: true,
      errorGate: {
        armedBeforeNavigation: true,
        consoleListenerArmed: true,
        pageErrorListenerArmed: true,
        runtimeErrorListenerArmed: true,
        unhandledRejectionListenerArmed: true,
        gpuErrorScopesArmed: renderer === "webgpu" ? true : null,
        uncapturedErrorListenerArmed: renderer === "webgpu" ? true : null,
        deviceLossListenerArmed: renderer === "webgpu" ? true : null,
      },
      consoleErrors: [],
      pageErrors: [],
      runtimeErrors: [],
      unhandledRejections: [],
      gpuErrors: [],
      deviceLosses: [],
      gpuCompletion: {
        method:
          renderer === "webgpu"
            ? "GPUQueue.onSubmittedWorkDone"
            : "WebGLRenderingContext.finish",
        complete: true,
        afterLastCapture: true,
        lateErrorTurns: 2,
      },
      shots: C12_31_AUREOLE_SHOTS.map((shotId) =>
        makeShot(runId, renderer, shotId, failing),
      ),
    })),
    provenance: {
      filesAtStart,
      filesAtEnd: structuredClone(filesAtStart),
      buildSourceIdentity: {
        ok: true,
        entries: C12_31_AUREOLE_SOURCE_KEYS.map((key) => ({
          key,
          exact: true,
          currentByteLength: filesAtStart[key].byteLength,
          embeddedByteLength: filesAtStart[key].byteLength,
          currentSha256: filesAtStart[key].sha256,
          embeddedSha256: filesAtStart[key].sha256,
        })),
        reasons: [],
      },
      servedEntries: C12_31_AUREOLE_RENDERERS.map((renderer) => ({
        requestedRenderer: renderer,
        observedRenderer: renderer,
        status: 200,
        byteLength: buildEntry.byteLength,
        sha256: buildEntry.sha256,
        consumedRuntime: {
          observedByBrowser: true,
          url: "http://localhost:8080/Build/CesiumUnminified/index.js",
          origin: "http://localhost:8080/",
          status: 200,
          fromServiceWorker: false,
          byteLength: buildEntry.byteLength,
          sha256: buildEntry.sha256,
        },
        externalRequests: [],
        externalResponsesSucceeded: [],
      })),
      stable: true,
    },
    lifecycle: {
      lockOwned: true,
      runningAuthority: true,
      predecessorStable: true,
      firstRedStable: true,
      pngsImmutable: true,
      foreignSuccessorPreserved: true,
      publicationOrder: [...C12_31_AUREOLE_PUBLICATION_ORDER],
    },
  });
}

function mutateReport(mutator) {
  const report = structuredClone(makeReport());
  mutator(report);
  // Re-fold before handing the mutant back. makeReport() bakes status,
  // exitCode and diagnostics through finalizeC1231AureoleReport, so a clone
  // still carries the PRE-mutation verdict; a control that reads
  // `report.status` off an unfolded clone asserts the fixture's verdict rather
  // than the mutant's and would hold no matter what the mutator did.
  // evaluateC1231Aureole reads none of status/exitCode/incomplete/diagnostics,
  // so re-folding leaves every assertNotPass mutant's evaluation unchanged.
  return finalizeC1231AureoleReport(report);
}

function assertNotPass(report, pattern, label) {
  const evaluation = evaluateC1231Aureole(report);
  const where = label ? ` [${label}]` : "";
  assert.notEqual(evaluation.status, "PASS", `mutant still passed${where}`);
  if (pattern) {
    assert.match(
      [
        ...evaluation.structuralReasons,
        ...evaluation.failedPredicates,
        ...evaluation.errors,
        ...evaluation.unscored,
      ].join("\n"),
      pattern,
      `mutant failed for the wrong reason${where}`,
    );
  }
}

function writeReportPngs(directory, report) {
  for (const session of report.sessions) {
    for (const shot of session.shots) {
      const fixture = Object.values(FIXTURES).find(
        (candidate) =>
          candidate.inspected.proof.sha256 === shot.image.pngProof.sha256,
      );
      assert.ok(fixture, `fixture for ${session.requestedRenderer}/${shot.id}`);
      fs.writeFileSync(path.join(directory, shot.image.file), fixture.bytes, {
        flag: "wx",
      });
    }
  }
}

test("baseline certifies only the exact C12-31 L1-L4 WebGL+WebGPU matrix", () => {
  const report = makeReport();
  // The reasons travel with the assertion: a baseline that reports only
  // "STRUCTURAL" tells the next reader that the fixture stopped satisfying the
  // gate but not which predicate went unfed, which is the whole diagnosis.
  assert.equal(
    report.status,
    "PASS",
    `baseline is not PASS.
  structural: ${JSON.stringify(report.diagnostics?.structuralReasons ?? null)}
  failed:     ${JSON.stringify(report.diagnostics?.failedPredicates ?? null)}
  errors:     ${JSON.stringify(report.diagnostics?.errors ?? null)}
  unscored:   ${JSON.stringify(report.diagnostics?.unscored ?? null)}`,
  );
  assert.equal(report.exitCode, 0);
  assert.equal(report.incomplete, false);
  assert.equal(report.diagnostics.schema, C12_31_AUREOLE_DIAGNOSTICS_SCHEMA);
  assert.deepEqual(report.diagnostics.structuralReasons, []);
  assert.deepEqual(report.diagnostics.failedPredicates, []);
  assert.deepEqual(report.diagnostics.errors, []);
  assert.deepEqual(report.diagnostics.unscored, []);
  assert.deepEqual(validateC1231AureoleFinalArtifact(report), {
    ok: true,
    reasons: [],
    evaluation: evaluateC1231Aureole(report),
  });
});

test("empty, one-sided, duplicate, reversed, and extra backend sets fail", () => {
  const mutations = [
    (report) => (report.sessions = []),
    (report) => report.sessions.pop(),
    (report) => report.sessions.push(structuredClone(report.sessions[0])),
    (report) => report.sessions.reverse(),
    (report) =>
      report.sessions.push({ requestedRenderer: "software", shots: [] }),
  ];
  for (const mutation of mutations) {
    assertNotPass(mutateReport(mutation), /WebGL\+WebGPU|renderer session/iu);
  }
});

test("renderer fallback and wrong observed state fail closed", () => {
  assertNotPass(
    mutateReport((report) => {
      report.sessions[1].observedRenderer = "webgl";
      report.sessions[1].rendererTruth = false;
    }),
    /renderer truth/u,
  );
  assertNotPass(
    mutateReport((report) => {
      report.sessions[0].shots[0].observedState.clock.currentTimeIso =
        C12_31_AUREOLE_NIGHT_ISO;
    }),
    /pinned clock/u,
  );
  assertNotPass(
    mutateReport((report) => {
      report.sessions[0].shots[0].observedState.camera.positionWC[0] += 1;
    }),
    /WGS84 site/u,
  );
  assertNotPass(
    mutateReport((report) => {
      report.sessions[0].shots[0].observedState.scene.highDynamicRange = true;
    }),
    /isolation\/HDR\/effects/u,
  );
});

test("missing, duplicate, reordered, and extra shots fail closed", () => {
  const mutations = [
    (report) => report.sessions[0].shots.pop(),
    (report) =>
      report.sessions[0].shots.push(
        structuredClone(report.sessions[0].shots[0]),
      ),
    (report) => report.sessions[0].shots.reverse(),
    (report) => report.sessions[0].shots.push({ id: "zenith" }),
  ];
  for (const mutation of mutations) {
    assertNotPass(mutateReport(mutation), /shot set|exact shot/iu);
  }
  assert.doesNotThrow(() =>
    assertNotPass(
      mutateReport((report) => {
        report.sessions[0].shots = null;
      }),
      /shot set|exact shot/iu,
    ),
  );
});

test("false readiness and unresolved/fallback Earth transform fail", () => {
  for (const mutation of [
    (shot) => (shot.readiness.settled = false),
    (shot) => (shot.readiness.globeTilesLoaded = false),
    (shot) => (shot.readiness.icrfToFixedResolved = false),
    (shot) => (shot.readiness.ecefFallbackUsed = true),
    (shot) => (shot.readiness.frames = C12_31_AUREOLE_MAX_SETTLE_FRAMES + 1),
  ]) {
    assertNotPass(
      mutateReport((report) => mutation(report.sessions[0].shots[0])),
      /readiness\/ICRF/u,
    );
  }
});

test("a coordinated non-rigid Sun transform cannot masquerade as ICRF", () => {
  assertNotPass(
    mutateReport((report) => {
      const shot = report.sessions[0].shots[0];
      shot.observedState.sunFrame.icrfToFixedMatrix[0] = 2;
      shot.observedState.sunFrame.fixedWC[0] =
        2 * shot.observedState.sunFrame.inertialWC[0];
    }),
    /proper orthonormal transform/u,
  );
});

test("missing and stale sky draw witnesses fail", () => {
  // One mutant per leg of the witness. The three frame-number mutants are the
  // load-bearing ones: each is a distinct way for the witness to describe a
  // frame other than the one whose pixels were scored.
  for (const mutation of [
    (draw) => (draw.armedBeforeCapture = false),
    (draw) => (draw.ownerIsSkyAtmosphere = false),
    (draw) => (draw.commandIsEnvironmentSkyAtmosphere = false),
    (draw) => (draw.skyAtmosphereVisible = false),
    (draw) => (draw.executionCountAtSnapshot = 0),
    (draw) => (draw.executionCountAtSnapshot = null),
    (draw) => (draw.executionCountAtSnapshot = 1.5),
    // The sky command executed on an EARLIER frame than the one captured.
    (draw) => (draw.executedFrameNumber = 41),
    // ...and on a LATER one, the direction a witness bound to a post-decode
    // frame would drift.
    (draw) => (draw.executedFrameNumber = 43),
    // The frame advanced across toDataURL, so the pixels and the witness are
    // from different frames even though the command did execute.
    (draw) => (draw.postToDataUrlFrameNumber = 43),
    (draw) => (draw.postToDataUrlFrameNumber = null),
    (draw) => (draw.snapshotFrameNumber = 0),
    (draw) => (draw.snapshotFrameNumber = null),
    (draw) => (draw.snapshotFrameNumber = 42.5),
    // The witness was still mutable while the PNG decoded, so a later frame
    // could have overwritten it.
    (draw) => (draw.witnessSealedBeforeDecode = false),
    // The execute wrapper was still installed during decode.
    (draw) => (draw.executeRestoredBeforeDecode = false),
    (draw) => delete draw.snapshotFrameNumber,
    (draw) => delete draw.witnessSealedBeforeDecode,
  ]) {
    assertNotPass(
      mutateReport((report) =>
        mutation(report.sessions[0].shots[0].drawWitness),
      ),
      /draw-command witness/u,
    );
  }
});

test("a coherently shifted witness cannot pass by moving every frame together", () => {
  // The negative control for the mutants above: shifting all three frame
  // numbers in lockstep keeps the witness self-consistent, so the gate must
  // accept it — the rule is "the three agree", not "the three equal 42". If
  // this went red the mutants would be passing for the wrong reason.
  const report = mutateReport((r) => {
    const draw = r.sessions[0].shots[0].drawWitness;
    draw.snapshotFrameNumber = 907;
    draw.executedFrameNumber = 907;
    draw.postToDataUrlFrameNumber = 907;
  });
  // mutateReport re-folds, so these read the MUTANT verdict, not the
  // fixture verdict baked in by makeReport.
  assert.equal(report.status, "PASS");
  assert.deepEqual(report.diagnostics.structuralReasons, []);
  assert.deepEqual(report.diagnostics.failedPredicates, []);
  assert.deepEqual(report.diagnostics.errors, []);
  assert.deepEqual(report.diagnostics.unscored, []);
});

test("black/vacuous day, NaN metrics, and lost anchoring predicates cannot pass", () => {
  assertNotPass(
    mutateReport((report) => {
      for (const shot of report.sessions[0].shots.slice(0, 4)) {
        Object.assign(shot.metrics, {
          mean: 0,
          peak: 0,
          luminanceWeight: 0,
          nonBlackPixels: 0,
        });
      }
    }),
    /vacuous/u,
  );
  assertNotPass(
    mutateReport((report) => {
      report.sessions[0].shots[0].metrics.mean = Number.NaN;
    }),
    /nonfinite|invalid/u,
  );
  const failing = makeReport(FIXED_RUN_ID, { failing: true });
  assert.equal(failing.status, "FAIL");
  assert.match(failing.diagnostics.failedPredicates.join("\n"), /L1|L2/u);
});

test("score-first/save-second and stale/missing image substitutions fail", () => {
  assertNotPass(
    mutateReport((report) => {
      report.sessions[0].shots[0].image.captureSha256 = "0".repeat(64);
    }),
    /one persisted capture/u,
  );
  assertNotPass(
    mutateReport((report) => {
      report.sessions[0].shots[0].image.scoredByteLength++;
    }),
    /one persisted capture/u,
  );
  assertNotPass(
    mutateReport((report) => {
      report.sessions[0].shots[0].image.file = "stale.png";
    }),
    /UUID PNG filename/u,
  );
  assertNotPass(
    mutateReport((report) => {
      report.sessions[0].shots[0].image.pngProof.crcValid = false;
    }),
    /strict PNG/u,
  );
});

test("strict PNG parser rejects corrupt CRC, zlib/truncation, dimensions, and trailing bytes", () => {
  const baseline = FIXTURES.toward.bytes;
  const corruptCrc = Buffer.from(baseline);
  corruptCrc[corruptCrc.byteLength - 5] ^= 1;
  assert.equal(inspectAureolePng(corruptCrc).ok, false);
  const corruptIdat = Buffer.from(baseline);
  const idat = corruptIdat.indexOf(Buffer.from("IDAT"));
  corruptIdat[idat + 8] ^= 0xff;
  assert.equal(inspectAureolePng(corruptIdat).ok, false);
  assert.equal(inspectAureolePng(baseline.subarray(0, -3)).ok, false);
  assert.equal(makeFixture("toward", 32, 32).inspected.ok, false);
  assert.equal(
    inspectAureolePng(Buffer.concat([baseline, Buffer.from("foreign")])).ok,
    false,
  );
});

test("unarmed gates, late device errors, and incomplete GPU completion fail", () => {
  assertNotPass(
    mutateReport((report) => {
      report.sessions[1].errorGate.deviceLossListenerArmed = false;
    }),
    /error gate/u,
  );
  const late = mutateReport((report) => {
    report.sessions[1].deviceLosses.push("destroyed after final capture");
  });
  assert.equal(evaluateC1231Aureole(late).status, "ERROR");
  assert.match(evaluateC1231Aureole(late).errors.join("\n"), /deviceLosses/u);
  assertNotPass(
    mutateReport((report) => {
      report.sessions[0].gpuCompletion.complete = false;
    }),
    /GPU completion/u,
  );
});

test("stale local, build, and served bytes each fail provenance", () => {
  assertNotPass(
    mutateReport((report) => {
      report.provenance.filesAtEnd.probe.sha256 = "1".repeat(64);
    }),
    /local bytes changed/u,
  );
  assertNotPass(
    mutateReport((report) => {
      report.provenance.buildSourceIdentity.entries[0].embeddedSha256 =
        "2".repeat(64);
    }),
    /stale local\/build/u,
  );
  assertNotPass(
    mutateReport((report) => {
      report.provenance.servedEntries[1].sha256 = "3".repeat(64);
    }),
    /stale or mismatched served/u,
  );
});

test("the bytes the browser actually ran are bound, not just the served ones", () => {
  // The defect this replaces: a probe-side fetch of the runtime URL agreed with
  // the build entry while the page could have executed something else. Each
  // mutant below keeps the SERVED identity perfect and corrupts only what the
  // browser consumed, so it can only be caught by the consumed-bytes binding.
  for (const [label, mutation] of [
    ["different bytes", (consumed) => (consumed.sha256 = "4".repeat(64))],
    [
      "different length",
      (consumed) => (consumed.byteLength = consumed.byteLength + 1),
    ],
    ["never observed", (consumed) => (consumed.observedByBrowser = false)],
    ["served by a worker", (consumed) => (consumed.fromServiceWorker = true)],
    ["non-200", (consumed) => (consumed.status = 304)],
    [
      "off-origin",
      (consumed) =>
        (consumed.url =
          "http://cdn.example.com/Build/CesiumUnminified/index.js"),
    ],
    [
      "different path",
      (consumed) =>
        (consumed.url = "http://localhost:8080/Build/Cesium/index.js"),
    ],
    [
      "credentialed origin",
      (consumed) => (consumed.origin = "http://user:pw@localhost:8080/"),
    ],
    ["absent", (consumed) => delete consumed.sha256],
  ]) {
    assertNotPass(
      mutateReport((report) =>
        mutation(report.provenance.servedEntries[1].consumedRuntime),
      ),
      /browser-consumed runtime bytes are unbound/u,
      label,
    );
  }
});

test("an offline lane that reached the network fails", () => {
  // Attempts are recorded but not themselves disqualifying — a blocked request
  // is the offline gate working. A SUCCEEDED external response is not.
  assertNotPass(
    mutateReport((report) => {
      report.provenance.servedEntries[0].externalResponsesSucceeded.push(
        "200 https://tile.example.com/1/2/3.png",
      );
    }),
    /external transport succeeded/u,
  );
  for (const mutation of [
    (entry) => delete entry.externalRequests,
    (entry) => (entry.externalResponsesSucceeded = null),
    (entry) => (entry.externalRequests = new Array(129).fill("x")),
  ]) {
    assertNotPass(
      mutateReport((report) => mutation(report.provenance.servedEntries[0])),
      /external transport diagnostics are absent or unbounded/u,
    );
  }
  // The negative control: a blocked external ATTEMPT with nothing succeeding
  // is exactly what a working offline lane looks like, and must still pass.
  const blocked = mutateReport((report) => {
    report.provenance.servedEntries[0].externalRequests.push(
      "https://tile.example.com/1/2/3.png",
    );
  });
  // mutateReport re-folds, so these read the MUTANT verdict, not the
  // fixture verdict baked in by makeReport.
  assert.equal(blocked.status, "PASS");
  assert.deepEqual(blocked.diagnostics.structuralReasons, []);
  assert.deepEqual(blocked.diagnostics.failedPredicates, []);
  assert.deepEqual(blocked.diagnostics.errors, []);
  assert.deepEqual(blocked.diagnostics.unscored, []);
});

test("full-C12-31 scope claims and incomplete/forged finals are rejected", () => {
  assertNotPass(
    mutateReport((report) => {
      report.scope = "full C12-31";
    }),
    /L1-L4 core only/u,
  );
  const report = makeReport();
  report.incomplete = true;
  report.status = "PASS";
  assert.equal(validateC1231AureoleFinalArtifact(report).ok, false);
  report.incomplete = false;
  report.diagnostics.errors.push("laundered");
  assert.equal(validateC1231AureoleFinalArtifact(report).ok, false);
});

test("PASS publication creates immutable UUID run and byte-identical latest", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c1231-pass-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runId = randomUUID();
  const state = beginC1231AureoleEvidence(directory, runId);
  const report = makeReport(runId);
  writeReportPngs(directory, report);
  const publication = finalizeC1231AureoleEvidence(state, report);
  const runBytes = fs.readFileSync(state.paths.run);
  assert.deepEqual(fs.readFileSync(state.paths.latest), runBytes);
  assert.equal(fs.existsSync(state.paths.firstRed), false);
  assert.equal(fs.existsSync(state.paths.lock), false);
  assert.equal(publication.immutableRun.sha256, publication.latest.sha256);
});

test("first-red is archive-backed and retained across later PASS and red runs", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c1231-red-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const firstRunId = randomUUID();
  const firstState = beginC1231AureoleEvidence(directory, firstRunId);
  const red = makeReport(firstRunId, { failing: true });
  assert.equal(red.status, "FAIL");
  writeReportPngs(directory, red);
  finalizeC1231AureoleEvidence(firstState, red);
  const firstRedBytes = fs.readFileSync(firstState.paths.firstRed);
  assert.deepEqual(firstRedBytes, fs.readFileSync(firstState.paths.run));

  const secondRunId = randomUUID();
  const secondState = beginC1231AureoleEvidence(directory, secondRunId);
  const pass = makeReport(secondRunId);
  writeReportPngs(directory, pass);
  finalizeC1231AureoleEvidence(secondState, pass);
  assert.deepEqual(fs.readFileSync(secondState.paths.firstRed), firstRedBytes);

  const thirdRunId = randomUUID();
  const thirdState = beginC1231AureoleEvidence(directory, thirdRunId);
  const laterRed = makeReport(thirdRunId, { failing: true });
  writeReportPngs(directory, laterRed);
  finalizeC1231AureoleEvidence(thirdState, laterRed);
  assert.deepEqual(fs.readFileSync(thirdState.paths.firstRed), firstRedBytes);
});

test("incomplete latest and immutable-run collisions retain fail-closed authority", (t) => {
  const incompleteDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c1231-incomplete-"),
  );
  const collisionDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c1231-collision-"),
  );
  t.after(() =>
    fs.rmSync(incompleteDirectory, { recursive: true, force: true }),
  );
  t.after(() =>
    fs.rmSync(collisionDirectory, { recursive: true, force: true }),
  );
  const incompletePaths = c1231AureoleEvidencePaths(
    incompleteDirectory,
    randomUUID(),
  );
  fs.writeFileSync(
    incompletePaths.latest,
    JSON.stringify({ status: "RUNNING", incomplete: true }),
  );
  assert.throws(
    () => beginC1231AureoleEvidence(incompleteDirectory, randomUUID()),
    /incomplete or invalid/u,
  );

  const runId = randomUUID();
  const state = beginC1231AureoleEvidence(collisionDirectory, runId);
  const report = makeReport(runId);
  writeReportPngs(collisionDirectory, report);
  fs.writeFileSync(state.paths.run, "foreign immutable run");
  assert.throws(() => finalizeC1231AureoleEvidence(state, report), /EEXIST/u);
  assert.deepEqual(fs.readFileSync(state.paths.latest), state.runningBytes);
  assert.equal(
    fs.readFileSync(state.paths.run, "utf8"),
    "foreign immutable run",
  );
});

test("absent latest publication race preserves the foreign winner", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c1231-begin-race-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runId = randomUUID();
  const paths = c1231AureoleEvidencePaths(directory, runId);
  const foreign = Buffer.from("foreign latest successor\n");
  let injected = false;
  const operations = new Proxy(fs, {
    get(target, property) {
      if (property === "writeFileSync") {
        return (file, bytes, options) => {
          if (!injected && file === paths.latest && options?.flag === "wx") {
            injected = true;
            fs.writeFileSync(file, foreign, { flag: "wx" });
          }
          return fs.writeFileSync(file, bytes, options);
        };
      }
      return Reflect.get(target, property);
    },
  });
  assert.throws(
    () => beginC1231AureoleEvidence(directory, runId, operations),
    /foreign owner won/u,
  );
  assert.deepEqual(fs.readFileSync(paths.latest), foreign);
});

test("final publication race restores the actual foreign successor", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c1231-final-race-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runId = randomUUID();
  const state = beginC1231AureoleEvidence(directory, runId);
  const report = makeReport(runId);
  writeReportPngs(directory, report);
  const foreign = Buffer.from("foreign finalized successor\n");
  let injected = false;
  const operations = new Proxy(fs, {
    get(target, property) {
      if (property === "renameSync") {
        return (source, destination) => {
          if (!injected && source === state.paths.latest) {
            injected = true;
            fs.writeFileSync(source, foreign);
          }
          return fs.renameSync(source, destination);
        };
      }
      return Reflect.get(target, property);
    },
  });
  assert.throws(
    () => finalizeC1231AureoleEvidence(state, report, operations),
    /foreign canonical owner/u,
  );
  assert.deepEqual(fs.readFileSync(state.paths.latest), foreign);
});

test("unlock race restores a foreign lock successor without deleting it", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c1231-lock-race-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runId = randomUUID();
  const state = beginC1231AureoleEvidence(directory, runId);
  const report = makeReport(runId);
  writeReportPngs(directory, report);
  const foreign = Buffer.from("foreign lock successor\n");
  let injected = false;
  const operations = new Proxy(fs, {
    get(target, property) {
      if (property === "renameSync") {
        return (source, destination) => {
          if (!injected && source === state.paths.lock) {
            injected = true;
            fs.writeFileSync(source, foreign);
          }
          return fs.renameSync(source, destination);
        };
      }
      return Reflect.get(target, property);
    },
  });
  assert.throws(
    () => finalizeC1231AureoleEvidence(state, report, operations),
    /foreign lock successor/u,
  );
  assert.deepEqual(fs.readFileSync(state.paths.lock), foreign);
});

test("publication re-decodes every UUID PNG and rejects stale/corrupt bytes", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c1231-png-race-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runId = randomUUID();
  const state = beginC1231AureoleEvidence(directory, runId);
  const report = makeReport(runId);
  writeReportPngs(directory, report);
  const firstImage = path.join(
    directory,
    report.sessions[0].shots[0].image.file,
  );
  fs.writeFileSync(firstImage, "stale PNG bytes");
  assert.throws(
    () => finalizeC1231AureoleEvidence(state, report),
    /persisted PNG became invalid/u,
  );
  assert.deepEqual(fs.readFileSync(state.paths.latest), state.runningBytes);
});

test("a PNG substitution after final latest publication rolls latest back to RUNNING", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "c1231-png-release-race-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runId = randomUUID();
  const state = beginC1231AureoleEvidence(directory, runId);
  const report = makeReport(runId);
  writeReportPngs(directory, report);
  const firstImage = path.join(
    directory,
    report.sessions[0].shots[0].image.file,
  );
  let reads = 0;
  const operations = new Proxy(fs, {
    get(target, property) {
      if (property === "readFileSync") {
        return (file, ...args) => {
          if (file === firstImage && ++reads === 8) {
            fs.writeFileSync(firstImage, "late foreign PNG bytes");
          }
          return fs.readFileSync(file, ...args);
        };
      }
      return Reflect.get(target, property);
    },
  });
  assert.throws(
    () => finalizeC1231AureoleEvidence(state, report, operations),
    /post-final authority failed/u,
  );
  assert.deepEqual(fs.readFileSync(state.paths.latest), state.runningBytes);
  assert.equal(fs.existsSync(state.paths.lock), true);
});

test("probe source pins offline viewer, one-shot capture, exact truth, and hard exits", () => {
  const source = fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "probe-sky-aureole-anchor.mjs",
    ),
    "utf8",
  );
  assert.match(source, /renderer=\$\{renderer\}&offline=true/u);
  assert.match(source, /rendererType\s*!==\s*backend/u);
  // One-shot capture: exactly one call site, so no path can score a second,
  // later frame than the one the witness was sealed against.
  assert.equal(
    (source.match(/fused\.captureSnapshot\(/gu) ?? []).length,
    1,
    "the probe must capture exactly once",
  );
  assert.match(source, /await fused\.captureSnapshot\(\(sealed\)\s*=>/u);
  // The seal ordering IS the witness proof, so it is pinned in source: the
  // snapshot frame and the post-toDataURL frame are both read before the
  // callback fires, and the callback fires before the decode await.
  assert.match(
    source,
    /const snapshotFrameNumber = scene\.frameState\.frameNumber;[\s\S]{0,200}?toDataURL[\s\S]{0,200}?const postToDataUrlFrameNumber = scene\.frameState\.frameNumber;[\s\S]{0,200}?sealNow\([\s\S]{0,200}?await decode\(/u,
    "render -> toDataURL -> seal -> decode ordering is not pinned in the probe",
  );
  // The published witness must never be written from the live counters after
  // the seal; the live values stay in locals that the record cannot reach.
  assert.match(source, /let liveExecutionCount = 0;/u);
  assert.doesNotMatch(source, /drawWitness\.executionCountAtSnapshot\+\+/u);
  assert.doesNotMatch(source, /dataUrl:\s*capture\.grabNow\(\)/u);
  assert.match(source, /process\.exit\(1\)/u);
  assert.match(source, /foreign lock successor/u);
  // The source boundary the gate scores must be the one the probe actually
  // fingerprints: every key the gate requires has a real file behind it.
  for (const key of C12_31_AUREOLE_SOURCE_KEYS) {
    assert.match(
      source,
      new RegExp(`\\n\\s{2}${key}: path\\.join\\(`, "u"),
      `probe does not fingerprint source key ${key}`,
    );
  }
});
