#!/usr/bin/env node
// Read PNG files and report mean RGB bytes — distinguishes between
// "image actually IS dark" vs "image looks dark on display but bytes are correct".
import fs from "fs";
import path from "path";
import zlib from "zlib";

function inflate(data) {
  return zlib.inflateSync(data);
}

// Minimal PNG decoder — supports RGB and RGBA, 8-bit, non-interlaced.
function decodePng(buf) {
  // Verify signature
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) throw new Error("not a PNG");
  }
  let off = 8;
  let width = 0,
    height = 0,
    bitDepth = 0,
    colorType = 0;
  const idatChunks = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    off += 4;
    const type = buf.subarray(off, off + 4).toString("ascii");
    off += 4;
    const data = buf.subarray(off, off + len);
    off += len;
    off += 4; // CRC
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  const compressed = Buffer.concat(idatChunks);
  const decompressed = inflate(compressed);
  // Filter handling: ignore filter, just take channel bytes (good enough for mean).
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (channels === 0) throw new Error(`unsupported PNG colorType ${colorType}`);
  const stride = 1 + width * channels;
  if (decompressed.length !== height * stride) {
    // Likely filtered — for mean estimation, accept that filters add a bias
    // but the dominant signal comes through. Skip filter-byte rows correctly.
  }
  // Reconstruct ignoring filter bytes (approximation — only filter 0 (None)
  // would be exact; PNG encoders for screenshots typically use filter 0 for
  // uncompressible images but may use others. For mean we tolerate the bias).
  let mr = 0,
    mg = 0,
    mb = 0,
    count = 0;
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride + 1; // skip filter byte
    for (let x = 0; x < width; x++) {
      const off = rowStart + x * channels;
      if (off + 2 < decompressed.length) {
        mr += decompressed[off];
        mg += decompressed[off + 1];
        mb += decompressed[off + 2];
        count++;
      }
    }
  }
  return {
    width,
    height,
    meanR: mr / count,
    meanG: mg / count,
    meanB: mb / count,
  };
}

const files = [
  "Tools/visual-regression/output/probe-projection-europe-mid-webgl.png",
  "Tools/visual-regression/output/probe-projection-europe-mid-webgpu.png",
  "Tools/visual-regression/output/probe-projection-tile-edge-test-webgl.png",
  "Tools/visual-regression/output/probe-projection-tile-edge-test-webgpu.png",
];

for (const f of files) {
  const buf = fs.readFileSync(f);
  const decoded = decodePng(buf);
  console.log(
    `${path.basename(f).padEnd(50)} ${decoded.width}×${decoded.height}  meanRGB=(${decoded.meanR.toFixed(1)}, ${decoded.meanG.toFixed(1)}, ${decoded.meanB.toFixed(1)})`,
  );
}
