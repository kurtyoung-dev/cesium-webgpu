/**
 * Dependency-free reader for the small NASA SVS 5073 polygon fixture beside
 * this file. The module deliberately has no Node imports so the same bytes can
 * be parsed by `node --test` and by a same-origin browser probe.
 * @purpose Dependency-free ESRI Shapefile Polygon + dBASE reader for the SVS 5073 umbra fixture, parseable by node --test and same-origin browser probes alike.
 * @status ACTIVE
 *
 * Scope is intentionally narrow and loud: ESRI Shapefile Polygon (type 5),
 * one SHP/SHX pair, dBASE III character/numeric fields, and WGS84 lon/lat
 * coordinates. Unsupported input is rejected instead of guessed.
 */

const SHAPEFILE_HEADER_BYTES = 100;
const SHAPEFILE_FILE_CODE = 9994;
const SHAPEFILE_VERSION = 1000;
const POLYGON_SHAPE_TYPE = 5;

function invariant(condition, message) {
  if (!condition) {
    throw new Error(`NASA SVS 5073 fixture: ${message}`);
  }
}

function asBytes(input, label) {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError(`${label} must be an ArrayBuffer or typed-array view`);
}

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function ascii(bytes, start, length) {
  let result = "";
  const end = start + length;
  for (let i = start; i < end; i++) {
    result += String.fromCharCode(bytes[i]);
  }
  return result;
}

function nulTerminatedAscii(bytes, start, length) {
  let end = start;
  const limit = start + length;
  while (end < limit && bytes[end] !== 0) {
    end++;
  }
  return ascii(bytes, start, end - start);
}

function parseMainHeader(input, label) {
  const bytes = asBytes(input, label);
  invariant(
    bytes.byteLength >= SHAPEFILE_HEADER_BYTES,
    `${label} is truncated`,
  );
  const view = viewOf(bytes);
  invariant(
    view.getInt32(0, false) === SHAPEFILE_FILE_CODE,
    `${label} file code is not 9994`,
  );
  invariant(
    view.getInt32(28, true) === SHAPEFILE_VERSION,
    `${label} version is not 1000`,
  );
  invariant(
    view.getInt32(32, true) === POLYGON_SHAPE_TYPE,
    `${label} is not Polygon shape type 5`,
  );
  const declaredBytes = view.getInt32(24, false) * 2;
  invariant(
    declaredBytes === bytes.byteLength,
    `${label} length header disagrees`,
  );
  return {
    bytes,
    view,
    declaredBytes,
    bbox: [
      view.getFloat64(36, true),
      view.getFloat64(44, true),
      view.getFloat64(52, true),
      view.getFloat64(60, true),
    ],
    zRange: [view.getFloat64(68, true), view.getFloat64(76, true)],
    mRange: [view.getFloat64(84, true), view.getFloat64(92, true)],
  };
}

function parseIndex(shxInput) {
  const header = parseMainHeader(shxInput, "SHX");
  invariant(
    (header.bytes.byteLength - 100) % 8 === 0,
    "SHX table is truncated",
  );
  const entries = [];
  for (let position = 100; position < header.bytes.byteLength; position += 8) {
    entries.push({
      offsetBytes: header.view.getInt32(position, false) * 2,
      contentBytes: header.view.getInt32(position + 4, false) * 2,
    });
  }
  return { ...header, entries };
}

function parsePolygonRecord(shpHeader, entry, index) {
  const { bytes, view } = shpHeader;
  const recordStart = entry.offsetBytes;
  const contentStart = recordStart + 8;
  const recordEnd = contentStart + entry.contentBytes;
  invariant(
    recordStart >= 100,
    `record ${index + 1} points inside the SHP header`,
  );
  invariant(recordEnd <= bytes.byteLength, `record ${index + 1} is truncated`);
  const recordNumber = view.getInt32(recordStart, false);
  const headerContentBytes = view.getInt32(recordStart + 4, false) * 2;
  invariant(
    headerContentBytes === entry.contentBytes,
    `record ${index + 1} SHP/SHX lengths disagree`,
  );
  invariant(
    view.getInt32(contentStart, true) === POLYGON_SHAPE_TYPE,
    `record ${index + 1} is not Polygon shape type 5`,
  );
  invariant(
    entry.contentBytes >= 44,
    `record ${index + 1} polygon header is truncated`,
  );

  const bbox = [
    view.getFloat64(contentStart + 4, true),
    view.getFloat64(contentStart + 12, true),
    view.getFloat64(contentStart + 20, true),
    view.getFloat64(contentStart + 28, true),
  ];
  const partCount = view.getInt32(contentStart + 36, true);
  const pointCount = view.getInt32(contentStart + 40, true);
  invariant(partCount > 0, `record ${index + 1} has no rings`);
  invariant(
    pointCount >= partCount * 4,
    `record ${index + 1} has too few points`,
  );
  const partTable = contentStart + 44;
  const pointTable = partTable + partCount * 4;
  invariant(
    pointTable + pointCount * 16 === recordEnd,
    `record ${index + 1} has unexpected Polygon payload bytes`,
  );

  const starts = [];
  for (let part = 0; part < partCount; part++) {
    starts.push(view.getInt32(partTable + part * 4, true));
  }
  invariant(
    starts[0] === 0,
    `record ${index + 1} first ring does not start at zero`,
  );
  for (let part = 1; part < starts.length; part++) {
    invariant(
      starts[part] > starts[part - 1] && starts[part] < pointCount,
      `record ${index + 1} ring offsets are not ordered`,
    );
  }

  const coordinates = [];
  for (let part = 0; part < partCount; part++) {
    const first = starts[part];
    const last = part + 1 < partCount ? starts[part + 1] : pointCount;
    invariant(
      last - first >= 4,
      `record ${index + 1} ring ${part} is too short`,
    );
    const ring = [];
    for (let point = first; point < last; point++) {
      const position = pointTable + point * 16;
      ring.push([
        view.getFloat64(position, true),
        view.getFloat64(position + 8, true),
      ]);
    }
    const head = ring[0];
    const tail = ring[ring.length - 1];
    invariant(
      head[0] === tail[0] && head[1] === tail[1],
      `record ${index + 1} ring ${part} is not closed`,
    );
    coordinates.push(ring);
  }

  return {
    recordNumber,
    bbox,
    partCount,
    pointCount,
    geometry: { type: "Polygon", coordinates },
  };
}

function parseDbf(dbfInput) {
  const bytes = asBytes(dbfInput, "DBF");
  invariant(bytes.byteLength >= 33, "DBF header is truncated");
  const view = viewOf(bytes);
  invariant(bytes[0] === 0x03, "DBF is not dBASE III without memo");
  const recordCount = view.getUint32(4, true);
  const headerBytes = view.getUint16(8, true);
  const recordBytes = view.getUint16(10, true);
  invariant(
    headerBytes >= 33 && headerBytes <= bytes.byteLength,
    "DBF header length is invalid",
  );
  invariant(
    bytes[headerBytes - 1] === 0x0d,
    "DBF field table lacks its terminator",
  );
  invariant(
    headerBytes + recordCount * recordBytes === bytes.byteLength,
    "DBF length does not equal header plus records",
  );

  const fields = [];
  let fieldOffset = 1;
  for (let position = 32; position < headerBytes - 1; position += 32) {
    invariant(
      position + 32 <= headerBytes,
      "DBF field descriptor is truncated",
    );
    const name = nulTerminatedAscii(bytes, position, 11);
    const type = String.fromCharCode(bytes[position + 11]);
    const length = bytes[position + 16];
    const decimalCount = bytes[position + 17];
    invariant(name.length > 0 && length > 0, "DBF field descriptor is invalid");
    invariant(
      type === "C" || type === "N" || type === "F",
      `unsupported DBF field ${name}:${type}`,
    );
    fields.push({ name, type, length, decimalCount, offset: fieldOffset });
    fieldOffset += length;
  }
  invariant(
    fieldOffset === recordBytes,
    "DBF field widths do not fill a record",
  );

  const records = [];
  for (let record = 0; record < recordCount; record++) {
    const start = headerBytes + record * recordBytes;
    invariant(
      bytes[start] === 0x20,
      `DBF record ${record + 1} is deleted or invalid`,
    );
    const properties = {};
    for (const field of fields) {
      const raw = ascii(bytes, start + field.offset, field.length).trim();
      if (field.type === "C") {
        properties[field.name] = raw;
      } else if (raw === "") {
        properties[field.name] = null;
      } else {
        const value = Number(raw);
        invariant(
          Number.isFinite(value),
          `DBF record ${record + 1} field ${field.name} is not numeric`,
        );
        properties[field.name] = value;
      }
    }
    records.push(properties);
  }
  return {
    version: bytes[0],
    lastUpdated: {
      year: 1900 + bytes[1],
      month: bytes[2],
      day: bytes[3],
    },
    headerBytes,
    recordBytes,
    fields,
    records,
  };
}

/**
 * Parse the four members into a GeoJSON FeatureCollection. `projectionWkt` and
 * `shapefile` are GeoJSON foreign members used as evidence by the probe.
 */
export function parseSvs5073UmbraShapefile({ shp, shx, dbf, prj }) {
  const shpHeader = parseMainHeader(shp, "SHP");
  const index = parseIndex(shx);
  invariant(
    shpHeader.bbox.every((value, i) => value === index.bbox[i]),
    "SHP and SHX bounding boxes disagree",
  );
  const table = parseDbf(dbf);
  invariant(
    index.entries.length === table.records.length,
    "SHP/DBF record counts disagree",
  );

  const projectionBytes = asBytes(prj, "PRJ");
  const projectionWkt = ascii(projectionBytes, 0, projectionBytes.byteLength);
  invariant(
    /^GEOGCS\["GCS_WGS_1984",DATUM\["D_WGS_1984"/.test(projectionWkt),
    "PRJ is not the pinned WGS84 geographic CRS",
  );

  const features = index.entries.map((entry, featureIndex) => {
    const polygon = parsePolygonRecord(shpHeader, entry, featureIndex);
    return {
      type: "Feature",
      id: featureIndex + 1,
      bbox: polygon.bbox,
      geometry: polygon.geometry,
      properties: {
        ...table.records[featureIndex],
        _shpRecordNumber: polygon.recordNumber,
        _storedPointCount: polygon.pointCount,
      },
    };
  });

  return {
    type: "FeatureCollection",
    bbox: shpHeader.bbox,
    features,
    projectionWkt,
    shapefile: {
      fileCode: SHAPEFILE_FILE_CODE,
      version: SHAPEFILE_VERSION,
      shapeType: POLYGON_SHAPE_TYPE,
      dbf: {
        version: table.version,
        lastUpdated: table.lastUpdated,
        fields: table.fields,
      },
    },
  };
}

export const SVS_5073_SUPPORTED_SHAPE_TYPE = POLYGON_SHAPE_TYPE;
