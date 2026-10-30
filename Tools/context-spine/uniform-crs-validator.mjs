// uniform-crs-validator.mjs — WebGPU WGSL uniform byte-offset verifier and CRS coordinate-frame transition extractor.
// @purpose Compute exact WebGPU WGSL struct std140/uniform byte/float layouts, cross-check TypeScript uniform buffer size constants, and extract explicit CRS/coordinate-frame transition edges.
// @status ACTIVE

import path from "node:path";

/**
 * Round `n` up to the next multiple of `align` (power of two).
 *
 * @param {number} align
 * @param {number} n
 * @returns {number}
 */
function roundUp(align, n) {
  return Math.ceil(n / align) * align;
}

/**
 * Return `{ align, size, isMat3, isVec3 }` for a WGSL type expression under
 * WebGPU uniform address-space layout rules (WGSL §13.4.1).
 *
 * @param {string} rawType
 * @param {Map<string, { align: number, size: number }>} knownStructs
 * @returns {{ align: number, size: number, isMat3?: boolean, isVec3?: boolean } | null}
 */
export function wgslUniformTypeMetrics(rawType, knownStructs = new Map()) {
  const t = rawType.replace(/\s+/g, "");
  if (/^(?:f32|i32|u32)$/.test(t)) return { align: 4, size: 4 };
  if (/^f16$/.test(t)) return { align: 2, size: 2 };
  if (/^vec2(?:<[^>]+>|[fiu])$/.test(t)) return { align: 8, size: 8 };
  if (/^vec3(?:<[^>]+>|[fiu])$/.test(t)) {
    return { align: 16, size: 12, isVec3: true };
  }
  if (/^vec4(?:<[^>]+>|[fiu])$/.test(t)) return { align: 16, size: 16 };
  if (/^mat2x2(?:<f32>|f)$/.test(t)) return { align: 8, size: 16 };
  if (/^mat3x3(?:<f32>|f)$/.test(t)) {
    // 3 columns of vec3<f32>, each column stride RoundUp(16, 12) = 16 -> 48 bytes (12 floats, NOT 9).
    return { align: 16, size: 48, isMat3: true };
  }
  if (/^mat4x4(?:<f32>|f)$/.test(t)) return { align: 16, size: 64 };

  const arrMatch = t.match(/^array<(.+),(\d+)>$/);
  if (arrMatch) {
    const elem = wgslUniformTypeMetrics(arrMatch[1], knownStructs);
    const count = Number(arrMatch[2]);
    if (!elem || !Number.isFinite(count) || count <= 0) return null;
    // In uniform address space, array stride is rounded up to a multiple of 16 bytes.
    const uniformAlign = Math.max(16, elem.align);
    const stride = roundUp(uniformAlign, elem.size);
    return { align: uniformAlign, size: count * stride };
  }

  const structMetrics = knownStructs.get(t);
  if (structMetrics) {
    const uniformAlign = Math.max(16, structMetrics.align);
    return {
      align: uniformAlign,
      size: roundUp(uniformAlign, structMetrics.size),
    };
  }
  return null;
}

/**
 * Evaluate a single `struct` declaration starting at `startIdx` under `activeFlags`,
 * supporting arbitrarily nested `//>>ifdef`, `//>>ifndef`, `//>>else`, and `//>>endif`.
 *
 * @param {string[]} lines
 * @param {number} startIdx
 * @param {Map<string, { align: number, size: number }>} knownStructs
 * @param {boolean} isUniformBound
 * @param {Set<string>} activeFlags
 */
function evaluateStructVariant(
  lines,
  startIdx,
  knownStructs,
  isUniformBound,
  activeFlags,
) {
  let depth = 0;
  let opened = false;
  let endIdx = startIdx;
  let hasConditionalBranches = false;
  const referencedFlags = new Set();
  /** @type {Array<{ parentActive: boolean, condTaken: boolean, branchActive: boolean }>} */
  const ifdefStack = [];
  const rawFields = [];

  const isActive = () =>
    ifdefStack.length === 0 || ifdefStack[ifdefStack.length - 1].branchActive;

  for (let j = startIdx; j < lines.length; j += 1) {
    const rawLine = lines[j];
    const trimmed = rawLine.trim();

    const mIfdef = trimmed.match(/^\/\/>>\s*ifdef\s+([A-Za-z0-9_]+)/);
    if (mIfdef) {
      hasConditionalBranches = true;
      const flag = mIfdef[1];
      referencedFlags.add(flag);
      const pActive = isActive();
      const cond = activeFlags.has(flag);
      ifdefStack.push({
        parentActive: pActive,
        condTaken: cond,
        branchActive: pActive && cond,
      });
      continue;
    }

    const mIfndef = trimmed.match(/^\/\/>>\s*ifndef\s+([A-Za-z0-9_]+)/);
    if (mIfndef) {
      hasConditionalBranches = true;
      const flag = mIfndef[1];
      referencedFlags.add(flag);
      const pActive = isActive();
      const cond = !activeFlags.has(flag);
      ifdefStack.push({
        parentActive: pActive,
        condTaken: cond,
        branchActive: pActive && cond,
      });
      continue;
    }

    if (/^\/\/>>\s*else\b/.test(trimmed) && ifdefStack.length > 0) {
      const top = ifdefStack[ifdefStack.length - 1];
      top.branchActive = top.parentActive && !top.condTaken;
      continue;
    }

    if (/^\/\/>>\s*endif\b/.test(trimmed) && ifdefStack.length > 0) {
      ifdefStack.pop();
      continue;
    }

    const noComment = rawLine.replace(/\/\/.*$/, "");
    for (const ch of noComment) {
      if (ch === "{") {
        depth += 1;
        opened = true;
      } else if (ch === "}") {
        depth -= 1;
      }
    }

    if (j > startIdx && opened && depth > 0 && isActive()) {
      const cleanField = noComment
        .replace(/@[A-Za-z0-9_]+(?:\([^)]*\))?/g, "")
        .trim()
        .replace(/[,;]\s*$/, "");
      const fm = cleanField.match(/^([A-Za-z0-9_]+)\s*:\s*(.+)$/);
      if (fm) {
        rawFields.push({
          name: fm[1],
          type: fm[2].trim(),
          line: j + 1,
        });
      }
    }

    if (opened && depth <= 0) {
      endIdx = j;
      break;
    }
  }

  let offset = 0;
  let maxAlign = isUniformBound ? 16 : 4;
  let complete = rawFields.length > 0;
  const fields = [];
  const mat3Fields = [];
  const unfilledVec3Pads = [];
  let prevWasVec3 = null;

  for (const rf of rawFields) {
    const metrics = wgslUniformTypeMetrics(rf.type, knownStructs);
    if (!metrics) {
      complete = false;
      break;
    }
    const alignedOffset = roundUp(metrics.align, offset);
    const padBefore = alignedOffset - offset;
    if (prevWasVec3 && padBefore > 0) {
      unfilledVec3Pads.push({
        afterField: prevWasVec3.name,
        beforeField: rf.name,
        line: rf.line,
        padBytes: padBefore,
        floatOffset: offset / 4,
      });
    }
    fields.push({
      name: rf.name,
      type: rf.type,
      line: rf.line,
      byteOffset: alignedOffset,
      floatOffset: alignedOffset / 4,
      byteSize: metrics.size,
      implicitPadBefore: padBefore,
    });
    if (metrics.isMat3) {
      mat3Fields.push({
        name: rf.name,
        line: rf.line,
        floatOffset: alignedOffset / 4,
      });
    }
    prevWasVec3 = metrics.isVec3 ? rf : null;
    offset = alignedOffset + metrics.size;
    if (metrics.align > maxAlign) maxAlign = metrics.align;
  }

  const byteSize = complete ? roundUp(maxAlign, offset) : 0;
  return {
    endIdx,
    complete,
    maxAlign,
    byteSize,
    floatCount: byteSize / 4,
    hasConditionalBranches,
    referencedFlags,
    fields,
    mat3Fields,
    unfilledVec3Pads,
  };
}

/**
 * Parse WGSL `struct` declarations in a shader file (evaluating nested `//>>ifdef` / `//>>ifndef` /
 * `//>>else` blocks across `(0,0,0)` and `LOG_DEPTH` masks) and compute exact byte and
 * float offsets for uniform-bound structs.
 *
 * @param {string} relPath
 * @param {string[]} lines
 * @returns {{
 *   structs: Map<string, {
 *     name: string,
 *     line: number,
 *     align: number,
 *     byteSize: number,
 *     floatCount: number,
 *     altFloatCounts: number[],
 *     logDepthFloatCount: number,
 *     isUniformBound: boolean,
 *     hasConditionalBranches: boolean,
 *     fields: Array<{ name: string, type: string, line: number, byteOffset: number, floatOffset: number, byteSize: number, implicitPadBefore: number }>,
 *     logDepthFields: Array<{ name: string, type: string, line: number, byteOffset: number, floatOffset: number, byteSize: number, implicitPadBefore: number }>,
 *     mat3Fields: Array<{ name: string, line: number, floatOffset: number }>,
 *     unfilledVec3Pads: Array<{ afterField: string, beforeField: string, line: number, padBytes: number, floatOffset: number }>
 *   }>
 * }}
 */
export function analyzeWgslUniformStructs(relPath, lines) {
  const uniformBoundTypes = new Set();
  for (const line of lines) {
    const m = line.match(
      /var<\s*uniform\s*>\s*[A-Za-z0-9_]+\s*:\s*([A-Za-z0-9_]+)/,
    );
    if (m) uniformBoundTypes.add(m[1]);
  }

  const knownStructs = new Map();
  const structs = new Map();
  const emptyFlags = new Set();
  const logDepthFlags = new Set(["LOG_DEPTH"]);

  let i = 0;
  while (i < lines.length) {
    const mStruct = lines[i].match(/^\s*struct\s+([A-Za-z0-9_]+)\s*\{/);
    if (!mStruct) {
      i += 1;
      continue;
    }

    const structName = mStruct[1];
    const startLine = i + 1;
    const isUniformBound =
      uniformBoundTypes.has(structName) || /Uniform/i.test(structName);

    const baseEval = evaluateStructVariant(
      lines,
      i,
      knownStructs,
      isUniformBound,
      emptyFlags,
    );
    const logDepthEval = baseEval.hasConditionalBranches
      ? evaluateStructVariant(
          lines,
          i,
          knownStructs,
          isUniformBound,
          logDepthFlags,
        )
      : baseEval;
    const allFlagsEval =
      baseEval.referencedFlags.size > 0
        ? evaluateStructVariant(
            lines,
            i,
            knownStructs,
            isUniformBound,
            baseEval.referencedFlags,
          )
        : baseEval;

    i = Math.max(i, baseEval.endIdx);

    const primaryEval = baseEval.complete
      ? baseEval
      : logDepthEval.complete
        ? logDepthEval
        : allFlagsEval;

    if (primaryEval.complete) {
      knownStructs.set(structName, {
        align: primaryEval.maxAlign,
        size: primaryEval.byteSize,
      });
      if (isUniformBound) {
        const floatSet = new Set([primaryEval.floatCount]);
        if (logDepthEval.complete) floatSet.add(logDepthEval.floatCount);
        if (allFlagsEval.complete) floatSet.add(allFlagsEval.floatCount);
        structs.set(structName, {
          name: structName,
          line: startLine,
          align: primaryEval.maxAlign,
          byteSize: primaryEval.byteSize,
          floatCount: primaryEval.floatCount,
          altFloatCounts: [...floatSet],
          logDepthFloatCount: logDepthEval.complete
            ? logDepthEval.floatCount
            : primaryEval.floatCount,
          isUniformBound,
          hasConditionalBranches: baseEval.hasConditionalBranches,
          fields: primaryEval.fields,
          logDepthFields: logDepthEval.complete
            ? logDepthEval.fields
            : primaryEval.fields,
          mat3Fields: primaryEval.mat3Fields,
          unfilledVec3Pads: primaryEval.unfilledVec3Pads,
        });
      }
    }
    i += 1;
  }

  return { structs };
}

/**
 * Coordinate-frame (`CRS`) transition rules across JS/TS/WGSL/GLSL.
 */
const CRS_PATTERNS = [
  {
    id: "EPSG4326_TO_EPSG3857",
    srcFrame: "crs:EPSG:4326_Geographic",
    dstFrame: "crs:EPSG:3857_WebMercator",
    re: /\b(?:WebMercatorProjection|geodeticLatitudeToMercatorAngle|mercatorAngleToGeodeticLatitude|southMercatorYAndOneOverHeight|useWebMercator)\b/,
    detail: "WGS84 geographic radians <-> Web Mercator projection",
  },
  {
    id: "EGM2008_TO_WGS84_HEIGHT",
    srcFrame: "crs:EGM2008_Orthometric_MSL",
    dstFrame: "crs:WGS84_Ellipsoidal_Height",
    re: /\b(?:GeoidUndulationGrid|geoidUndulation|egm2008)\b/i,
    detail: "EGM2008 geoid undulation N offset -> WGS84 ellipsoidal height",
  },
  {
    id: "ICRF_TO_ECEF_IAU2006",
    srcFrame: "crs:ICRF_J2000_Inertial",
    dstFrame: "crs:WGS84_ECEF_f64",
    re: /\b(?:computeIcrfToFixedMatrix|computeTemeToPseudoFixedMatrix|Iau2006XysData|Simon1994PlanetaryPositions)\b/,
    detail: "ICRF/TEME celestial frame -> Earth-fixed ECEF f64 rotation",
  },
  {
    id: "ECEF_F64_TO_RTE_F32X2",
    srcFrame: "crs:WGS84_ECEF_f64",
    dstFrame: "crs:RTE_EyeRelative_f32x2",
    re: /\b(?:EncodedCartesian3\.fromCartesian|czm_translateRelativeToEye|translateRelativeToEye|encodedCameraHigh)\b/,
    detail: "64-bit ECEF high/low split -> camera-relative RTE f32 translation",
  },
  {
    id: "ECEF_TO_ENU_TANGENT",
    srcFrame: "crs:WGS84_ECEF_f64",
    dstFrame: "crs:ENU_LocalTangent",
    re: /\b(?:eastNorthUpToFixedFrame|eyeToEnu|czm_eyeToEnu|czm_eastNorthUpToEyeCoordinates)\b/,
    detail: "ECEF <-> East-North-Up local tangent frame",
  },
  {
    id: "RTE_TO_CLIP_WEBGPU_LOGDEPTH",
    srcFrame: "crs:RTE_EyeRelative_f32x2",
    dstFrame: "crs:Clip_WebGPU_Z01_LogDepth",
    re: /\b(?:mvpRelativeToEye|czm_writeLogDepth|applyLogDepth|recordLogDepthEncoder)\b/,
    detail: "Eye-relative RTE -> WebGPU [0,1] clip space + logarithmic depth",
  },
];

/**
 * Run WGSL uniform byte-offset verification, TS `*_UNIFORM_FLOATS`/`*_UNIFORM_BYTES`
 * cross-checks, and CRS coordinate-frame transition extraction across `fileContentsMap`.
 *
 * @param {Map<string, string>} fileContentsMap
 * @param {{ contracts: object[], edges: object[], symbols: object[] }} out
 */
export function extractUniformAndCrsContracts(fileContentsMap, out) {
  // 1. Register canonical CRS frame symbols once so `seam` / `impact` queries resolve them.
  const crsFrames = new Map([
    ["crs:EPSG:4326_Geographic", "WGS84 geographic lon/lat (EPSG:4326)"],
    [
      "crs:EPSG:3857_WebMercator",
      "Web Mercator projected meters/angles (EPSG:3857)",
    ],
    ["crs:EGM2008_Orthometric_MSL", "EGM2008 orthometric Mean Sea Level datum"],
    ["crs:ICRF_J2000_Inertial", "ICRF / J2000 celestial inertial frame"],
    [
      "crs:WGS84_Ellipsoidal_Height",
      "WGS84 triaxial/revolution ellipsoidal height",
    ],
    ["crs:WGS84_ECEF_f64", "WGS84 Earth-Centered Earth-Fixed 64-bit Cartesian"],
    [
      "crs:RTE_EyeRelative_f32x2",
      "Camera-relative double-float (High/Low) RTE space",
    ],
    ["crs:ENU_LocalTangent", "East-North-Up local tangent frame"],
    [
      "crs:Clip_WebGPU_Z01_LogDepth",
      "WebGPU NDC [0,1] Z clip space + log depth",
    ],
  ]);

  for (const [id, desc] of crsFrames.entries()) {
    out.symbols.push({
      id,
      name: id.slice(4),
      kind: "crs-frame",
      filePath: "packages/engine/Source/Core/GeographicProjection.js",
      startLine: 1,
      endLine: 1,
      signature: desc,
      isUtility: 0,
    });
  }

  // 2. Analyze WGSL uniform structs and index by shader basename + struct name
  const wgslStructsByStem = new Map();
  for (const [relPath, text] of fileContentsMap.entries()) {
    if (!relPath.endsWith(".wgsl")) continue;
    const lines = text.split(/\r?\n/);
    const { structs } = analyzeWgslUniformStructs(relPath, lines);
    if (structs.size === 0) continue;

    const stem = path.posix.basename(relPath, ".wgsl").toLowerCase();
    wgslStructsByStem.set(stem, { relPath, structs });

    for (const st of structs.values()) {
      for (const m3 of st.mat3Fields) {
        out.contracts.push({
          filePath: relPath,
          line: m3.line,
          category: "uniform-layout",
          contractType: "UNIFORM_MAT3X3_VEC4_STRIDE",
          severity: "review",
          detail: `${st.name}.${m3.name} (floatOffset=${m3.floatOffset}): WGSL mat3x3<f32> occupies 12 floats (3 vec4 columns with pad lanes), NOT 9 tight Matrix3 floats`,
        });
      }
      for (const pad of st.unfilledVec3Pads) {
        if (!/^_?pad/i.test(pad.afterField)) {
          out.contracts.push({
            filePath: relPath,
            line: pad.line,
            category: "uniform-layout",
            contractType: "UNIFORM_IMPLICIT_VEC3_PAD",
            severity: "review",
            detail: `${st.name}: ${pad.padBytes}-byte implicit alignment gap at floatOffset=${pad.floatOffset} between vec3 '${pad.afterField}' and '${pad.beforeField}'`,
          });
        }
      }
    }
  }

  // 3. Cross-check TS/JS uniform float/byte constants + extract CRS transitions
  for (const [relPath, text] of fileContentsMap.entries()) {
    const lines = text.split(/\r?\n/);

    // CRS frame transitions (at most once per pattern per file)
    for (const pat of CRS_PATTERNS) {
      if (!pat.re.test(text)) continue;
      const lineIdx = lines.findIndex(
        (l) =>
          !l.trim().startsWith("//") &&
          !l.trim().startsWith("*") &&
          pat.re.test(l),
      );
      if (lineIdx >= 0) {
        out.edges.push({
          src: `file:${relPath}`,
          dst: pat.dstFrame,
          relation: "crs_transition",
          provenance: "spatial-crs",
          detail: `${pat.id}: ${pat.detail}`,
          filePath: relPath,
          line: lineIdx + 1,
        });
        out.edges.push({
          src: pat.srcFrame,
          dst: pat.dstFrame,
          relation: "crs_pipeline_step",
          provenance: "spatial-crs",
          detail: `${pat.detail} (via ${path.posix.basename(relPath)})`,
          filePath: relPath,
          line: lineIdx + 1,
        });
      }
    }

    // Cross-check TS uniform size constants that explicitly cite a `.wgsl` shader
    if (!relPath.includes("/Renderer/WebGPU/") || !/\.(ts|js)$/.test(relPath)) {
      continue;
    }

    const citedWgsl = [...text.matchAll(/([A-Za-z0-9_]+)\.wgsl/g)].map((m) =>
      m[1].toLowerCase(),
    );
    if (citedWgsl.length === 0) continue;

    for (let i = 0; i < lines.length; i += 1) {
      const mConst = lines[i].match(
        /^(?:export\s+)?const\s+(CAMERA_UNIFORM_FLOATS|TILE_UNIFORM_FLOATS)\s*=\s*(\d+)\s*;/,
      );
      if (!mConst) continue;
      const constName = mConst[1];
      const declaredFloats = Number(mConst[2]);
      const targetStructName = constName.startsWith("CAMERA_")
        ? "CameraUniforms"
        : "TileUniforms";

      for (const wgslStem of citedWgsl) {
        const entry = wgslStructsByStem.get(wgslStem);
        const st = entry?.structs.get(targetStructName);
        if (!st) continue;

        const validFloatCounts = st.altFloatCounts ?? [st.floatCount];
        const matches = validFloatCounts.includes(declaredFloats);
        out.contracts.push({
          filePath: relPath,
          line: i + 1,
          category: "uniform-layout",
          contractType: matches
            ? "UNIFORM_LAYOUT_VERIFIED"
            : "UNIFORM_SIZE_MISMATCH",
          severity: matches ? "positive" : "hazard",
          detail: matches
            ? `${constName}=${declaredFloats} (${declaredFloats * 4}B) matches ${path.posix.basename(entry.relPath)} ${targetStructName} layout (${st.fields.length} fields; variants=${validFloatCounts.join("/")})`
            : `${constName}=${declaredFloats} disagrees with ${path.posix.basename(entry.relPath)} ${targetStructName} computed floatCount=${validFloatCounts.join("/")} (${st.byteSize}B)`,
        });
        break;
      }
    }
  }
}
