// @purpose Guards lib/cloud-u2-perf-evidence.mjs manifest assessment for C13-16 U2 perf evidence (no-regression / unchanged pass expectations, lane shapes).
// @status ACTIVE

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLOUD_U2_MANIFEST_VERSION,
  assessCloudU2PerfManifests,
  cloudU2ManifestFilename,
} from "./lib/cloud-u2-perf-evidence.mjs";

const EXPECT = {
  "ProceduralClouds pass": "no-regression",
  "CloudTemporalResolve pass": "unchanged",
};

function lane(genus, options = {}) {
  const suffix = genus === "cumulus" ? "c" : "i";
  const cloudCells = options.cloudCells ?? 5000;
  return {
    id: `${genus}-baked-straight`,
    routeId: "baked-straight",
    genus: {
      id: genus,
      value: genus === "cumulus" ? 0 : 1,
      expectedUniformRow:
        genus === "cumulus" ? [0, 1, 0, 0] : [0.6, 9, 0.9, 0.12],
    },
    volumetric: { cloudType: genus === "cumulus" ? 0 : 1 },
    camera: { lon: -95, lat: 39 },
    clock: { iso: "2026-06-21T18:20:00Z", stepSeconds: 0 },
    requireBakedDensity: true,
    expect: EXPECT,
    valid: options.valid ?? true,
    occupancy: options.occupancy ?? { ok: true, reason: null },
    genusUniformRow: genus === "cumulus" ? [0, 1, 0, 0] : [0.6, 9, 0.9, 0.12],
    genusRowMatches: options.genusRowMatches ?? true,
    fingerprint: {
      cloudCells,
      meanLum: options.meanLum ?? (genus === "cirrus" ? 8 : 85),
      pixelSha256: options.pixelSha256 ?? `pixels-${suffix}`,
    },
    // A lane that failed its structural gates never measured; faithful
    // fixtures therefore carry no timing for an invalid capture.
    passes:
      options.valid === false
        ? {}
        : {
            "ProceduralClouds pass": {
              medianAvgMs: options.cloudMs ?? 1,
            },
            "CloudTemporalResolve pass": {
              medianAvgMs: options.controlMs ?? 0.2,
            },
          },
  };
}

function manifest(tag, round, order, options = {}) {
  const post = tag === "post";
  const cloudScale = options.cloudScale ?? (post ? 1.01 : 1);
  const controlScale = options.controlScale ?? 1;
  const cumulusPixels = options.cumulusPixels ?? "pixels-c";
  return {
    manifestVersion: CLOUD_U2_MANIFEST_VERSION,
    tag,
    pairId: options.pairId ?? "u2-test",
    round,
    order,
    source: {
      runtimeBundle: {
        sha256: options.sha ?? (tag === "pre" ? "pre-bundle" : "post-bundle"),
      },
    },
    environment: {
      browserVersion: "Edge 1",
      adapterInfo: { vendor: "test" },
      canvas: { width: 1024, height: 768 },
      viewport: { width: 1024, height: 768 },
    },
    measurement: {
      kind: "webgpu-timestamp-query-per-pass",
      repeats: 5,
      occupancyMinCells: 3000,
      cirrusMinMeanLum: 2,
      acceptanceLaneIds: ["cumulus-baked-straight", "cirrus-baked-straight"],
      selectedLaneIds: ["cumulus-baked-straight", "cirrus-baked-straight"],
    },
    lanes: [
      lane("cumulus", {
        cloudMs: 1 * cloudScale,
        controlMs: 0.2 * controlScale,
        pixelSha256: cumulusPixels,
        ...(options.cumulus ?? {}),
      }),
      lane("cirrus", {
        cloudMs: 1.2 * cloudScale,
        controlMs: 0.2 * controlScale,
        cloudCells: options.cirrusCells ?? 5000,
        ...(options.cirrus ?? {}),
      }),
    ],
  };
}

function completeCampaign(options = {}) {
  return [
    manifest("pre", 0, "pre-first", options.pre0),
    manifest("post", 0, "pre-first", options.post0),
    manifest("post", 1, "post-first", options.post1),
    manifest("pre", 1, "post-first", options.pre1),
  ];
}

test("immutable manifest names include round, order, and tag", () => {
  assert.equal(
    cloudU2ManifestFilename({
      pairId: "c13-16",
      round: 2,
      order: "post-first",
      tag: "pre",
    }),
    "cloud-u2-c13-16-r2-post-first-pre.json",
  );
});

test("two stable reversed-order rounds pass", () => {
  const result = assessCloudU2PerfManifests({
    manifests: completeCampaign(),
  });
  assert.equal(result.status, "passed");
  assert.equal(result.complete, true);
  assert.equal(result.passed, true);
  assert.equal(result.rounds.length, 2);
  assert.ok(result.rounds.every((round) => round.usable));
});

test("one round is structurally incomplete", () => {
  const result = assessCloudU2PerfManifests({
    manifests: completeCampaign().slice(0, 2),
  });
  assert.equal(result.status, "incomplete-protocol");
  assert.equal(result.structural, true);
});

test("the first immutable leg is collecting, not a bundle mismatch", () => {
  const result = assessCloudU2PerfManifests({
    manifests: [manifest("pre", 0, "pre-first")],
  });
  assert.equal(result.status, "incomplete-protocol");
  assert.equal(result.bundleIdentity.stable, true);
  assert.equal(result.bundleIdentity.bothTagsPresent, false);
});

test("two rounds in one order do not satisfy reversal", () => {
  const manifests = completeCampaign();
  manifests[2].order = "pre-first";
  manifests[3].order = "pre-first";
  const result = assessCloudU2PerfManifests({ manifests });
  assert.equal(result.status, "incomplete-protocol");
  assert.match(result.failures.join("\n"), /pre-first and post-first/);
});

test("same pre and post bundle is rejected", () => {
  const manifests = completeCampaign();
  for (const record of manifests) {
    record.source.runtimeBundle.sha256 = "same";
  }
  const result = assessCloudU2PerfManifests({ manifests });
  assert.equal(result.status, "incomparable-bundles");
  assert.equal(result.bundleIdentity.distinct, false);
});

test("rebuilding one tag between rounds is rejected", () => {
  const result = assessCloudU2PerfManifests({
    manifests: completeCampaign({
      post1: { sha: "post-bundle-2" },
    }),
  });
  assert.equal(result.status, "incomparable-bundles");
  assert.equal(result.bundleIdentity.stable, false);
});

test("an untouched-control move discards its round", () => {
  const result = assessCloudU2PerfManifests({
    manifests: completeCampaign({
      post1: { controlScale: 3 },
    }),
  });
  assert.equal(result.status, "incomplete-protocol");
  assert.equal(result.rounds[1].controlDrifted, true);
  assert.equal(result.rounds[1].usable, false);
});

test("a drift-discarded round cannot create a product regression", () => {
  const manifests = [
    ...completeCampaign(),
    manifest("pre", 2, "pre-first"),
    manifest("post", 2, "pre-first", {
      cloudScale: 1.5,
      controlScale: 3,
    }),
  ];
  const result = assessCloudU2PerfManifests({ manifests });
  assert.equal(result.rounds[2].controlDrifted, true);
  assert.equal(result.status, "passed");
});

test("an affected pass above +2 percent is a product regression", () => {
  const result = assessCloudU2PerfManifests({
    manifests: completeCampaign({
      post0: { cloudScale: 1.03 },
    }),
  });
  assert.equal(result.status, "regressed");
  assert.equal(result.structural, false);
  assert.match(result.failures.join("\n"), /3% > \+2%/);
});

test("CUMULUS pixel drift is a hard identity failure", () => {
  const result = assessCloudU2PerfManifests({
    manifests: completeCampaign({
      post0: { cumulusPixels: "changed" },
    }),
  });
  assert.equal(result.status, "cumulus-identity-failed");
  assert.match(result.failures.join("\n"), /CUMULUS pixels changed/);
});

test("CIRRUS below the luminance floor is structural", () => {
  const result = assessCloudU2PerfManifests({
    manifests: completeCampaign({
      post1: { cirrus: { meanLum: 1.9 } },
    }),
  });
  assert.equal(result.status, "incomplete-protocol");
  assert.match(result.failures.join("\n"), /CIRRUS subject is vacuous/);
});

test("the packed genus row is a structural lane proof", () => {
  const manifests = completeCampaign();
  manifests[1].lanes[1].genusRowMatches = false;
  const result = assessCloudU2PerfManifests({ manifests });
  assert.equal(result.status, "incomplete-protocol");
  assert.match(result.failures.join("\n"), /packed genus uniform row/);
});

test("a filtered subset cannot satisfy the full acceptance lane set", () => {
  const manifests = completeCampaign();
  for (const record of manifests) {
    record.measurement.acceptanceLaneIds.push("cirrus-shadow-single");
  }
  const result = assessCloudU2PerfManifests({ manifests });
  assert.equal(result.status, "incomplete-protocol");
  assert.match(result.failures.join("\n"), /full acceptance lane set/);
});

test("lane replay drift is structural", () => {
  const manifests = completeCampaign();
  manifests[1].lanes[0].volumetric.cloudCoverage = 0.8;
  const result = assessCloudU2PerfManifests({ manifests });
  assert.equal(result.status, "incomplete-protocol");
  assert.match(result.failures.join("\n"), /replay\/configuration differs/);
});

test("environment drift is rejected before timing interpretation", () => {
  const manifests = completeCampaign();
  manifests[3].environment.browserVersion = "Edge 2";
  const result = assessCloudU2PerfManifests({ manifests });
  assert.equal(result.status, "incomparable-environment");
});

// The r0 first-red evidence (pair b1108-u2) refuted the idea that cirrus
// vacuity is a bundle property: the genus renders under BOTH laws and the
// bright-cell census was simply blind to thin content. Validity is strict
// again on every lane, and the cirrus subject proves itself by mean
// luminance against the black background.

test("an invalid pre CIRRUS capture fails the round", () => {
  const invalidPre = {
    cirrus: {
      valid: false,
      cloudCells: 19,
      occupancy: { ok: false, reason: "scene-never-occupied" },
    },
  };
  const result = assessCloudU2PerfManifests({
    manifests: completeCampaign({ pre0: invalidPre, pre1: invalidPre }),
  });
  assert.notEqual(result.status, "passed");
  assert.match(result.failures.join("\n"), /invalid capture/);
});

test("a dim post CIRRUS subject reds luminance non-vacuity", () => {
  const dimPost = { cirrus: { meanLum: 0.5 } };
  const result = assessCloudU2PerfManifests({
    manifests: completeCampaign({ post0: dimPost, post1: dimPost }),
  });
  assert.notEqual(result.status, "passed");
  assert.match(
    result.failures.join("\n"),
    /CIRRUS subject is vacuous below mean luminance/,
  );
});

test("a thin-but-visible CIRRUS subject above the luminance floor passes", () => {
  const thin = { cirrus: { meanLum: 4.1, cloudCells: 25 } };
  const result = assessCloudU2PerfManifests({
    manifests: completeCampaign({
      pre0: thin,
      post0: thin,
      pre1: thin,
      post1: thin,
    }),
  });
  assert.equal(result.status, "passed");
});
test("a manifest set that omits cirrusMinMeanLum is a round failure, never a halved floor", () => {
  const manifests = completeCampaign();
  for (const m of manifests) {
    delete m.measurement.cirrusMinMeanLum;
  }
  const result = assessCloudU2PerfManifests({ manifests });
  assert.notEqual(result.status, "passed");
  assert.match(result.failures.join(" "), /does not declare cirrusMinMeanLum/);
});

// The micro-pass controls carry pure attribution noise up to 0.102 ms
// same-bundle; a swing below the derived materiality floor must not
// discard a round, and a genuinely material control move still must.
test("a control swing below the absolute materiality floor is not drift", () => {
  const manifests = completeCampaign();
  // 0.2 ms control at 1.9x = +0.18 ms delta: 90% relative, under the floor.
  for (const m of manifests) {
    if (m.tag === "post") {
      for (const lane of m.lanes) {
        lane.passes["CloudTemporalResolve pass"].medianAvgMs = 0.38;
      }
    } else {
      for (const lane of m.lanes) {
        lane.passes["CloudTemporalResolve pass"].medianAvgMs = 0.2;
      }
    }
  }
  const result = assessCloudU2PerfManifests({ manifests });
  assert.ok(
    result.rounds.every((round) => !round.controlDrifted),
    "sub-floor control swing was scored as drift: " +
      JSON.stringify(result.rounds.map((r) => r.failures)),
  );
});

test("a material control move above the floor still discards the round", () => {
  const manifests = completeCampaign();
  for (const m of manifests) {
    if (m.tag === "post") {
      for (const lane of m.lanes) {
        lane.passes["CloudTemporalResolve pass"].medianAvgMs = 0.5;
      }
    }
  }
  const result = assessCloudU2PerfManifests({ manifests });
  assert.ok(
    result.rounds.every((round) => round.controlDrifted),
    "a 0.3 ms control move above the floor did not discard",
  );
});
