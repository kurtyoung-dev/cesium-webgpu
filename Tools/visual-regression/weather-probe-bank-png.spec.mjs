// weather-probe-bank-png.spec.mjs — the five weather probes bank their
// same-task evidence PNGs through the kit's bankPngCapture. Pure Node: the
// descriptors run through the real runProbe against the family's stub browser
// (lib/weather-lane-fixtures.mjs), and every write lands under a lane temp root.
// @purpose Pins KIT-5A (b2): probe-weather-{channels,edr-mock,ingest,metar,seam-poles} bank the same file names as before, each capture record in the runtime receipt carries url (the page's url() at the capture, read from a stub page that answers one), an ISO capturedAt, matchCount null and liveness unread with the bytes and digest of the file on disk, and a lane that hands back a non-PNG data URL refuses (exit 3) instead of banking it.
// @status ACTIVE
//
// The groups run over a descriptor; the mutant tests run the same group over a
// copy of the probe whose banking block was reverted to an inline write
// (`Buffer.from(...)`, `fs.writeFileSync`, a record of the four old fields)
// and require the group to fail.
//
// Run: node --test Tools/visual-regression/weather-probe-bank-png.spec.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { PROBE_EXIT_CODES, runProbe } from "./lib/probe-runtime.mjs";
import {
  COVERAGE_MARKER,
  CHANNELS_MARKER,
  INGEST_MARKER,
  PNG_DATA_URL,
  channelsLane,
  coverageLane,
  drive,
  fakeLaunch,
  ingestLane,
  metarLanes,
  readJson,
  seamLanes,
} from "./lib/weather-lane-fixtures.mjs";
import { descriptor as channelsDescriptor } from "./probe-weather-channels.mjs";
import { descriptor as edrDescriptor } from "./probe-weather-edr-mock.mjs";
import { descriptor as ingestDescriptor } from "./probe-weather-ingest.mjs";
import { descriptor as metarDescriptor } from "./probe-weather-metar.mjs";
import { descriptor as seamDescriptor } from "./probe-weather-seam-poles.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FIXTURE_BYTES = Buffer.from(
  PNG_DATA_URL.slice("data:image/png;base64,".length),
  "base64",
);

/**
 * The page url every stub page answers in the healthy group. The family's
 * fixture page has no url(), so without this the record's url is null for a
 * wired and an unwired banking call alike.
 */
const FIXED_PAGE_URL =
  "http://localhost:8094/Apps/WebGPUTest/kit5-bank-png-fixture.html?renderer=webgpu";

/**
 * {@link drive}, with every stub page decorated to answer `url()`. Same
 * argv, clock and lanes as the fixture's own driver; the fixture lib is not
 * edited.
 *
 * @returns {Promise<{code: number, out: string, log: object}>}
 */
async function driveWithUrl(descriptor, root, lanes) {
  const out = path.join(root, "out");
  const log = { calls: [], launches: 0 };
  const fixtureLaunch = fakeLaunch(log, lanes);
  const launch = async (...args) => {
    const browser = await fixtureLaunch(...args);
    return {
      ...browser,
      async newPage() {
        const page = await browser.newPage();
        return { ...page, url: () => FIXED_PAGE_URL };
      },
    };
  };
  const code = await runProbe(descriptor, {
    argv: ["--repository-root", root, "--output", out, "--no-serve-built"],
    now: () => Date.UTC(2026, 8, 26, 23, 0, 0),
    launch,
  });
  return { code, out, log };
}

const PROBES = [
  {
    id: "channels",
    file: "probe-weather-channels.mjs",
    descriptor: channelsDescriptor,
    runtime: "weather-channels-runtime.json",
    refusal: "weather-channels-refusal.json",
    lanes: () => [{ marker: CHANNELS_MARKER, respond: channelsLane() }],
    names: [
      "weather-channels-rich-lon-170.png",
      "weather-channels-rich-lon150.png",
    ],
  },
  {
    id: "edr-mock",
    file: "probe-weather-edr-mock.mjs",
    descriptor: edrDescriptor,
    runtime: "weather-edr-mock-runtime.json",
    refusal: "weather-edr-mock-refusal.json",
    lanes: () => [{ marker: COVERAGE_MARKER, respond: coverageLane() }],
    names: ["weather-edr-mock-east.png", "weather-edr-mock-west.png"],
  },
  {
    id: "ingest",
    file: "probe-weather-ingest.mjs",
    descriptor: ingestDescriptor,
    runtime: "weather-ingest-runtime.json",
    refusal: "weather-ingest-refusal.json",
    lanes: () => [{ marker: INGEST_MARKER, respond: ingestLane() }],
    names: ["weather-ingest-uniform-hi.png", "weather-ingest-uniform-lo.png"],
  },
  {
    id: "metar",
    file: "probe-weather-metar.mjs",
    descriptor: metarDescriptor,
    runtime: "weather-metar-runtime.json",
    refusal: "weather-metar-refusal.json",
    lanes: () => metarLanes(),
    names: [
      "weather-metar-channels-off.png",
      "weather-metar-channels-on.png",
      "weather-metar-clear.png",
      "weather-metar-ovc.png",
    ],
  },
  {
    id: "seam-poles",
    file: "probe-weather-seam-poles.mjs",
    descriptor: seamDescriptor,
    runtime: "weather-seam-poles-runtime.json",
    refusal: "weather-seam-poles-refusal.json",
    lanes: () => seamLanes(),
    names: [
      "dateline-eq-repeat.png",
      "dateline-eq.png",
      "npole-repeat.png",
      "npole.png",
      "spole.png",
    ],
  },
];

/** Replace every non-null string `png` in a lane answer with `bad`. */
function corruptPngs(value, bad) {
  if (Array.isArray(value)) {
    for (const item of value) {
      corruptPngs(item, bad);
    }
  } else if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (key === "png" && typeof value[key] === "string") {
        value[key] = bad;
      } else {
        corruptPngs(value[key], bad);
      }
    }
  }
  return value;
}

/** The lanes with every PNG answer replaced by `bad`. */
function corruptLanes(lanes, bad) {
  return lanes.map((lane) => ({
    ...lane,
    respond: (cfg) => corruptPngs(lane.respond(cfg), bad),
  }));
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/** A healthy run banks the same names, each record carrying the kit's fields. */
async function healthyGroup(probe, descriptor) {
  await withLaneTmp(`weather-bank-${probe.id}-`, async (root) => {
    const { code, out } = await driveWithUrl(descriptor, root, probe.lanes());
    assert.equal(code, PROBE_EXIT_CODES.OK, `${probe.id}: still exits 0`);
    const runtime = readJson(path.join(out, probe.runtime));
    assert.deepEqual(
      runtime.captures.map((record) => record.name).sort(),
      [...probe.names].sort(),
      `${probe.id}: the same file names are banked`,
    );
    for (const record of runtime.captures) {
      const where = `${probe.id}/${record.name}`;
      const onDisk = fs.readFileSync(path.join(out, record.name));
      assert.ok(
        onDisk.equals(FIXTURE_BYTES),
        `${where}: the decoded PNG is on disk`,
      );
      assert.equal(record.byteLength, onDisk.byteLength, where);
      assert.equal(
        record.sha256,
        createHash("sha256").update(onDisk).digest("hex"),
        where,
      );
      assert.equal(
        record.url,
        FIXED_PAGE_URL,
        `${where}: the page's url() at the capture`,
      );
      assert.match(record.capturedAt, ISO_UTC, `${where}: ISO capturedAt`);
      assert.equal(
        record.matchCount,
        null,
        `${where}: no locator was resolved`,
      );
      assert.deepEqual(
        record.liveness,
        { state: "unread", frameNumber: null },
        `${where}: the seam was not shown the gate, and says so`,
      );
      assert.equal(path.dirname(record.path), path.resolve(out), where);
    }
  });
}

/** A lane answering a non-PNG data URL refuses; nothing is banked. */
async function refusalGroup(probe, descriptor) {
  for (const [label, bad] of [
    ["a JPEG data URL", "data:image/jpeg;base64,/9j/4AAQSkZJRg=="],
    [
      "base64 of a non-PNG",
      `data:image/png;base64,${Buffer.from("not a png at all, just text").toString("base64")}`,
    ],
  ]) {
    await withLaneTmp(`weather-bank-refuse-${probe.id}-`, async (root) => {
      const { code, out } = await drive(
        descriptor,
        root,
        corruptLanes(probe.lanes(), bad),
      );
      assert.equal(
        code,
        PROBE_EXIT_CODES.REFUSAL,
        `${probe.id}: ${label} refuses (exit 3)`,
      );
      const refusal = readJson(path.join(out, probe.refusal));
      assert.equal(
        refusal.refusal.reason,
        "capture-data-url-invalid",
        `${probe.id}: ${label}`,
      );
      const banked = fs
        .readdirSync(out)
        .filter((name) => name.endsWith(".png"));
      assert.deepEqual(banked, [], `${probe.id}: ${label}: no PNG was banked`);
      assert.equal(
        fs.existsSync(path.join(out, probe.runtime)),
        false,
        `${probe.id}: a refusal publishes no receipt`,
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Live tests
// ---------------------------------------------------------------------------

for (const probe of PROBES) {
  test(`${probe.id}: banks through the kit, every record carrying url, capturedAt, matchCount null and liveness unread`, () =>
    healthyGroup(probe, probe.descriptor));
  test(`${probe.id}: a non-PNG data URL from the lane refuses instead of banking`, () =>
    refusalGroup(probe, probe.descriptor));
}

// ---------------------------------------------------------------------------
// Inertness mutants: the banking block reverted to its inline write
// ---------------------------------------------------------------------------

const INLINE_BANK =
  'import fs from "node:fs";\n' +
  'import { createHash } from "node:crypto";\n' +
  "function bankPngCapture(png, name, { outputDirectory, captures }) {\n" +
  '  const bytes = Buffer.from(png.slice(png.indexOf(",") + 1), "base64");\n' +
  '  const file = outputDirectory + "/" + name;\n' +
  "  fs.mkdirSync(outputDirectory, { recursive: true });\n" +
  "  fs.writeFileSync(file, bytes);\n" +
  "  captures.push({\n" +
  "    name,\n" +
  "    path: file,\n" +
  "    byteLength: bytes.byteLength,\n" +
  '    sha256: createHash("sha256").update(bytes).digest("hex"),\n' +
  "  });\n" +
  "}\n";

for (const probe of PROBES) {
  test(`mutant (${probe.id}): the banking block reverted to its inline write turns the groups RED`, async () => {
    const mutated = await importMutated(path.join(HERE, probe.file), [
      ["  bankPngCapture,\n", ""],
      ['import fs from "node:fs";\n', INLINE_BANK],
    ]);
    await assert.rejects(
      () => healthyGroup(probe, mutated.descriptor),
      (error) => error instanceof assert.AssertionError,
      `${probe.id}: the healthy group still passed over the inline write`,
    );
    await assert.rejects(
      () => refusalGroup(probe, mutated.descriptor),
      (error) => error instanceof assert.AssertionError,
      `${probe.id}: the refusal group still passed over the inline write`,
    );
  });
}
