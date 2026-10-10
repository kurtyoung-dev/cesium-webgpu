// voxel-shape-parity-verdicts.mjs — the clauses the two non-box voxel shape
// probes share.
//
// @purpose The eight shape-parity clauses (render, bounded, footprint IoU, projected area, user pipeline, interior per-cell colour match, reference colour spread, console errors) probe-voxel-ellipsoid and probe-voxel-cylinder judge their WebGL/WebGPU pair by, over one frame measurement each.
// @status ACTIVE
//
// WHY ONE MODULE FOR TWO PROBES. `probe-voxel-ellipsoid.mjs` (B22 + B23) and
// `probe-voxel-cylinder.mjs` (B24) were one file copied: the diff between them
// was the provider's shape, bounds and scale, the camera comment and the PNG
// name — every measurement, bar and clause was the same text. Two copies of a
// gate drift; this is the one copy. Each probe keeps its own scene (the in-page
// provider it builds) and its own rig; the measurement and the judgement of a
// frame pair live here.
//
// THE CLAUSES, UNCHANGED. Footprint IoU >= 0.85 and a projected-area delta of
// at most 15 % are the silhouette discriminators (a box OBB silhouette against
// WebGL's ellipse or cylinder lands well under the gate). Both coverages must
// sit in (8 %, 92 %) so the IoU is not trivially 1. The shapeUv chain is judged
// per grid cell over the INTERIOR (all four neighbours marked in both frames,
// keeping silhouette-edge sampling noise out), a cell matching under RGB
// distance 60, with at least 100 interior cells and 85 % matched; the WebGL
// reference must itself carry the colour pattern (red plus green spread over
// 30) or the colour clause would be vacuous. The WebGPU colour pipeline must be
// the USER-customShader variant on real data, and neither backend may log a
// console error.

import {
  VOXEL_FOOTPRINT_LUM_THRESHOLD,
  VOXEL_PARITY_REGION,
  footprintGrid,
  fractionalRegion,
  interiorCellColourMatch,
  maskIoU,
  regionColourStats,
} from "./metrics/voxel-footprint.mjs";

/**
 * Measure one decoded frame the way both shape probes did: the centred
 * region's 64x48 footprint grid with per-cell colours, and the colour and
 * coverage of its non-black pixels.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} frame Decoded RGBA.
 * @returns {object} `{grid, maskCells, avgColor, coveragePct}`.
 */
export function measureShapeFrame(frame) {
  const region = fractionalRegion(frame, VOXEL_PARITY_REGION);
  const grid = footprintGrid(frame, region);
  const stats = regionColourStats(frame, region, {
    lumThreshold: VOXEL_FOOTPRINT_LUM_THRESHOLD,
  });
  return {
    grid,
    maskCells: grid.maskCells,
    avgColor: stats.avgColor,
    coveragePct: stats.coveragePct,
  };
}

/**
 * The pair's derived numbers, in one place so the verdicts and the report
 * print the same values.
 *
 * @param {object} webgl `{info, px, consoleErrors}` for the WebGL leg.
 * @param {object} webgpu The same for the WebGPU leg.
 * @returns {object}
 */
export function shapeParityNumbers(webgl, webgpu) {
  const iou = maskIoU(webgl.px.grid.mask, webgpu.px.grid.mask).iou;
  const covGL = webgl.px.coveragePct;
  const covGPU = webgpu.px.coveragePct;
  const areaRatioDelta = covGL > 0 ? Math.abs(covGPU - covGL) / covGL : 1;
  const cells = interiorCellColourMatch(webgl.px.grid, webgpu.px.grid);
  return { iou, covGL, covGPU, areaRatioDelta, cells };
}

/**
 * The eight clauses over each run's WebGL/WebGPU pair.
 *
 * @param {Array<{run: number, webgl: object, webgpu: object}>} cells One cell per run.
 * @returns {Array<object>} Verdicts in the runtime's shape.
 */
export function evaluateShapeParity(cells) {
  const verdicts = [];
  for (const { run, webgl, webgpu } of cells) {
    const s = `run${run}`;
    const n = shapeParityNumbers(webgl, webgpu);
    const add = (id, claim, pass, detail) =>
      verdicts.push({ id: `${id}/${s}`, claim, pass: pass === true, detail });
    add(
      "both-render",
      `both backends render (${webgl.px.maskCells} and ${webgpu.px.maskCells} footprint cells > 200)`,
      webgl.px.maskCells > 200 && webgpu.px.maskCells > 200,
    );
    add(
      "bounded",
      `both 8% < coverage < 92% (${n.covGL.toFixed(2)}%, ${n.covGPU.toFixed(2)}%)`,
      n.covGL < 92 && n.covGPU < 92 && n.covGL > 8 && n.covGPU > 8,
    );
    add(
      "footprint-match",
      `footprint IoU ${n.iou.toFixed(3)} >= 0.85`,
      n.iou >= 0.85,
      { iou: n.iou },
    );
    add(
      "area-match",
      `|ΔA|/A ${(n.areaRatioDelta * 100).toFixed(1)}% <= 15%`,
      n.areaRatioDelta <= 0.15,
      { areaRatioDelta: n.areaRatioDelta },
    );
    add(
      "gpu-user-pipeline",
      "WebGPU real data on the user-customShader colour pipeline",
      webgpu.info.usingRealData === true &&
        typeof webgpu.info.colorDescName === "string" &&
        webgpu.info.colorDescName.includes("userCustomShader"),
      { colorDescName: webgpu.info.colorDescName ?? null },
    );
    add(
      "cell-colours-match",
      `>= 100 interior cells (${n.cells.interiorCells}), >= 85% matched (${(n.cells.matchFraction * 100).toFixed(1)}%)`,
      n.cells.interiorCells >= 100 && n.cells.matchFraction >= 0.85,
      { ...n.cells },
    );
    add(
      "colour-gate-discriminates",
      `WebGL R+G spread ${n.cells.referenceSpread.toFixed(1)} > 30`,
      n.cells.referenceSpread > 30,
    );
    add(
      "no-console-errors",
      `no console errors (${webgl.consoleErrors.length} WebGL, ${webgpu.consoleErrors.length} WebGPU)`,
      webgl.consoleErrors.length === 0 && webgpu.consoleErrors.length === 0,
      {
        webgl: webgl.consoleErrors.slice(0, 5),
        webgpu: webgpu.consoleErrors.slice(0, 5),
      },
    );
  }
  return verdicts;
}

/**
 * A cell as the receipt publishes it: the footprint grid is replaced by the
 * numbers derived from it.
 *
 * @param {object} cell
 * @returns {object}
 */
export function publishedShapeCell(cell) {
  const strip = (leg) => ({
    ...leg,
    px: {
      maskCells: leg.px.maskCells,
      avgColor: leg.px.avgColor,
      coveragePct: leg.px.coveragePct,
    },
  });
  return {
    run: cell.run,
    numbers: shapeParityNumbers(cell.webgl, cell.webgpu),
    webgl: strip(cell.webgl),
    webgpu: strip(cell.webgpu),
  };
}
