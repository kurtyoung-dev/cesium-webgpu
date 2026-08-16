// C12-29 S5 NASA footprint fixture: pins the smallest exact, reproducible
// shard of NASA SVS 5073's `umbra_lo` shapefile used by the browser-overlay
// acceptance design. This spec stays offline and does not render.
// @purpose Offline pin of the exact cropped NASA SVS 5073 umbra_lo shapefile shard (byte hashes, optional full-source reconstruction); no rendering.
// @status ACTIVE
//
// Run:
//   node --test Tools/visual-regression/nasa-svs-5073-umbra-fixture.spec.mjs
//
// Optional full-source reconstruction:
//   SVS_5073_SOURCE_DIR=<extracted ZIP directory> node --test ...

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SVS_5073_ARCHIVE,
  SVS_5073_SELECTIONS,
  SVS_5073_SOURCE_MEMBERS,
  buildCroppedFixture,
  deriveFixtureFromDirectory,
} from "./fixtures/nasa-svs-5073/derive-umbra-lo-shard.mjs";
import { parseSvs5073UmbraShapefile } from "./fixtures/nasa-svs-5073/nasa-svs-5073-shapefile.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = path.join(here, "fixtures", "nasa-svs-5073");
const stem = "umbra-lo-c1229-s5";
const extensions = ["shp", "shx", "dbf", "prj"];
const manifest = JSON.parse(
  fs.readFileSync(path.join(fixtureDirectory, "manifest.json"), "utf8"),
);
const files = Object.fromEntries(
  extensions.map((extension) => [
    extension,
    fs.readFileSync(path.join(fixtureDirectory, `${stem}.${extension}`)),
  ]),
);

const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const fingerprint = (bytes) => ({
  bytes: bytes.byteLength,
  sha256: sha256(bytes),
});

function fixtureSetSha256(members) {
  const hash = crypto.createHash("sha256");
  for (const extension of extensions) {
    hash.update(Buffer.from(`${stem}.${extension}\0`, "utf8"));
    hash.update(members[extension]);
  }
  return hash.digest("hex");
}

function extractRecordMaterial(members) {
  const shxCount = (members.shx.byteLength - 100) / 8;
  const headerBytes = members.dbf.readUInt16LE(8);
  const recordBytes = members.dbf.readUInt16LE(10);
  const records = [];
  for (let index = 0; index < shxCount; index++) {
    const tableOffset = 100 + index * 8;
    const offsetBytes = members.shx.readInt32BE(tableOffset) * 2;
    const contentBytes = members.shx.readInt32BE(tableOffset + 4) * 2;
    records.push({
      outputRecordNumber: members.shp.readInt32BE(offsetBytes),
      contentBytes,
      body: Buffer.from(
        members.shp.subarray(offsetBytes + 8, offsetBytes + 8 + contentBytes),
      ),
      dbfRow: Buffer.from(
        members.dbf.subarray(
          headerBytes + index * recordBytes,
          headerBytes + (index + 1) * recordBytes,
        ),
      ),
      bbox: [0, 1, 2, 3].map((axis) =>
        members.shp.readDoubleLE(offsetBytes + 12 + axis * 8),
      ),
    });
  }
  return { records, headerBytes, recordBytes };
}

function signedRingArea(ring) {
  let twiceArea = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    twiceArea += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return twiceArea * 0.5;
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

test("fixture package is small, exact, and contains no source-archive spill", () => {
  assert.deepEqual(
    fs.readdirSync(fixtureDirectory).sort(),
    [
      "NOTICE.md",
      "derive-umbra-lo-shard.mjs",
      "manifest.json",
      "nasa-svs-5073-shapefile.mjs",
      `${stem}.dbf`,
      `${stem}.prj`,
      `${stem}.shp`,
      `${stem}.shx`,
    ].sort(),
  );
  assert.equal(manifest.schema, "nasa-svs-5073-umbra-lo-c1229-s5-fixture-v1");
  assert.deepEqual(manifest.source.archive, SVS_5073_ARCHIVE);
  assert.deepEqual(manifest.source.members, SVS_5073_SOURCE_MEMBERS);
  assert.equal(manifest.source.sourceRecordCount, 1_181);
  assert.equal(manifest.output.recordCount, 4);
  assert.equal(manifest.output.shapeType, 5);
  for (const extension of extensions) {
    assert.deepEqual(manifest.output.members[extension], {
      file: `${stem}.${extension}`,
      ...fingerprint(files[extension]),
    });
  }
  assert.equal(fixtureSetSha256(files), manifest.output.fixtureSetSha256);
  const vendoredDataBytes = extensions.reduce(
    (sum, extension) => sum + files[extension].byteLength,
    0,
  );
  assert.equal(vendoredDataBytes, 12_340);
  assert.ok(vendoredDataBytes < SVS_5073_ARCHIVE.bytes / 1_000);

  for (const tool of [manifest.derivation.script, manifest.derivation.parser]) {
    const bytes = fs.readFileSync(path.join(fixtureDirectory, tool.file));
    assert.deepEqual(fingerprint(bytes), {
      bytes: tool.bytes,
      sha256: tool.sha256,
    });
  }
});

test("browser-safe parser returns four closed WGS84 polygons and exact DBF centers", () => {
  const parserSource = fs.readFileSync(
    path.join(fixtureDirectory, "nasa-svs-5073-shapefile.mjs"),
    "utf8",
  );
  assert.doesNotMatch(parserSource, /(?:from|import\()\s*["']node:/u);
  assert.doesNotMatch(parserSource, /\b(?:Buffer|process|require)\b/u);

  const collection = parseSvs5073UmbraShapefile(files);
  assert.equal(collection.type, "FeatureCollection");
  assert.equal(collection.features.length, 4);
  assert.deepEqual(collection.bbox, manifest.output.bbox);
  assert.equal(collection.projectionWkt, manifest.source.projection.wkt);
  assert.match(
    collection.projectionWkt,
    /SPHEROID\["WGS_1984",6378137,298\.257223563\]/u,
  );
  assert.deepEqual(
    collection.features.map((feature) => feature.properties.UTCTime),
    ["18:09:30", "18:17:10", "18:17:20", "18:42:50"],
  );

  let storedPoints = 0;
  let distinctVertices = 0;
  collection.features.forEach((feature, index) => {
    const expected = SVS_5073_SELECTIONS[index];
    assert.equal(feature.id, index + 1);
    assert.equal(feature.properties._shpRecordNumber, index + 1);
    assert.equal(feature.geometry.type, "Polygon");
    assert.equal(feature.geometry.coordinates.length, 1);
    assert.deepEqual(feature.bbox, expected.bbox);
    assert.equal(feature.properties.CenterLon, expected.center[0]);
    assert.equal(feature.properties.CenterLat, expected.center[1]);
    assert.equal(feature.properties.CenterAlt, 0);
    assert.equal(
      feature.properties._storedPointCount,
      expected.storedPointCount,
    );
    const ring = feature.geometry.coordinates[0];
    assert.equal(ring.length, expected.storedPointCount);
    assert.deepEqual(
      ring[0],
      ring.at(-1),
      "the source closing point must be retained",
    );
    assert.ok(
      signedRingArea(ring) < 0,
      "ESRI outer ring must retain clockwise winding",
    );
    assert.ok(
      pointInRing(expected.center, ring),
      "source DBF center must lie in its polygon",
    );
    for (const [longitude, latitude] of ring) {
      assert.ok(Number.isFinite(longitude) && Number.isFinite(latitude));
      assert.ok(longitude >= feature.bbox[0] && longitude <= feature.bbox[2]);
      assert.ok(latitude >= feature.bbox[1] && latitude <= feature.bbox[3]);
    }
    storedPoints += ring.length;
    distinctVertices += ring.length - 1;
  });
  assert.equal(storedPoints, 687);
  assert.equal(distinctVertices, 683);
  assert.equal(manifest.selection.storedPointCount, 687);
  assert.equal(manifest.selection.distinctNonClosingVertices, 683);
  assert.match(
    manifest.selection.countCorrection,
    /171 \+ 171 \+ 171 \+ 174 = 687/u,
  );
});

test("every vendored SHP body and DBF row remains byte-exact to its source pin", () => {
  const { records, recordBytes } = extractRecordMaterial(files);
  assert.equal(recordBytes, 83);
  assert.equal(records.length, SVS_5073_SELECTIONS.length);
  records.forEach((record, index) => {
    const expected = SVS_5073_SELECTIONS[index];
    const recorded = manifest.selection.records[index];
    assert.equal(record.outputRecordNumber, index + 1);
    assert.equal(record.contentBytes, expected.contentBytes);
    assert.equal(record.body.readInt32LE(40), expected.storedPointCount);
    assert.equal(sha256(record.body), expected.recordBodySha256);
    assert.equal(sha256(record.dbfRow), expected.dbfRowSha256);
    assert.deepEqual(record.bbox, expected.bbox);
    assert.equal(recorded.sourceIndexZeroBased, expected.sourceIndex);
    assert.equal(recorded.sourceRecordNumber, expected.sourceRecordNumber);
    assert.equal(recorded.sourceOffsetBytes, expected.sourceOffsetBytes);
    assert.equal(recorded.outputRecordNumber, index + 1);
  });
});

test("canonical container reconstruction is byte-identical without the source ZIP", () => {
  const { records, headerBytes } = extractRecordMaterial(files);
  const rebuilt = buildCroppedFixture({
    shpHeader: files.shp,
    shxHeader: files.shx,
    dbfHeader: files.dbf.subarray(0, headerBytes),
    prj: files.prj,
    records,
  });
  for (const extension of extensions) {
    assert.deepEqual(
      rebuilt[extension],
      files[extension],
      `${extension} reconstruction drifted`,
    );
  }
  assert.deepEqual(rebuilt.bbox, manifest.output.bbox);
});

test("parser rejects misaligned SHX, DBF, and projection inputs", () => {
  const badShx = Buffer.from(files.shx);
  badShx.writeInt32BE(badShx.readInt32BE(104) + 1, 104);
  assert.throws(
    () => parseSvs5073UmbraShapefile({ ...files, shx: badShx }),
    /SHP\/SHX lengths disagree|truncated/u,
  );

  const badDbf = Buffer.from(files.dbf);
  badDbf.writeUInt32LE(3, 4);
  assert.throws(
    () => parseSvs5073UmbraShapefile({ ...files, dbf: badDbf }),
    /DBF length does not equal/u,
  );

  const badPrj = Buffer.from(files.prj);
  badPrj[0] = "X".charCodeAt(0);
  assert.throws(
    () => parseSvs5073UmbraShapefile({ ...files, prj: badPrj }),
    /PRJ is not the pinned WGS84/u,
  );
});

test("provenance records the no-resample derivation and exact NASA page credits", () => {
  assert.equal(manifest.derivation.resample, "none");
  assert.equal(manifest.derivation.reprojection, "none");
  assert.match(manifest.derivation.coordinateRounding, /copied/u);
  assert.equal(
    manifest.source.projection.axisOrderUsedByShapefile[0],
    "longitude-east-degrees",
  );
  assert.equal(
    manifest.creditAndUse.requestedCredit,
    "NASA's Scientific Visualization Studio",
  );
  assert.match(manifest.creditAndUse.publisher, /NASA\/Goddard/u);
  assert.deepEqual(manifest.creditAndUse.pageCreators.visualizers, [
    "Michala Garrison (SSAI)",
    "Ernie Wright (USRA)",
  ]);
  assert.match(manifest.creditAndUse.retain, /NOTICE\.md/u);
  assert.match(
    manifest.creditAndUse.noEndorsement,
    /must not be used to imply/u,
  );
  assert.match(manifest.creditAndUse.pageReview, /no page-specific/u);
  assert.equal(manifest.creditAndUse.notice, "NOTICE.md");
  const notice = fs.readFileSync(
    path.join(fixtureDirectory, manifest.creditAndUse.notice),
    "utf8",
  );
  assert.match(notice, /NASA's Scientific Visualization Studio/u);
  assert.match(notice, /Michala Garrison/u);
  assert.match(notice, /Ernie Wright/u);
  assert.match(notice, /does not imply NASA endorsement/u);
});

const sourceDirectory = path.resolve(
  process.env.SVS_5073_SOURCE_DIR ??
    path.join(os.tmpdir(), "2024eclipse_shapefiles_inspect"),
);
const sourceAvailable = Object.values(SVS_5073_SOURCE_MEMBERS).every((member) =>
  fs.existsSync(path.join(sourceDirectory, member.file)),
);

test(
  "optional full upstream reconstruction reproduces every vendored byte and manifest field",
  { skip: !sourceAvailable },
  () => {
    const rebuilt = deriveFixtureFromDirectory(sourceDirectory);
    for (const extension of extensions) {
      assert.deepEqual(rebuilt[extension], files[extension]);
    }
    assert.deepEqual(rebuilt.manifest, manifest);
  },
);
