#!/usr/bin/env node
/**
 * Deterministically crop four exact records from NASA SVS 5073 `umbra_lo`.
 *
 * The source ZIP is intentionally not vendored. Extract its four `umbra_lo.*`
 * members without transforming them, then run:
 *
 *   node derive-umbra-lo-shard.mjs --source-dir <extracted-directory>
 *
 * `--archive <2024eclipse_shapefiles.zip>` optionally verifies the enclosing
 * archive pin too. The derivation always verifies every consumed member before
 * reading a record. SHP polygon bodies, DBF rows, and PRJ bytes are copied
 * exactly; only the SHP/SHX container headers, record headers/index, and DBF
 * record count are rebuilt.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseSvs5073UmbraShapefile } from "./nasa-svs-5073-shapefile.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_STEM = "umbra-lo-c1229-s5";
const MAIN_HEADER_BYTES = 100;

export const SVS_5073_ARCHIVE = Object.freeze({
  file: "2024eclipse_shapefiles.zip",
  bytes: 79_468_554,
  sha256: "869cf2129382c56e547d32c9a5be368b3456145f113a2a44c350b5b19a8933a2",
  url: "https://svs.gsfc.nasa.gov/vis/a000000/a005000/a005073/2024eclipse_shapefiles.zip",
  localCopyVerifiedOn: "2026-08-12",
});

export const SVS_5073_SOURCE_MEMBERS = Object.freeze({
  shp: Object.freeze({
    file: "umbra_lo.shp",
    bytes: 4_024_140,
    sha256: "f21ed8514a5572a19e74485e179a8bc8bbe9042b29975a2162f31d22159119a2",
  }),
  shx: Object.freeze({
    file: "umbra_lo.shx",
    bytes: 9_548,
    sha256: "889357ddcc201ca5840fb08d96015ae43aa3a93155cb8efbbf1b025b3bf970c9",
  }),
  dbf: Object.freeze({
    file: "umbra_lo.dbf",
    bytes: 98_440,
    sha256: "82c9d4ca2ce9b30477216e509b77f26a08d74afb0fb631ab22a93d0d55f7e0e3",
  }),
  prj: Object.freeze({
    file: "umbra_lo.prj",
    bytes: 143,
    sha256: "98aaf3d1c0ecadf1a424a4536de261c3daf4e373697cb86c40c43b989daf52eb",
  }),
});

export const SVS_5073_SELECTIONS = Object.freeze([
  Object.freeze({
    role: "named-observer-mazatlan",
    sourceIndex: 544,
    sourceRecordNumber: 545,
    sourceOffsetBytes: 1_726_244,
    contentBytes: 2_784,
    storedPointCount: 171,
    utcTime: "18:09:30",
    center: Object.freeze([-106.26671, 23.04871]),
    bbox: Object.freeze([
      -107.22654104232788, 22.150620818138123, -105.30465245246887,
      23.94869863986969,
    ]),
    recordBodySha256:
      "a5270e231d5c355730885ac65f868c5edb5766cf044a48998c1e072d6bf26fb2",
    dbfRowSha256:
      "ea035664037170a2662e9dccfb5618c0ee23d1e2cd8df9549733b077a694225c",
  }),
  Object.freeze({
    role: "greatest-eclipse-10-second-bracket-before",
    sourceIndex: 590,
    sourceRecordNumber: 591,
    sourceOffsetBytes: 1_853_636,
    contentBytes: 2_784,
    storedPointCount: 171,
    utcTime: "18:17:10",
    center: Object.freeze([-104.1956, 25.24078]),
    bbox: Object.freeze([
      -105.1610791683197, 24.345703125, -103.22807550430298, 26.14741802215576,
    ]),
    recordBodySha256:
      "e244e445c810957b8c1d969d28e3feea04654c57f4ee9c370c7126adaf51aa3f",
    dbfRowSha256:
      "4d6da5a0dc03b127c2bab9cba8a89afebdd12c3643a26ca07f3015af91645ae4",
  }),
  Object.freeze({
    role: "greatest-eclipse-10-second-bracket-after",
    sourceIndex: 591,
    sourceRecordNumber: 592,
    sourceOffsetBytes: 1_856_428,
    contentBytes: 2_784,
    storedPointCount: 171,
    utcTime: "18:17:20",
    center: Object.freeze([-104.14985, 25.2883]),
    bbox: Object.freeze([
      -105.11703729629517, 24.3896484375, -103.18379759788513,
      26.19140088558197,
    ]),
    recordBodySha256:
      "bdb21fd3e6ac09aca5be6ffead7763dce6a144e4eeed24b40e270dc08dd37e42",
    dbfRowSha256:
      "f679541ef1de71d9a6724bff388dfdd8028f8794217cf4fe65ff081b344e7f18",
  }),
  Object.freeze({
    role: "named-observer-dallas",
    sourceIndex: 744,
    sourceRecordNumber: 745,
    sourceOffsetBytes: 2_288_628,
    contentBytes: 2_832,
    storedPointCount: 174,
    utcTime: "18:42:50",
    center: Object.freeze([-96.43722, 32.51228]),
    bbox: Object.freeze([
      -97.43116736412048, 31.586101055145264, -95.44056594371796, 33.4423828125,
    ]),
    recordBodySha256:
      "099cada8c0cd3ddc9a43e2932682efc3d17fc06384e1f459d133b37edd0b37e7",
    dbfRowSha256:
      "0f6782b7398e512f91abf1c0d0295f84c228bddd660c94522754ee9b5a504aeb",
  }),
]);

function invariant(condition, message) {
  if (!condition) {
    throw new Error(`NASA SVS 5073 derivation: ${message}`);
  }
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fingerprint(bytes) {
  return { bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function exactFingerprint(bytes, expected, label) {
  const actual = fingerprint(bytes);
  invariant(
    actual.bytes === expected.bytes,
    `${label} byte length ${actual.bytes} != ${expected.bytes}`,
  );
  invariant(
    actual.sha256 === expected.sha256,
    `${label} SHA-256 ${actual.sha256} != ${expected.sha256}`,
  );
}

function mainHeader(template, totalBytes, bbox) {
  invariant(
    totalBytes % 2 === 0,
    "Shapefile length is not a whole 16-bit word",
  );
  const result = Buffer.from(template.subarray(0, MAIN_HEADER_BYTES));
  result.writeInt32BE(totalBytes / 2, 24);
  for (let i = 0; i < 4; i++) {
    result.writeDoubleLE(bbox[i], 36 + i * 8);
  }
  return result;
}

function unionBbox(records) {
  return records.reduce(
    (bbox, record) => [
      Math.min(bbox[0], record.bbox[0]),
      Math.min(bbox[1], record.bbox[1]),
      Math.max(bbox[2], record.bbox[2]),
      Math.max(bbox[3], record.bbox[3]),
    ],
    [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ],
  );
}

function parseDbfLayout(dbf) {
  invariant(dbf[0] === 0x03, "source DBF is not dBASE III");
  const recordCount = dbf.readUInt32LE(4);
  const headerBytes = dbf.readUInt16LE(8);
  const recordBytes = dbf.readUInt16LE(10);
  invariant(
    headerBytes + recordCount * recordBytes === dbf.byteLength,
    "source DBF length is inconsistent",
  );
  invariant(
    dbf[headerBytes - 1] === 0x0d,
    "source DBF header terminator is absent",
  );
  return { recordCount, headerBytes, recordBytes };
}

function readSourceRecords({ shp, shx, dbf }) {
  invariant(
    shp.readInt32BE(0) === 9994 && shx.readInt32BE(0) === 9994,
    "source SHP/SHX file code changed",
  );
  invariant(
    shp.readInt32LE(28) === 1000 && shx.readInt32LE(28) === 1000,
    "source SHP/SHX version changed",
  );
  invariant(
    shp.readInt32LE(32) === 5 && shx.readInt32LE(32) === 5,
    "source is no longer Polygon shape type 5",
  );
  invariant(
    shp.readInt32BE(24) * 2 === shp.byteLength,
    "source SHP length header changed",
  );
  invariant(
    shx.readInt32BE(24) * 2 === shx.byteLength,
    "source SHX length header changed",
  );
  const indexCount = (shx.byteLength - MAIN_HEADER_BYTES) / 8;
  const dbfLayout = parseDbfLayout(dbf);
  invariant(
    Number.isInteger(indexCount) && indexCount === 1_181,
    `expected 1181 SHX rows, got ${indexCount}`,
  );
  invariant(
    dbfLayout.recordCount === indexCount,
    "source SHP/DBF records are not aligned",
  );

  const records = SVS_5073_SELECTIONS.map((selection) => {
    const indexPosition = MAIN_HEADER_BYTES + selection.sourceIndex * 8;
    const offsetBytes = shx.readInt32BE(indexPosition) * 2;
    const contentBytes = shx.readInt32BE(indexPosition + 4) * 2;
    invariant(
      offsetBytes === selection.sourceOffsetBytes,
      `${selection.utcTime} source offset changed`,
    );
    invariant(
      contentBytes === selection.contentBytes,
      `${selection.utcTime} content length changed`,
    );
    invariant(
      shp.readInt32BE(offsetBytes) === selection.sourceRecordNumber,
      `${selection.utcTime} source record number changed`,
    );
    invariant(
      shp.readInt32BE(offsetBytes + 4) * 2 === contentBytes,
      `${selection.utcTime} SHP/SHX length changed`,
    );
    const body = Buffer.from(
      shp.subarray(offsetBytes + 8, offsetBytes + 8 + contentBytes),
    );
    invariant(
      sha256(body) === selection.recordBodySha256,
      `${selection.utcTime} polygon body changed`,
    );
    invariant(
      body.readInt32LE(0) === 5,
      `${selection.utcTime} is no longer a Polygon`,
    );
    const bbox = [0, 1, 2, 3].map((i) => body.readDoubleLE(4 + i * 8));
    invariant(
      bbox.every((value, i) => Object.is(value, selection.bbox[i])),
      `${selection.utcTime} bounding box changed`,
    );
    invariant(
      body.readInt32LE(36) === 1,
      `${selection.utcTime} no longer has exactly one ring`,
    );
    invariant(
      body.readInt32LE(40) === selection.storedPointCount,
      `${selection.utcTime} point count changed`,
    );

    const dbfStart =
      dbfLayout.headerBytes + selection.sourceIndex * dbfLayout.recordBytes;
    const dbfRow = Buffer.from(
      dbf.subarray(dbfStart, dbfStart + dbfLayout.recordBytes),
    );
    invariant(
      sha256(dbfRow) === selection.dbfRowSha256,
      `${selection.utcTime} DBF row changed`,
    );
    invariant(dbfRow[0] === 0x20, `${selection.utcTime} DBF row is deleted`);
    return { selection, body, dbfRow, bbox };
  });
  return { records, dbfLayout };
}

/**
 * Rebuild canonical SHP/SHX/DBF containers from already-selected exact record
 * material. Exported so the standing spec can prove the checked-in containers
 * have one deterministic representation without needing the 79 MB archive.
 */
export function buildCroppedFixture({
  shpHeader,
  shxHeader,
  dbfHeader,
  prj,
  records,
}) {
  invariant(records.length > 0, "no records selected");
  const bbox = unionBbox(records);
  const shpBytes =
    MAIN_HEADER_BYTES +
    records.reduce((sum, record) => sum + 8 + record.body.byteLength, 0);
  const shxBytes = MAIN_HEADER_BYTES + records.length * 8;
  const shpChunks = [mainHeader(shpHeader, shpBytes, bbox)];
  const shx = Buffer.alloc(shxBytes);
  mainHeader(shxHeader, shxBytes, bbox).copy(shx, 0);
  let outputOffset = MAIN_HEADER_BYTES;
  records.forEach((record, index) => {
    invariant(
      record.body.byteLength % 2 === 0,
      `record ${index + 1} body has odd byte length`,
    );
    const recordHeader = Buffer.alloc(8);
    recordHeader.writeInt32BE(index + 1, 0);
    recordHeader.writeInt32BE(record.body.byteLength / 2, 4);
    shpChunks.push(recordHeader, record.body);
    shx.writeInt32BE(outputOffset / 2, MAIN_HEADER_BYTES + index * 8);
    shx.writeInt32BE(
      record.body.byteLength / 2,
      MAIN_HEADER_BYTES + index * 8 + 4,
    );
    outputOffset += 8 + record.body.byteLength;
  });
  invariant(
    outputOffset === shpBytes,
    "rebuilt SHP length arithmetic disagrees",
  );
  const shp = Buffer.concat(shpChunks, shpBytes);

  const headerBytes = dbfHeader.readUInt16LE(8);
  const recordBytes = dbfHeader.readUInt16LE(10);
  invariant(
    headerBytes <= dbfHeader.byteLength,
    "DBF header template is truncated",
  );
  const rebuiltDbfHeader = Buffer.from(dbfHeader.subarray(0, headerBytes));
  rebuiltDbfHeader.writeUInt32LE(records.length, 4);
  const dbfRows = records.map((record, index) => {
    invariant(
      record.dbfRow.byteLength === recordBytes,
      `DBF row ${index + 1} width changed`,
    );
    return record.dbfRow;
  });
  const dbf = Buffer.concat([rebuiltDbfHeader, ...dbfRows]);
  return { shp, shx, dbf, prj: Buffer.from(prj), bbox };
}

function fixtureSetSha256(outputs) {
  const hash = crypto.createHash("sha256");
  for (const extension of ["shp", "shx", "dbf", "prj"]) {
    const name = `${OUTPUT_STEM}.${extension}`;
    hash.update(Buffer.from(`${name}\0`, "utf8"));
    hash.update(outputs[extension]);
  }
  return hash.digest("hex");
}

function manifestFor(outputs, records, parsed) {
  const scriptFile = fileURLToPath(import.meta.url);
  const parserFile = path.join(here, "nasa-svs-5073-shapefile.mjs");
  const scriptBytes = fs.readFileSync(scriptFile);
  const parserBytes = fs.readFileSync(parserFile);
  const outputMembers = {};
  for (const extension of ["shp", "shx", "dbf", "prj"]) {
    outputMembers[extension] = {
      file: `${OUTPUT_STEM}.${extension}`,
      ...fingerprint(outputs[extension]),
    };
  }
  const selections = records.map(({ selection }, index) => {
    const feature = parsed.features[index];
    return {
      role: selection.role,
      iso8601: `2024-04-08T${selection.utcTime}Z`,
      sourceIndexZeroBased: selection.sourceIndex,
      sourceRecordNumber: selection.sourceRecordNumber,
      outputRecordNumber: index + 1,
      sourceOffsetBytes: selection.sourceOffsetBytes,
      contentBytes: selection.contentBytes,
      storedPointCount: selection.storedPointCount,
      distinctNonClosingVertices: selection.storedPointCount - 1,
      bbox: selection.bbox,
      centerLonLat: selection.center,
      durationSeconds: feature.properties.Duration,
      recordBodySha256: selection.recordBodySha256,
      dbfRowSha256: selection.dbfRowSha256,
    };
  });
  return {
    schema: "nasa-svs-5073-umbra-lo-c1229-s5-fixture-v1",
    title:
      "2024 Total Solar Eclipse: Shapefiles — exact low-resolution umbra records",
    source: {
      publisher:
        "NASA/Goddard Space Flight Center Scientific Visualization Studio",
      page: "https://svs.gsfc.nasa.gov/5073/",
      archive: SVS_5073_ARCHIVE,
      members: SVS_5073_SOURCE_MEMBERS,
      sourceRecordCount: 1_181,
      projection: {
        crsInterpretation:
          "ESRI WKT1 GCS_WGS_1984 on the WGS 84 datum and ellipsoid; comparable to EPSG:4326 without importing EPSG's latitude-first axis rule",
        axisOrderUsedByShapefile: [
          "longitude-east-degrees",
          "latitude-north-degrees",
        ],
        axisOrderBasis:
          "ESRI Shapefile Polygon stores x then y; the copied records are therefore consumed as longitude then latitude",
        wkt: parsed.projectionWkt,
        ellipsoid: {
          semiMajorAxisMeters: 6_378_137,
          inverseFlattening: 298.257223563,
        },
      },
    },
    selection: {
      event: "2024-04-08 total solar eclipse",
      rationale:
        "Exact 10-second rows for named Mazatlan and Dallas observer lanes, plus the two source rows bracketing NASA's 18:17:16 greatest-eclipse instant.",
      records: selections,
      storedPointCount: selections.reduce(
        (sum, row) => sum + row.storedPointCount,
        0,
      ),
      distinctNonClosingVertices: selections.reduce(
        (sum, row) => sum + row.distinctNonClosingVertices,
        0,
      ),
      countCorrection:
        "The design input said 694 vertices, but the authoritative SHP bodies contain 171 + 171 + 171 + 174 = 687 stored points (683 after removing one duplicated closing point per ring). No vertices were manufactured or resampled.",
    },
    derivation: {
      script: {
        file: "derive-umbra-lo-shard.mjs",
        ...fingerprint(scriptBytes),
      },
      parser: {
        file: "nasa-svs-5073-shapefile.mjs",
        ...fingerprint(parserBytes),
      },
      inputPolicy:
        "Verify all four full source-member byte lengths and SHA-256 hashes before reading any selected record.",
      copiedExactly: [
        "Each selected SHP Polygon content body (the eight-byte record header is rebuilt).",
        "Each selected 83-byte DBF record.",
        "All 143 PRJ bytes.",
      ],
      rebuiltDeterministically: [
        "SHP/SHX 100-byte main headers: source template with output file length and selected union bbox rewritten.",
        "SHP record headers: sequential output record numbers 1..4 and exact content lengths.",
        "SHX entries: exact output offsets and content lengths.",
        "DBF header: source header with only the little-endian record count changed from 1181 to 4.",
      ],
      resample: "none",
      reprojection: "none",
      coordinateRounding:
        "none; source IEEE-754 binary64 coordinate bytes are copied",
      outputOrder: "ascending source index / UTC",
    },
    output: {
      members: outputMembers,
      fixtureSetSha256: fixtureSetSha256(outputs),
      recordCount: parsed.features.length,
      shapeType: 5,
      bbox: outputs.bbox,
    },
    creditAndUse: {
      requestedCredit: "NASA's Scientific Visualization Studio",
      publisher:
        "NASA/Goddard Space Flight Center Scientific Visualization Studio",
      pageCreators: {
        visualizers: ["Michala Garrison (SSAI)", "Ernie Wright (USRA)"],
        scientists: ["Michael S. Kirk (NASA/GSFC)", "Carolyn Ng"],
        projectManager: "Shannon Reed (ADNET Systems, Inc.)",
        technicalSupport: [
          "Laurence Schuler (ADNET Systems, Inc.)",
          "Ian Jones (ADNET Systems, Inc.)",
        ],
      },
      retain:
        "Retain the NASA SVS product title, source page, exact archive/member pins, requested credit, creator credits, and NOTICE.md with redistributed fixture bytes.",
      termsPosition:
        "NASA media guidance generally permits factual reuse of NASA content without an implied endorsement. This provenance record is not a public-domain dedication and does not override a page-specific third-party marking.",
      noEndorsement:
        "NASA's name and this fixture must not be used to imply NASA endorsement.",
      pageReview:
        "SVS 5073 identifies the requested NASA SVS credit and the named creators recorded above; no page-specific third-party restriction is attached to the 2024 eclipse shapefile download.",
      usageGuidelines:
        "https://www.nasa.gov/nasa-brand-center/images-and-media/",
      notice: "NOTICE.md",
    },
  };
}

export function deriveFixtureFromBytes(source) {
  for (const [extension, expected] of Object.entries(SVS_5073_SOURCE_MEMBERS)) {
    invariant(
      Buffer.isBuffer(source[extension]),
      `${extension} source is not a Buffer`,
    );
    exactFingerprint(source[extension], expected, expected.file);
  }
  const { records, dbfLayout } = readSourceRecords(source);
  const outputs = buildCroppedFixture({
    shpHeader: source.shp,
    shxHeader: source.shx,
    dbfHeader: source.dbf.subarray(0, dbfLayout.headerBytes),
    prj: source.prj,
    records,
  });
  const parsed = parseSvs5073UmbraShapefile(outputs);
  invariant(
    parsed.features.length === records.length,
    "rebuilt fixture does not parse to four records",
  );
  const manifest = manifestFor(outputs, records, parsed);
  invariant(
    manifest.selection.storedPointCount === 687,
    "authoritative stored-point count is not 687",
  );
  invariant(
    manifest.selection.distinctNonClosingVertices === 683,
    "authoritative distinct vertex count is not 683",
  );
  return { ...outputs, manifest, records };
}

export function deriveFixtureFromDirectory(sourceDirectory) {
  const source = {};
  for (const [extension, expected] of Object.entries(SVS_5073_SOURCE_MEMBERS)) {
    source[extension] = fs.readFileSync(
      path.join(sourceDirectory, expected.file),
    );
  }
  return deriveFixtureFromBytes(source);
}

function parseArguments(argv) {
  const result = { outputDirectory: here };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === "--source-dir") {
      result.sourceDirectory = argv[++i];
    } else if (argument === "--output-dir") {
      result.outputDirectory = argv[++i];
    } else if (argument === "--archive") {
      result.archive = argv[++i];
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  invariant(
    typeof result.sourceDirectory === "string",
    "--source-dir is required",
  );
  return result;
}

function writeFixture(result, outputDirectory) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const extension of ["shp", "shx", "dbf", "prj"]) {
    fs.writeFileSync(
      path.join(outputDirectory, `${OUTPUT_STEM}.${extension}`),
      result[extension],
    );
  }
  const manifestText = `${JSON.stringify(result.manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(outputDirectory, "manifest.json"), manifestText);
  return manifestText;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.archive) {
      exactFingerprint(
        fs.readFileSync(options.archive),
        SVS_5073_ARCHIVE,
        SVS_5073_ARCHIVE.file,
      );
    }
    const result = deriveFixtureFromDirectory(
      path.resolve(options.sourceDirectory),
    );
    const manifestText = writeFixture(
      result,
      path.resolve(options.outputDirectory),
    );
    console.log(
      JSON.stringify(
        {
          outputDirectory: path.resolve(options.outputDirectory),
          fixtureSetSha256: result.manifest.output.fixtureSetSha256,
          manifestSha256: sha256(Buffer.from(manifestText)),
          storedPointCount: result.manifest.selection.storedPointCount,
          distinctNonClosingVertices:
            result.manifest.selection.distinctNonClosingVertices,
          members: result.manifest.output.members,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  }
}
