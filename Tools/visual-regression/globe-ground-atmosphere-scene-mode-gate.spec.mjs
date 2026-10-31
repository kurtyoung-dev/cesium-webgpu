// globe-ground-atmosphere-scene-mode-gate.spec.mjs - NEW-2D-WEBGPU-CONCENTRIC-BANDING.
// @purpose Pins that the WebGPU globe's ground-atmosphere drape is on in SCENE3D only, as WebGL's GROUND_ATMOSPHERE define is: executes the real tile and camera uniform packers with a fake frame state per scene mode and reads the packed groundAtmosphereControl.xy and atmosphereParams.w, which read their pre-gate values in SCENE3D and 0 in 2D, Columbus view and mid-morph; carries one executed inertness mutant per packer.
// @status ACTIVE
//
// THE DEFECT. WebGL turns the ground-atmosphere drape on only when
// `frameState.mode === SceneMode.SCENE3D` (`GlobeSurfaceTileProviderRendering.js`)
// and fog turns itself off outside SCENE3D (`Fog.js`), so its 2D and
// Columbus-view globe has no drape. The WebGPU packers keyed the drape on the
// provider's `showGroundAtmosphere` alone: in 2D and Columbus view the tile
// packer wrote `groundAtmosphereControl.x = 1` with a camera-distance fade, and
// the camera packer wrote `atmosphereParams.w = 1`, so the fragment drape ran
// on planar projected positions the landing cells E-ID-2d and E-ID-cv capture
// as concentric rings. Whether the rings are that drape is the Edge leg's
// answer (cells E-2D-stages, E-CV-stages); this spec pins the gate itself.
//
// WHAT IS REAL. WebGPUGlobeSurfaceTileUB.ts and WebGPUGlobeSurfaceCameraUB.ts
// and everything they import run as written (TypeScript transformed in
// memory; an absent generated shader-string module becomes an empty default
// export). The frame state, provider, tile and device are fakes holding only
// what the packers read; the packed floats are read from the host's own
// uniform arrays after the call.
//
// MUTANTS. A mutant is the real packer with one anchored substitution, loaded
// under a `?mutant=<id>` URL so the unmutated module stays in place. Each one
// makes its packer's scene-mode gate unreachable; the spec requires the
// assertions to go red under it.
//
// Run: node --test Tools/visual-regression/globe-ground-atmosphere-scene-mode-gate.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const engine = path.join(root, "packages/engine/Source");
const webgpu = path.join(engine, "Renderer/WebGPU");

const TILE_FILE = "WebGPUGlobeSurfaceTileUB.ts";
const CAMERA_FILE = "WebGPUGlobeSurfaceCameraUB.ts";

// SceneMode values (`Scene/SceneMode.js`).
const MODES = Object.freeze({
  MORPHING: 0,
  COLUMBUS_VIEW: 1,
  SCENE2D: 2,
  SCENE3D: 3,
});

/** id -> { file basename -> [[anchor, replacement]] }. Anchors occur once. */
const MUTANTS = {
  // The tile packer's gate made unreachable: the drape flag ignores the mode.
  "tile-gate-unreachable": {
    [TILE_FILE]: [
      [
        "    scene3D &&\n    !aerialPerspectiveActive &&\n",
        "    (true || scene3D) &&\n    !aerialPerspectiveActive &&\n",
      ],
    ],
  },
  // The camera packer's gate made unreachable.
  "camera-gate-unreachable": {
    [CAMERA_FILE]: [
      [
        "    sceneMode === 3 /* SCENE3D */ &&\n    !aerialPerspectiveActive &&\n",
        "    (true || sceneMode === 3) &&\n    !aerialPerspectiveActive &&\n",
      ],
    ],
  },
};

function applyMutant(basename, source, mutantId) {
  const edits = MUTANTS[mutantId]?.[basename];
  if (!edits) {
    return source;
  }
  let out = source;
  for (const [anchor, replacement] of edits) {
    assert.equal(
      out.split(anchor).length - 1,
      1,
      `mutant ${mutantId}: anchor must occur once in ${basename}: ${anchor}`,
    );
    out = out.replace(anchor, () => replacement);
  }
  return out;
}

// Engine-internal `./x.js` specifiers name `.ts` siblings in an unbuilt tree;
// TypeScript is transformed in memory (the packers reach a const enum that
// Node's strip-only mode cannot load), and an absent generated module under
// Shaders/ becomes an empty default export (the packers never read one).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      specifier.endsWith(".js") &&
      context.parentURL?.startsWith("file:")
    ) {
      const candidate = new URL(specifier, context.parentURL);
      candidate.search = "";
      const candidatePath = fileURLToPath(candidate);
      if (!fs.existsSync(candidatePath)) {
        const tsPath = candidatePath.replace(/\.js$/, ".ts");
        if (fs.existsSync(tsPath)) {
          return { url: pathToFileURL(tsPath).href, shortCircuit: true };
        }
        if (
          candidatePath
            .replaceAll("\\", "/")
            .includes("/packages/engine/Source/Shaders/")
        ) {
          return {
            url: `data:text/javascript,export default %22%22;#${encodeURIComponent(candidatePath)}`,
            shortCircuit: true,
          };
        }
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && /\.ts(\?|$)/.test(url)) {
      const parsed = new URL(url);
      const mutantId = parsed.searchParams.get("mutant");
      parsed.search = "";
      const file = fileURLToPath(parsed);
      let source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      if (mutantId) {
        source = applyMutant(path.basename(file), source, mutantId);
      }
      return {
        format: "module",
        source: stripTypeScriptTypes(source, {
          mode: "transform",
          sourceMap: false,
        }),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const moduleUrl = (basename, mutantId) => {
  const url = pathToFileURL(path.join(webgpu, basename));
  if (mutantId) {
    url.search = `?mutant=${mutantId}`;
  }
  return url.href;
};

const types = await import(moduleUrl("WebGPUGlobeSurfaceTypes.ts"));
const { default: GeographicProjection } = await import(
  pathToFileURL(path.join(engine, "Core/GeographicProjection.js")).href
);

const loadTilePacker = async (mutantId) =>
  (await import(moduleUrl(TILE_FILE, mutantId))).createTileUniformBuffer;
const loadCameraPacker = async (mutantId) =>
  (await import(moduleUrl(CAMERA_FILE, mutantId))).createCameraUniformBuffer;

// A camera about 7.2 Earth radii out, beyond the provider's fade-in distance,
// so a drape that is on reads a full fade of 1.
const CAMERA_POSITION_WC = Object.freeze({ x: 4.6e7, y: 0, z: 0 });

const TILE = Object.freeze({
  level: 2,
  x: 3,
  y: 1,
  rectangle: Object.freeze({
    west: -0.7853981633974483,
    south: 0,
    east: 0,
    north: 0.7853981633974483,
    width: 0.7853981633974483,
    height: 0.7853981633974483,
  }),
});

function fakeProvider() {
  return {
    showGroundAtmosphere: true,
    lightingFadeOutDistance: 1.0e7,
    lightingFadeInDistance: 2.0e7,
    nightFadeOutDistance: 1.0e7,
    nightFadeInDistance: 5.0e7,
    dynamicAtmosphereLighting: true,
    enableLighting: false,
    hasWaterMask: false,
    showWaterEffect: false,
    tilingScheme: {
      ellipsoid: {
        maximumRadius: 6378137.0,
        oneOverRadii: {
          x: 1 / 6378137.0,
          y: 1 / 6378137.0,
          z: 1 / 6356752.314245179,
        },
      },
    },
  };
}

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** The UniformState members the camera packer reads; none feeds the drape. */
function fakeUniformState() {
  return {
    view: identity(),
    projection: identity(),
    modelViewProjectionRelativeToEye: identity(),
    previousViewProjection: identity(),
    encodedCameraPositionMCHigh: { ...CAMERA_POSITION_WC },
    encodedCameraPositionMCLow: { x: 0, y: 0, z: 0 },
    cameraPosition: { ...CAMERA_POSITION_WC },
    lightDirectionEC: { x: 0, y: 0, z: 1 },
    sunDirectionWC: { x: 1, y: 0, z: 0 },
    lightDirectionWC: { x: 1, y: 0, z: 0 },
    lightColor: { x: 1, y: 1, z: 1 },
    pixelRatio: 1,
    gamma: 2.2,
    eyeHeight: 3.96e7,
  };
}

function fakeFrameState(mode, { aerialPerspective = false } = {}) {
  const frameState = {
    time: {},
    camera: {
      positionWC: { ...CAMERA_POSITION_WC },
      position: { ...CAMERA_POSITION_WC },
    },
    // Fog turns itself off outside SCENE3D and above its maximum height
    // (`Fog.js`); at this camera height it is off in every mode.
    fog: { enabled: false, density: 0 },
    verticalExaggeration: 1,
    mapProjection: new GeographicProjection(),
    context: {
      uniformAllocator: {
        allocateAndWrite: () => ({ buffer: {}, offset: 0 }),
      },
    },
  };
  if (mode !== undefined) {
    frameState.mode = mode;
  }
  if (aerialPerspective) {
    frameState.aerialPerspective = true;
  }
  return frameState;
}

/** groundAtmosphereControl.xy as the real (or mutant) tile packer writes it. */
async function packTile(mode, { mutantId, aerialPerspective } = {}) {
  const createTileUniformBuffer = await loadTilePacker(mutantId);
  const host = {
    _tileUniformData: new Float32Array(types.TILE_UNIFORM_FLOATS),
    _tileUniformU32View: undefined,
    // The packer's throttled diagnostics stay quiet.
    _diagLastLayerCountLogMs: Number.POSITIVE_INFINITY,
    _diagLastFogLogMs: Number.POSITIVE_INFINITY,
    _diagFogMissingLogged: true,
  };
  host._tileUniformU32View = new Uint32Array(host._tileUniformData.buffer);
  createTileUniformBuffer(
    host,
    {},
    {},
    fakeProvider(),
    fakeFrameState(mode, { aerialPerspective }),
    TILE,
    [],
    false,
  );
  const o = types.GROUND_ATMOSPHERE_CONTROL_OFFSET;
  return {
    data: host._tileUniformData,
    x: host._tileUniformData[o],
    y: host._tileUniformData[o + 1],
  };
}

// atmosphereParams (vec4) sits at floats 128-131 of the camera block
// (`WebGPUGlobeSurfaceTypes.ts`): Mie anisotropy, inner radius, outer
// radius, enable.
const ATMOSPHERE_PARAMS_FLOAT = 128;

/** atmosphereParams as the real (or mutant) camera packer writes it. */
async function packCamera(mode, { mutantId, aerialPerspective } = {}) {
  const createCameraUniformBuffer = await loadCameraPacker(mutantId);
  const host = {
    _cameraUniformData: new Float32Array(types.CAMERA_UNIFORM_FLOATS),
    _cameraMvpScratch: new Float64Array(16),
    _diagShouldLog: () => false,
  };
  createCameraUniformBuffer(
    host,
    {},
    fakeUniformState(),
    {},
    fakeProvider(),
    { center: { x: 0, y: 0, z: 0 } },
    fakeFrameState(mode, { aerialPerspective }),
    TILE,
  );
  const a = ATMOSPHERE_PARAMS_FLOAT;
  return {
    data: host._cameraUniformData,
    innerRadius: host._cameraUniformData[a + 1],
    outerRadius: host._cameraUniformData[a + 2],
    w: host._cameraUniformData[a + 3],
  };
}

const PLANAR_MODES = [
  ["SCENE2D", MODES.SCENE2D],
  ["COLUMBUS_VIEW", MODES.COLUMBUS_VIEW],
  ["MORPHING", MODES.MORPHING],
];

/** Every way the packed drape flags differ from WebGL's SCENE3D-only law. */
async function gateFindings({ tileMutant, cameraMutant } = {}) {
  const findings = [];
  const expect = (what, got, want) => {
    if (got !== want) {
      findings.push({ what, got, want });
    }
  };
  for (const [name, mode] of [["SCENE3D", MODES.SCENE3D], ...PLANAR_MODES]) {
    const on = mode === MODES.SCENE3D ? 1 : 0;
    const tile = await packTile(mode, { mutantId: tileMutant });
    expect(`${name}: groundAtmosphereControl.x`, tile.x, on);
    expect(`${name}: groundAtmosphereControl.y`, tile.y, on);
    const camera = await packCamera(mode, { mutantId: cameraMutant });
    expect(`${name}: atmosphereParams.w`, camera.w, on);
  }
  return findings;
}

test("the camera block's atmosphereParams sits where the spec reads it", async () => {
  const camera = await packCamera(MODES.SCENE3D);
  assert.equal(camera.innerRadius, 6378137.0);
  assert.equal(camera.outerRadius, 6378137.0 + 111000.0);
});

test("SCENE3D keeps the drape on: control.xy = (1, 1) and atmosphereParams.w = 1", async () => {
  const tile = await packTile(MODES.SCENE3D);
  assert.equal(tile.x, 1);
  assert.equal(tile.y, 1);
  const camera = await packCamera(MODES.SCENE3D);
  assert.equal(camera.w, 1);
});

test("a frame state without a mode packs as SCENE3D", async () => {
  const tile = await packTile(undefined);
  assert.deepEqual([tile.x, tile.y], [1, 1]);
  const camera = await packCamera(undefined);
  assert.equal(camera.w, 1);
});

test("SCENE3D packs the same floats with and without the scene-mode gate", async () => {
  // The mutants are the packers without the gate, i.e. as before it: in
  // SCENE3D every float of both blocks must be unchanged.
  const tile = await packTile(MODES.SCENE3D);
  const tileUngated = await packTile(MODES.SCENE3D, {
    mutantId: "tile-gate-unreachable",
  });
  assert.deepEqual([...tile.data], [...tileUngated.data]);
  const camera = await packCamera(MODES.SCENE3D);
  const cameraUngated = await packCamera(MODES.SCENE3D, {
    mutantId: "camera-gate-unreachable",
  });
  assert.deepEqual([...camera.data], [...cameraUngated.data]);
});

for (const [name, mode] of PLANAR_MODES) {
  test(`${name} turns the drape off: control.xy = (0, 0) and atmosphereParams.w = 0`, async () => {
    const tile = await packTile(mode);
    assert.equal(tile.x, 0);
    assert.equal(tile.y, 0);
    const camera = await packCamera(mode);
    assert.equal(camera.w, 0);
  });
}

test("the aerial-perspective gate still turns the SCENE3D drape off", async () => {
  const tile = await packTile(MODES.SCENE3D, { aerialPerspective: true });
  assert.deepEqual([tile.x, tile.y], [0, 0]);
  const camera = await packCamera(MODES.SCENE3D, { aerialPerspective: true });
  assert.equal(camera.w, 0);
});

test("the real packers follow WebGL's SCENE3D-only law in every mode", async () => {
  assert.deepEqual(await gateFindings(), []);
});

test("inertness: the tile packer's gate made unreachable turns the law red", async () => {
  const findings = await gateFindings({ tileMutant: "tile-gate-unreachable" });
  assert.deepEqual(
    findings.map((f) => f.what),
    PLANAR_MODES.flatMap(([name]) => [
      `${name}: groundAtmosphereControl.x`,
      `${name}: groundAtmosphereControl.y`,
    ]),
  );
});

test("inertness: the camera packer's gate made unreachable turns the law red", async () => {
  const findings = await gateFindings({
    cameraMutant: "camera-gate-unreachable",
  });
  assert.deepEqual(
    findings.map((f) => f.what),
    PLANAR_MODES.map(([name]) => `${name}: atmosphereParams.w`),
  );
});
