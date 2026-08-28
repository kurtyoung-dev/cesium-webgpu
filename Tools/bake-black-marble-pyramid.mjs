// bake-black-marble-pyramid.mjs
//
// @purpose Bakes the bundled offline night-imagery pyramid (Assets/Textures/BlackMarble) from a NASA Black Marble source image, mirroring the NaturalEarthII TMS geodetic layout tile for tile.
// @status ACTIVE
//
// The output mirrors packages/engine/Source/Assets/Textures/NaturalEarthII
// exactly: EPSG:4326, geodetic profile, 256px JPEG tiles, TMS y-up
// ({z}/{x}/{y}.jpg with y=0 at the southern edge), levels 0-2 (2x1, 4x2, 8x4
// tiles). The source image is a plate carree (equirectangular) global JPEG,
// e.g. NASA's BlackMarble_2016_3km.jpg (13500x6750, public domain). The
// source SHA-256 and the sharp version are recorded in the emitted README so
// the bake is reproducible and its provenance auditable.
//
// Usage:
//   node Tools/bake-black-marble-pyramid.mjs <source.jpg> [outDir] [--quality=N] [--maxLevel=N]
//
// Defaults: outDir = packages/engine/Source/Assets/Textures/BlackMarble,
// quality = 80, maxLevel = 2. The size-gate figure (total bytes) prints at
// the end; the ruling that governs it caps levels 0-2 at roughly half a
// megabyte, with a deeper level needing a re-measured variant table first.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => a.replace(/^--/, "").split("=")),
);
const sourcePath = args[0];
if (!sourcePath || !fs.existsSync(sourcePath)) {
  console.error(
    "usage: node Tools/bake-black-marble-pyramid.mjs <source.jpg> [outDir]",
  );
  process.exit(2);
}
const outDir = args[1] ?? "packages/engine/Source/Assets/Textures/BlackMarble";
const quality = Number(flags.quality ?? 80);
const maxLevel = Number(flags.maxLevel ?? 2);
const TILE = 256;

const sourceBytes = fs.readFileSync(sourcePath);
const sourceSha = crypto.createHash("sha256").update(sourceBytes).digest("hex");

let total = 0;
let tileCount = 0;
for (let z = 0; z <= maxLevel; z++) {
  const cols = 2 ** (z + 1);
  const rows = 2 ** z;
  const levelPng = await sharp(sourceBytes)
    .resize(cols * TILE, rows * TILE, { fit: "fill", kernel: "lanczos3" })
    .png()
    .toBuffer();
  for (let x = 0; x < cols; x++) {
    for (let yTms = 0; yTms < rows; yTms++) {
      const top = (rows - 1 - yTms) * TILE;
      const tile = await sharp(levelPng)
        .extract({ left: x * TILE, top, width: TILE, height: TILE })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      const dir = path.join(outDir, String(z), String(x));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${yTms}.jpg`), tile);
      total += tile.length;
      tileCount += 1;
    }
  }
  console.log(`level ${z}: ${cols}x${rows} tiles`);
}

const tileSets = [];
for (let z = 0; z <= maxLevel; z++) {
  tileSets.push(
    `        <TileSet href="${z}" units-per-pixel="${(180 / (2 ** z * TILE)).toFixed(14)}" order="${z}"/>`,
  );
}
const xml = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '    <TileMap version="1.0.0" tilemapservice="http://tms.osgeo.org/1.0.0">',
  `      <Title>${path.basename(sourcePath)}</Title>`,
  "      <Abstract></Abstract>",
  "      <SRS>EPSG:4326</SRS>",
  '      <BoundingBox miny="-90.00000000000000" minx="-180.00000000000000" maxy="90.00000000000000" maxx="180.00000000000000"/>',
  '      <Origin y="-90.00000000000000" x="-180.00000000000000"/>',
  '      <TileFormat width="256" height="256" mime-type="image/jpg" extension="jpg"/>',
  '      <TileSets profile="geodetic">',
  ...tileSets,
  "      </TileSets>",
  "    </TileMap>",
  "",
].join("\n");
fs.writeFileSync(path.join(outDir, "tilemapresource.xml"), xml);

const readme = [
  "# Black Marble offline night-imagery pyramid",
  "",
  "Earth at night, baked from NASA's Black Marble composite for use as the",
  "bundled default night imagery layer. NASA imagery is in the public domain;",
  "attribution is a courtesy, not a license condition:",
  "",
  "> Image: NASA Earth Observatory / NOAA NGDC (Suomi NPP VIIRS Black Marble).",
  "",
  "Provenance (reproducible bake):",
  "",
  `- Source file: ${path.basename(sourcePath)}`,
  `- Source SHA-256: ${sourceSha}`,
  "- Source URL:",
  "  <https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_3km.jpg>",
  `- Bake: node Tools/bake-black-marble-pyramid.mjs`,
  `  (quality ${quality}, maxLevel ${maxLevel}, sharp ${sharp.versions?.sharp ?? require("sharp/package.json").version})`,
  "",
  "Layout mirrors ../NaturalEarthII: EPSG:4326 geodetic TMS, 256px JPEG tiles,",
  "{z}/{x}/{y}.jpg with y=0 at the southern edge.",
  "",
].join("\n");
fs.writeFileSync(path.join(outDir, "README.md"), readme);

console.log(`source sha256: ${sourceSha}`);
console.log(
  `tiles: ${tileCount}, total tile bytes: ${total} (${(total / 1024).toFixed(1)} KB)`,
);
