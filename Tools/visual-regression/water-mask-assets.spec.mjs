// water-mask-assets.spec.mjs — the shipped WaterMask binaries are honest, parse exactly, and rebuild.
// @purpose Pins the bundled WaterMask binaries (counts, exact-EOF parse, LICENSE byte counts, tensor and archive rebuild) and the behaviour of the water-mask build tools.
// @status ACTIVE
//
// Observable behaviours pinned here (BEHAVIOUR_WATER.md D1..D5):
//   D1  every shipped .bin under Assets/WaterMask is named, with its exact byte count,
//       in both LICENSE.md files; a file held out of the shipped set is not tracked.
//   D2  rebuilding globalBathymetryTensor.bin (and the tile archive) from the shipped
//       inputs reproduces the shipped bytes.
//   D3  every shipped binary parses to exactly its end of file with the pinned counts.
//       A copy truncated by one byte, or padded by one byte, fails to parse.
//   D4  the coastline mask at (0 N, 0 E) is water.
//   D5  the river builder exits non-zero and writes nothing when its download fails.
// Plus the tool behaviours the fixes added: the coast minimum-area filter, its offline
// refilter, the --input directory, the LWM2 ring-count guard, the lake quantisation and
// the river width taper.
//
// Everything a test writes goes under a fresh os.tmpdir() directory that is removed at
// the end; nothing is written under the repository tree.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

enableEngineTsResolution();

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const MASK_DIR = path.join(ROOT, "packages/engine/Source/Assets/WaterMask");
const RAD = Math.PI / 180.0;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cesium-water-mask-assets-"));
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// Pinned record counts (BEHAVIOUR D3). 9,641 polygons came from the network build; the
// minimum-area filter (1e-4 deg2) leaves 7,897.
const PINNED = {
  coastPolygons: 7897,
  lakePolygons: 4421,
  lakeReefPolygons: 1043,
  riverPolylines: 1993,
  tensorWidth: 720,
  tensorHeight: 360,
  archiveCells: 648,
};

// A binary held out of the shipped set: it may sit on disk but must not be tracked, and
// it needs no LICENSE entry until it is kept (then it leaves this list and gains one).
const HELD_BINS = new Set(["globalHydrographyTileArchive.bin"]);

// ---------------------------------------------------------------------------
// Independent strict parsers. Each one checks every read against the buffer and
// requires the cursor to land exactly on the end of the file.
// ---------------------------------------------------------------------------
function reader(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  const need = (n) => {
    if (o + n > buf.byteLength) {
      throw new Error(`read of ${n} bytes at ${o} overruns ${buf.byteLength}`);
    }
  };
  return {
    get pos() {
      return o;
    },
    u8() {
      need(1);
      return view.getUint8(o++);
    },
    u16() {
      need(2);
      const v = view.getUint16(o, true);
      o += 2;
      return v;
    },
    u32() {
      need(4);
      const v = view.getUint32(o, true);
      o += 4;
      return v;
    },
    f32() {
      need(4);
      const v = view.getFloat32(o, true);
      o += 4;
      return v;
    },
    f64() {
      need(8);
      const v = view.getFloat64(o, true);
      o += 8;
      return v;
    },
    skip(n) {
      need(n);
      o += n;
    },
    done() {
      if (o !== buf.byteLength) {
        throw new Error(`parsed ${o} bytes of ${buf.byteLength}`);
      }
    },
  };
}

function parseLwm2(buf) {
  const r = reader(buf);
  if (r.u32() !== 0x324d574c) throw new Error("not LWM2");
  const count = r.u32();
  const polys = [];
  for (let p = 0; p < count; p++) {
    const bbox = [r.f32(), r.f32(), r.f32(), r.f32()];
    const waterTypeCode = r.u8();
    const depthQ8 = r.u8();
    const ringCount = r.u16();
    const rings = [];
    for (let k = 0; k < ringCount; k++) {
      const vc = r.u32();
      const start = r.pos;
      r.skip(vc * 4);
      rings.push({ vc, start });
    }
    polys.push({ bbox, waterTypeCode, depthQ8, rings });
  }
  r.done();
  return polys;
}

function parseNe1r(buf) {
  const r = reader(buf);
  if (r.u32() !== 0x5231454e) throw new Error("not NE1R");
  const count = r.u32();
  let vertices = 0;
  for (let k = 0; k < count; k++) {
    r.skip(32 + 4);
    const vc = r.u32() & 0x0fffffff;
    r.skip(vc * 6);
    vertices += vc;
  }
  r.done();
  return { count, vertices };
}

function parseGbt1(buf) {
  const r = reader(buf);
  if (r.u32() !== 0x31544247) throw new Error("not GBT1");
  const width = r.u16();
  const height = r.u16();
  r.u32();
  r.skip(width * height * 4);
  r.done();
  return { width, height };
}

function parseCwt1(buf) {
  const r = reader(buf);
  if (r.u32() !== 0x31545743) throw new Error("not CWT1");
  const cols = r.u16();
  const rows = r.u16();
  const dirOffset = r.u32();
  const total = r.u32();
  if (total !== cols * rows) throw new Error("directory size mismatch");
  r.skip(dirOffset - 16);
  const entries = [];
  for (let i = 0; i < total; i++) {
    entries.push({
      offset: r.u32(),
      length: r.u32(),
      flags: r.u32(),
      n: r.u32(),
    });
  }
  let expected = r.pos;
  for (const e of entries) {
    if (e.offset !== expected) throw new Error("cells are not contiguous");
    expected += e.length;
  }
  if (expected !== buf.byteLength)
    throw new Error("archive does not end at EOF");
  return { cells: total };
}

const PARSERS = {
  "ne50mCoastlines.bin": parseLwm2,
  "ne10mLakes.bin": parseLwm2,
  "ne10mRivers.bin": parseNe1r,
  "globalBathymetryTensor.bin": parseGbt1,
  "globalHydrographyTileArchive.bin": parseCwt1,
};

function shippedBins() {
  return fs
    .readdirSync(MASK_DIR)
    .filter((n) => n.endsWith(".bin"))
    .sort();
}

function readBin(name) {
  return fs.readFileSync(path.join(MASK_DIR, name));
}

function run(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120000,
    ...options,
  });
}

function tmpPath(...parts) {
  return path.join(TMP, ...parts);
}

// ---------------------------------------------------------------------------
// D3
// ---------------------------------------------------------------------------
test("1. D3: every shipped binary parses to exactly its end of file, with the pinned counts", () => {
  const names = shippedBins();
  for (const name of names) {
    assert.ok(
      PARSERS[name],
      `no parser for ${name}: add one, or remove the file`,
    );
  }
  const coast = parseLwm2(readBin("ne50mCoastlines.bin"));
  assert.equal(coast.length, PINNED.coastPolygons);
  assert.ok(coast.every((p) => p.rings.length >= 1));

  const lakes = parseLwm2(readBin("ne10mLakes.bin"));
  assert.equal(lakes.length, PINNED.lakePolygons);
  assert.equal(
    lakes.filter((p) => p.waterTypeCode === 8).length,
    PINNED.lakeReefPolygons,
  );

  assert.equal(
    parseNe1r(readBin("ne10mRivers.bin")).count,
    PINNED.riverPolylines,
  );

  const tensor = parseGbt1(readBin("globalBathymetryTensor.bin"));
  assert.equal(tensor.width, PINNED.tensorWidth);
  assert.equal(tensor.height, PINNED.tensorHeight);

  if (names.includes("globalHydrographyTileArchive.bin")) {
    assert.equal(
      parseCwt1(readBin("globalHydrographyTileArchive.bin")).cells,
      PINNED.archiveCells,
    );
  }
  console.log(
    `# coast polygons ${coast.length}, lake polygons ${lakes.length}, files ${names.join(", ")}`,
  );
});

test("2. D3 inertness: a copy truncated or padded by one byte fails to parse", () => {
  for (const name of shippedBins()) {
    const buf = readBin(name);
    assert.doesNotThrow(() => PARSERS[name](buf), `${name} parses unmodified`);
    assert.throws(
      () => PARSERS[name](buf.subarray(0, buf.byteLength - 1)),
      `${name} truncated by one byte must not parse`,
    );
    assert.throws(
      () => PARSERS[name](Buffer.concat([buf, Buffer.from([0])])),
      `${name} padded by one byte must not parse`,
    );
  }
});

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------
const LICENSE_FILES = ["LICENSE.md", "packages/engine/LICENSE.md"];

function licenseBytesFor(licenseText, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `\\*\\*File:\\*\\*[^\\n]*WaterMask/${escaped}\`[^\\n]*?\\(([\\d,]+) bytes`,
  );
  const m = re.exec(licenseText);
  return m ? Number(m[1].replaceAll(",", "")) : null;
}

test("3. D1: every shipped .bin is named in both LICENSE files with its exact byte count", () => {
  for (const name of shippedBins()) {
    if (HELD_BINS.has(name)) continue;
    const size = fs.statSync(path.join(MASK_DIR, name)).size;
    for (const file of LICENSE_FILES) {
      const text = fs.readFileSync(path.join(ROOT, file), "utf8");
      assert.equal(
        licenseBytesFor(text, name),
        size,
        `${file} must name ${name} with ${size.toLocaleString("en-US")} bytes`,
      );
    }
  }
});

test("4. D1: the lake determination line in LICENSE_DETERMINATIONS carries the on-disk size", () => {
  const size = fs.statSync(path.join(MASK_DIR, "ne10mLakes.bin")).size;
  const text = fs
    .readFileSync(
      path.join(ROOT, "migration_doc/LICENSE_DETERMINATIONS_2026-08-10.md"),
      "utf8",
    )
    .replace(/\s+/g, " ");
  assert.ok(
    text.includes(`${size.toLocaleString("en-US")} bytes of Natural Earth`),
    `L-21 must say ${size.toLocaleString("en-US")} bytes`,
  );
});

test("5. D1: a binary held out of the shipped set is not tracked by git", (t) => {
  const present = [...HELD_BINS].filter((n) => shippedBins().includes(n));
  if (present.length === 0) {
    t.skip("no held binary on disk");
    return;
  }
  const probe = spawnSync("git", ["-C", ROOT, "rev-parse", "--git-dir"], {
    encoding: "utf8",
  });
  if (probe.status !== 0) {
    t.skip("not a git checkout");
    return;
  }
  for (const name of present) {
    const rel = `packages/engine/Source/Assets/WaterMask/${name}`;
    const ls = spawnSync("git", ["-C", ROOT, "ls-files", "--", rel], {
      encoding: "utf8",
    });
    assert.equal(
      ls.stdout.trim(),
      "",
      `${name} is held out of the shipped set (MQ-1): it must not be tracked unless it gains a LICENSE entry and leaves HELD_BINS`,
    );
  }
});

test("6. .gitattributes pins the WaterMask binaries as binary", () => {
  const text = fs.readFileSync(path.join(ROOT, ".gitattributes"), "utf8");
  assert.ok(
    /^packages\/engine\/Source\/Assets\/WaterMask\/\*\.bin binary\s*$/m.test(
      text,
    ),
  );
  const probe = spawnSync("git", ["-C", ROOT, "rev-parse", "--git-dir"], {
    encoding: "utf8",
  });
  if (probe.status === 0) {
    const attr = spawnSync(
      "git",
      [
        "-C",
        ROOT,
        "check-attr",
        "binary",
        "--",
        "packages/engine/Source/Assets/WaterMask/ne10mLakes.bin",
      ],
      { encoding: "utf8" },
    );
    assert.match(attr.stdout, /binary: set/);
  }
});

// ---------------------------------------------------------------------------
// D4
// ---------------------------------------------------------------------------
test("7. D4: the coastline mask at 0 N, 0 E is water (no 'Null Island' land)", async () => {
  const { GlobalCoastlineWaterClassificationProvider } =
    await import("../../packages/engine/Source/Scene/GlobalCoastlineWaterClassificationProvider.js");
  const buf = readBin("ne50mCoastlines.bin");
  const provider = new GlobalCoastlineWaterClassificationProvider(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
  for (const halfDeg of [0.02, 1.0]) {
    const mask = provider.generateWaterMask(
      {
        west: -halfDeg * RAD,
        south: -halfDeg * RAD,
        east: halfDeg * RAD,
        north: halfDeg * RAD,
      },
      256,
    );
    const nonWater = [...mask].filter((b) => b !== 255).length;
    assert.equal(
      nonWater,
      0,
      `a ${halfDeg * 2}-degree tile at (0,0) has ${nonWater} non-water pixels`,
    );
  }
  assert.equal(parseLwm2(buf).length, PINNED.coastPolygons);
});

// ---------------------------------------------------------------------------
// D2
// ---------------------------------------------------------------------------
test("8. D2: rebuilding the tensor from the shipped inputs reproduces the shipped bytes", () => {
  const out = tmpPath("tensor-rebuild.bin");
  const res = run(["Tools/build-global-bathymetry-tensor.mjs", "--out", out]);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(
    Buffer.compare(
      fs.readFileSync(out),
      readBin("globalBathymetryTensor.bin"),
    ) === 0,
    "the shipped tensor is not tool(inputs)",
  );
});

test("9. D2: the tile archive, when present, equals the tool run on the shipped inputs", (t) => {
  if (!shippedBins().includes("globalHydrographyTileArchive.bin")) {
    t.skip("archive not present");
    return;
  }
  const out = tmpPath("archive-rebuild.bin");
  const res = run(["Tools/build-cloud-tiled-hydrography.mjs", "--out", out]);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(
    Buffer.compare(
      fs.readFileSync(out),
      readBin("globalHydrographyTileArchive.bin"),
    ) === 0,
  );
});

// ---------------------------------------------------------------------------
// D5 and the river tool
// ---------------------------------------------------------------------------
function parseNe1rRecords(buf) {
  const r = reader(buf);
  assert.equal(r.u32(), 0x5231454e);
  const count = r.u32();
  const records = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let k = 0; k < count; k++) {
    r.skip(36);
    const vc = r.u32() & 0x0fffffff;
    const widths = [];
    for (let i = 0; i < vc; i++) {
      widths.push(view.getUint16(r.pos + 4, true));
      r.skip(6);
    }
    records.push(widths);
  }
  r.done();
  return records;
}

const RIVER_GEOJSON = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { featurecla: "River", scalerank: 3, strokeweig: 0.6 },
      geometry: {
        type: "LineString",
        coordinates: [
          [30.0, 10.0],
          [30.6, 10.5],
          [31.2, 11.5],
          [31.9, 12.2],
          [32.6, 12.9],
        ],
      },
    },
  ],
};

test("10. D5: a failed download exits non-zero and writes no file", () => {
  const stub = tmpPath("stub-fetch.mjs");
  fs.writeFileSync(
    stub,
    `globalThis.fetch = async () => { throw new TypeError("fetch failed (stubbed offline)"); };\n`,
  );
  const out = tmpPath("river-offline.bin");
  const res = run([
    "--import",
    pathToFileURL(stub).href,
    "Tools/build-global-river-binary.mjs",
    "--out",
    out,
  ]);
  assert.notEqual(res.status, 0, "the tool must fail when it cannot download");
  assert.equal(
    fs.existsSync(out),
    false,
    "no file may be written from the fallback",
  );
  assert.match(res.stderr, /failed/);
});

test("11. --input rebuilds the Natural Earth part offline; widths taper on authored trunks only", () => {
  const input = tmpPath("rivers.geojson");
  fs.writeFileSync(input, JSON.stringify(RIVER_GEOJSON));
  const out = tmpPath("river-input.bin");
  const res = run([
    "Tools/build-global-river-binary.mjs",
    "--input",
    input,
    "--out",
    out,
  ]);
  assert.equal(res.status, 0, res.stderr);
  const records = parseNe1rRecords(fs.readFileSync(out));
  assert.equal(
    records.length,
    23,
    "22 authored trunks plus the one input river",
  );
  const ne = records[22];
  assert.ok(ne.length >= 2);
  assert.ok(
    ne.every((w) => w === 65535),
    "a Natural Earth piece keeps one constant width",
  );
  const trunk = records[0];
  assert.ok(
    trunk[0] < trunk[trunk.length - 1],
    "an authored trunk widens downstream",
  );
  assert.ok(trunk[0] < 0.4 * 65535);
});

test("12. --fallback-canonical writes the 22 authored trunks and says so", () => {
  const out = tmpPath("river-canonical.bin");
  const res = run([
    "Tools/build-global-river-binary.mjs",
    "--fallback-canonical",
    "--out",
    out,
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /WARNING.*canonical/i);
  assert.equal(parseNe1r(fs.readFileSync(out)).count, 22);
});

// ---------------------------------------------------------------------------
// Coast tool: minimum-area filter, offline refilter, --input directory, ring guard
// ---------------------------------------------------------------------------
function square(lon, lat, side) {
  return [
    [lon, lat],
    [lon + side, lat],
    [lon + side, lat + side],
    [lon, lat + side],
    [lon, lat],
  ];
}

function featureCollection(rings) {
  return {
    type: "FeatureCollection",
    features: rings.map((coordinates) => ({
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [coordinates] },
    })),
  };
}

function writeCoastInput(dir, land) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "ne_10m_land.geojson"),
    JSON.stringify(featureCollection(land)),
  );
  fs.writeFileSync(
    path.join(dir, "ne_10m_minor_islands.geojson"),
    JSON.stringify(featureCollection([])),
  );
  fs.writeFileSync(
    path.join(dir, "ne_10m_antarctic_ice_shelves_polys.geojson"),
    JSON.stringify(featureCollection([])),
  );
}

test("13. coast tool: --input takes a directory and drops source parts under the minimum area", () => {
  const dir = tmpPath("coast-input");
  // A 0.005-degree square at 0,0 (area 2.5e-5 deg2, under the 1e-4 filter) and a 1-degree island.
  writeCoastInput(dir, [square(-0.0025, -0.0025, 0.005), square(10, 10, 1)]);
  const out = tmpPath("coast-input.bin");
  const res = run([
    "Tools/build-coastline-water-mask.mjs",
    "--input",
    dir,
    "--out",
    out,
  ]);
  assert.equal(res.status, 0, res.stderr);
  const polys = parseLwm2(fs.readFileSync(out));
  assert.equal(polys.length, 1, "only the 1-degree island survives");
  const [w, s, e, n] = polys[0].bbox;
  assert.ok(Math.abs((w + e) / 2 - 10.5 * RAD) < 1e-4);
  assert.ok(Math.abs((s + n) / 2 - 10.5 * RAD) < 1e-4);
});

test("14. coast tool: --refilter drops tiny polygons and keeps every other record byte for byte", () => {
  const dir = tmpPath("coast-refilter");
  writeCoastInput(dir, [
    square(10, 10, 1),
    square(-0.0025, -0.0025, 0.005),
    square(40, 20, 2),
  ]);
  const full = tmpPath("coast-unfiltered.bin");
  let res = run([
    "Tools/build-coastline-water-mask.mjs",
    "--input",
    dir,
    "--out",
    full,
    "--min-area-deg2",
    "0",
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(parseLwm2(fs.readFileSync(full)).length, 3);

  const filtered = tmpPath("coast-refiltered.bin");
  res = run([
    "Tools/build-coastline-water-mask.mjs",
    "--refilter",
    full,
    "--out",
    filtered,
  ]);
  assert.equal(res.status, 0, res.stderr);
  const before = fs.readFileSync(full);
  const after = fs.readFileSync(filtered);
  const polys = parseLwm2(after);
  assert.equal(polys.length, 2);
  // The kept records are byte-identical slices of the input.
  const original = parseLwm2(before);
  const slice = (buf, polysOf, i) => {
    const p = polysOf[i];
    const start = p.rings[0].start - 4 - 20;
    const last = p.rings[p.rings.length - 1];
    return buf.subarray(start, last.start + last.vc * 4);
  };
  assert.deepEqual(slice(after, polys, 0), slice(before, original, 0));
  assert.deepEqual(slice(after, polys, 1), slice(before, original, 2));
  // Refiltering is idempotent.
  const again = tmpPath("coast-refiltered-again.bin");
  res = run([
    "Tools/build-coastline-water-mask.mjs",
    "--refilter",
    filtered,
    "--out",
    again,
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(Buffer.compare(fs.readFileSync(again), after) === 0);
});

function ringGuardInput(dir, names, outerSide) {
  fs.mkdirSync(dir, { recursive: true });
  const rings = [square(0, 0, outerSide)];
  for (let i = 0; i < 65536; i++) {
    const x = 0.05 + (i % 256) * 0.015;
    const y = 0.05 + Math.floor(i / 256) * 0.015;
    rings.push([
      [x, y],
      [x + 0.01, y],
      [x + 0.005, y + 0.01],
      [x, y],
    ]);
  }
  const holey = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: rings },
      },
    ],
  };
  for (const name of names) {
    fs.writeFileSync(
      path.join(dir, name),
      JSON.stringify(name === names[0] ? holey : featureCollection([])),
    );
  }
}

test("15. coast tool: a polygon with more than 65535 rings throws instead of truncating", () => {
  const dir = tmpPath("coast-rings");
  ringGuardInput(
    dir,
    [
      "ne_10m_land.geojson",
      "ne_10m_minor_islands.geojson",
      "ne_10m_antarctic_ice_shelves_polys.geojson",
    ],
    5,
  );
  const out = tmpPath("coast-rings.bin");
  const res = run([
    "Tools/build-coastline-water-mask.mjs",
    "--input",
    dir,
    "--out",
    out,
  ]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /ringCount/);
  assert.equal(fs.existsSync(out), false);
});

// ---------------------------------------------------------------------------
// Lake tool: quantisation against the stored float32 bbox, ring guard
// ---------------------------------------------------------------------------
const LAKE_SOURCES = [
  "ne_10m_lakes.geojson",
  "ne_10m_lakes_north_america.geojson",
  "ne_10m_lakes_europe.geojson",
  "ne_10m_playas.geojson",
  "ne_10m_reefs.geojson",
];

test("16. lake tool: a decoded vertex lands within 5 cm of its source coordinate", () => {
  const dir = tmpPath("lake-input");
  fs.mkdirSync(dir, { recursive: true });
  // At longitude 170.00123 the double-degree quantisation used to leave the stored
  // float32 bbox 0.7 m away from the vertices it was quantised against.
  const lon0 = 170.00123;
  const lat0 = 10.00123;
  const side = 0.01;
  const ring = square(lon0, lat0, side);
  for (const name of LAKE_SOURCES) {
    fs.writeFileSync(
      path.join(dir, name),
      JSON.stringify(featureCollection(name === LAKE_SOURCES[0] ? [ring] : [])),
    );
  }
  const out = tmpPath("lake-input.bin");
  const res = run([
    "Tools/build-lake-water-mask.mjs",
    "--input",
    dir,
    "--out",
    out,
  ]);
  assert.equal(res.status, 0, res.stderr);
  const buf = fs.readFileSync(out);
  const polys = parseLwm2(buf);
  assert.equal(polys.length, 1);
  const [west, south, east, north] = polys[0].bbox;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const ringInfo = polys[0].rings[0];
  const metresPerRad = 6378137;
  let worst = 0;
  const expected = ring.slice(0, 4);
  for (let i = 0; i < ringInfo.vc; i++) {
    const u = view.getUint16(ringInfo.start + i * 4, true);
    const v = view.getUint16(ringInfo.start + i * 4 + 2, true);
    const lon = west + (u / 65535) * (east - west);
    const lat = south + (v / 65535) * (north - south);
    const match = expected.find(
      ([x, y]) =>
        Math.abs(x * RAD - lon) < 1e-5 && Math.abs(y * RAD - lat) < 1e-5,
    );
    assert.ok(match, "every decoded vertex matches a source vertex");
    worst = Math.max(
      worst,
      Math.abs(match[0] * RAD - lon) * metresPerRad,
      Math.abs(match[1] * RAD - lat) * metresPerRad,
    );
  }
  assert.ok(worst < 0.05, `worst decode error ${worst.toFixed(3)} m`);
});

test("17. lake tool: a polygon with more than 65535 rings throws instead of truncating", () => {
  const dir = tmpPath("lake-rings");
  ringGuardInput(dir, LAKE_SOURCES, 5);
  const out = tmpPath("lake-rings.bin");
  const res = run([
    "Tools/build-lake-water-mask.mjs",
    "--input",
    dir,
    "--out",
    out,
  ]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /ringCount/);
  assert.equal(fs.existsSync(out), false);
});

// ---------------------------------------------------------------------------
// Tooling headers and lint
// ---------------------------------------------------------------------------
const TOOLS = [
  "Tools/build-coastline-water-mask.mjs",
  "Tools/build-lake-water-mask.mjs",
  "Tools/build-global-river-binary.mjs",
  "Tools/build-global-bathymetry-tensor.mjs",
  "Tools/build-cloud-tiled-hydrography.mjs",
  "Tools/lib/natural-earth-pinned.mjs",
];

test("18. every water-mask build tool registers an @purpose and @status header", async () => {
  const { parsePurposeHeader } = await import("../lib/purpose-header.mjs");
  for (const tool of TOOLS) {
    const parsed = parsePurposeHeader(
      fs.readFileSync(path.join(ROOT, tool), "utf8"),
    );
    assert.ok(parsed.purpose, `${tool} has no @purpose`);
    assert.equal(parsed.status, "ACTIVE", `${tool} has no @status`);
    assert.deepEqual(parsed.errors, [], tool);
  }
});

test("19. the tensor tool header names the geoid path the code reads and calls the output a prior", () => {
  const src = fs.readFileSync(path.join(ROOT, TOOLS[3]), "utf8");
  assert.ok(src.includes("Assets/Geoid/egm2008-0p5deg.i16"));
  assert.ok(!src.includes("Assets/Ocean/"));
  assert.match(src, /PROCEDURAL PRIOR/);
  assert.match(
    fs.readFileSync(path.join(ROOT, TOOLS[0]), "utf8"),
    /magic "LWM2"/,
  );
  assert.match(
    fs.readFileSync(path.join(ROOT, TOOLS[1]), "utf8"),
    /magic "LWM2"/,
  );
});

test("20. the water-mask build tools are eslint-clean", (t) => {
  const eslint = path.join(ROOT, "node_modules/eslint/bin/eslint.js");
  if (!fs.existsSync(eslint)) {
    t.skip("eslint is not installed");
    return;
  }
  const res = run([eslint, "--quiet", ...TOOLS], { timeout: 300000 });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

// ---------------------------------------------------------------------------
// Source pinning (R-2026-10-22-5): the Natural Earth downloads are pinned
// ---------------------------------------------------------------------------
test("21. the Natural Earth sources are pinned to a commit with a SHA-256 each; a mismatch is refused on download and reported on --input", async () => {
  const pin = await import("../lib/natural-earth-pinned.mjs");
  assert.match(pin.NATURAL_EARTH_COMMIT, /^[0-9a-f]{40}$/);
  for (const [name, sha] of Object.entries(pin.NATURAL_EARTH_SHA256)) {
    assert.match(sha, /^[0-9a-f]{64}$/, name);
    assert.ok(
      pin.naturalEarthUrl(name).includes(`/${pin.NATURAL_EARTH_COMMIT}/`),
      name,
    );
  }
  // Every source a builder names is in the pin table, and no builder reads a branch.
  for (const tool of TOOLS.slice(0, 3)) {
    const src = fs.readFileSync(path.join(ROOT, tool), "utf8");
    assert.ok(
      !/natural-earth-vector\/master\//.test(src),
      `${tool} reads master`,
    );
    for (const name of src.match(/ne_10m_[a-z_]+\.geojson/g) ?? []) {
      assert.ok(
        Object.hasOwn(pin.NATURAL_EARTH_SHA256, name),
        `${tool} reads ${name}, which has no pinned SHA-256`,
      );
    }
  }
  const wrong = new TextEncoder().encode("{}");
  assert.throws(
    () =>
      pin.verifyNaturalEarthSource(wrong, "ne_10m_land.geojson", {
        strict: true,
      }),
    /is not the pinned/,
  );
  const warnings = [];
  assert.equal(
    pin.verifyNaturalEarthSource(wrong, "ne_10m_land.geojson", {
      strict: false,
      warn: (m) => warnings.push(m),
    }),
    false,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /NOT the reproducible bundled build/);
  // Through the real tool: a fixture --input builds, and says it is not the bundled build.
  const dir = tmpPath("coast-unpinned-input");
  writeCoastInput(dir, [square(10, 10, 1)]);
  const res = run([
    "Tools/build-coastline-water-mask.mjs",
    "--input",
    dir,
    "--out",
    tmpPath("coast-unpinned-input.bin"),
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(
    res.stderr,
    /WARNING: ne_10m_land\.geojson SHA-256 [0-9a-f]{64} is not the pinned/,
  );
});
