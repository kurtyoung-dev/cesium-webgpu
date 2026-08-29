/**
 * Pure-Node twin of the Karma zoom cases in
 * `packages/engine/Specs/Scene/ScreenSpaceCameraControllerSpec.js`, covering the
 * scene shape that the zoom-to-a-picked-target path requires.
 *
 * WHY IT EXISTS. `SceneTransforms.worldWithEyeOffsetToWindowCoordinates` reads
 * `scene.context.clipSpaceConvention`, and the zoom path calls it whenever the
 * zoom is aimed at a picked world position — Columbus view always, and any mode
 * with the camera underground. The Karma fixture is a hand-built scene double,
 * so a new read of a scene field is invisible to every gate that cannot run a
 * browser: it shows up as four red Karma cases and nothing else. This spec runs
 * the real controller, the real camera and the real transform over a double of
 * the same shape, so the class of defect is reachable from `node --test`.
 *
 * WHAT IT ASSERTS. Group A drives the double WITHOUT a context and requires the
 * four cases that project a target back to the window to throw at the context
 * read, and the rest of the zoom cases to survive — that is the failure exactly
 * as Karma reports it, and it doubles as the inertness mutant for the fixture
 * fix (drop the field, the green in group B goes away). Group B gives the double
 * the context a real Scene carries and requires the same four to complete AND to
 * move the camera the way the Karma expectations state. Group C pins the engine
 * invariant the fixture fix rests on: the frame-state read happens first, so a
 * scene that has lost its context has already thrown before the context read.
 *
 * The controller is driven through a stand-in for `CameraEventAggregator` — the
 * DOM-event source that the Karma spec drives with `DomEventSimulator` and that
 * a Node process has no way to produce. Everything below that seam is real
 * engine code.
 *
 * Run:
 * node --test packages/engine/Specs/Scene/ScreenSpaceCameraControllerSceneShapeSpec.mjs
 */
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_SOURCE = resolve(HERE, "../../Source");

const noop = () => {};
function makeCanvas(width, height) {
  return {
    clientWidth: width,
    clientHeight: height,
    width: width,
    height: height,
    style: {},
    addEventListener: noop,
    removeEventListener: noop,
    setAttribute: noop,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: width,
      height: height,
    }),
  };
}

// Minimal DOM surface. Only the event-registration and location reads that
// module initialization performs are exercised; no element is ever rendered.
globalThis.document ??= {
  addEventListener: noop,
  removeEventListener: noop,
  createElement: () => makeCanvas(1, 1),
  body: { appendChild: noop, removeChild: noop },
  documentElement: { style: {} },
  location: { href: "http://localhost/" },
};
globalThis.window ??= {
  addEventListener: noop,
  removeEventListener: noop,
};

async function load(relativePath) {
  const url = pathToFileURL(resolve(ENGINE_SOURCE, relativePath)).href;
  return (await import(url)).default;
}

const Cartesian2 = await load("Core/Cartesian2.js");
const Cartesian3 = await load("Core/Cartesian3.js");
const ClipSpaceConvention = await load("Core/ClipSpaceConvention.js");
const Ellipsoid = await load("Core/Ellipsoid.js");
const GeographicProjection = await load("Core/GeographicProjection.js");
const Matrix4 = await load("Core/Matrix4.js");
const CesiumMath = await load("Core/Math.js");
const Camera = await load("Scene/Camera.js");
const CameraEventType = await load("Scene/CameraEventType.js");
const MapMode2D = await load("Scene/MapMode2D.js");
const SceneMode = await load("Scene/SceneMode.js");
const SceneTransforms = await load("Scene/SceneTransforms.js");
const ScreenSpaceCameraController = await load(
  "Scene/ScreenSpaceCameraController.js",
);

const MAX_RADII = Ellipsoid.WGS84.maximumRadius;

// The Karma fixture's scene double, field for field, with the graphics context
// behind a flag so both the broken and the fixed shape can be driven.
function MockScene(canvas, camera, ellipsoid, withContext) {
  this.canvas = canvas;
  this.camera = camera;
  this.ellipsoid = ellipsoid;
  this.globe = undefined;
  this.verticalExaggeration = 1.0;
  this.verticalExaggerationRelativeHeight = 0.0;
  this.mapProjection = new GeographicProjection(ellipsoid);
  this.screenSpaceCameraController = undefined;
  this.cameraUnderground = false;
  this.globeHeight = 0.0;
  if (withContext) {
    this.context = { clipSpaceConvention: ClipSpaceConvention.WEBGL };
  }
}

function MockGlobe(ellipsoid) {
  this.ellipsoid = ellipsoid;
  this.getHeight = () => 0.0;
  this.pickWorldCoordinates = () => new Cartesian3(0.0, 0.0, 1.0);
  this._surface = {
    tileProvider: {},
    _tileLoadQueueHigh: [],
    _tileLoadQueueMedium: [],
    _tileLoadQueueLow: [],
    _debug: { tilesWaitingForChildren: 0 },
  };
  this.show = true;
}

function createCamera(canvas, offset) {
  const cameraScene = {
    canvas: canvas,
    drawingBufferWidth: canvas.clientWidth * 2,
    drawingBufferHeight: canvas.clientHeight * 2,
    mapProjection: new GeographicProjection(),
  };
  const camera = new Camera(cameraScene);
  camera.frustum.near = 1.0;
  camera.frustum.far = 500000000.0;
  camera.lookAtTransform(Matrix4.IDENTITY, offset);
  return camera;
}

// Stand-in for CameraEventAggregator. Reports one pending movement for one
// event type, which is what one simulated drag or wheel tick produces.
class FakeAggregator {
  constructor() {
    this.pending = undefined;
    this.anyButtonDown = false;
  }
  isMoving(type, modifier) {
    return (
      this.pending !== undefined &&
      this.pending.type === type &&
      modifier === undefined
    );
  }
  getMovement(type, modifier) {
    return this.isMoving(type, modifier) ? this.pending.movement : undefined;
  }
  getLastMovement() {
    return undefined;
  }
  getStartMousePosition(type, modifier) {
    return this.isMoving(type, modifier)
      ? this.pending.startPosition
      : new Cartesian2();
  }
  getButtonPressTime() {
    return undefined;
  }
  getButtonReleaseTime() {
    return undefined;
  }
  isButtonDown() {
    return false;
  }
  reset() {
    this.pending = undefined;
  }
  destroy() {}
  isDestroyed() {
    return false;
  }
}

function makeWorld(withContext) {
  const canvas = makeCanvas(1024, 768);
  const offset = Cartesian3.multiplyByScalar(
    Cartesian3.normalize(new Cartesian3(0.0, -2.0, 1.0), new Cartesian3()),
    2.5 * MAX_RADII,
    new Cartesian3(),
  );
  const camera = createCamera(canvas, offset);
  const scene = new MockScene(canvas, camera, Ellipsoid.WGS84, withContext);
  const controller = new ScreenSpaceCameraController(scene);
  controller._aggregator.destroy();
  controller._aggregator = new FakeAggregator();
  scene.screenSpaceCameraController = controller;
  camera._scene = scene;
  scene.mapMode2D = MapMode2D.INFINITE_2D;
  return { canvas, camera, scene, controller };
}

function setUpCV(world) {
  const { scene, camera } = world;
  scene.mode = SceneMode.COLUMBUS_VIEW;
  scene.mapProjection = new GeographicProjection(Ellipsoid.WGS84);
  scene.frameState = { mode: scene.mode, mapProjection: scene.mapProjection };
  scene.cameraUnderground = false;
  world.controller.enableCollisionDetection = true;
  camera.position = new Cartesian3(0.0, 0.0, MAX_RADII);
  camera.direction = Cartesian3.negate(Cartesian3.UNIT_Z, new Cartesian3());
  camera.up = Cartesian3.clone(Cartesian3.UNIT_Y);
  camera.right = Cartesian3.clone(Cartesian3.UNIT_X);
}

function setUpCVUnderground(world) {
  const { scene, camera } = world;
  scene.mode = SceneMode.COLUMBUS_VIEW;
  scene.globe = new MockGlobe(Ellipsoid.WGS84);
  scene.mapProjection = new GeographicProjection(Ellipsoid.WGS84);
  scene.frameState = { mode: scene.mode, mapProjection: scene.mapProjection };
  scene.cameraUnderground = true;
  world.controller.enableCollisionDetection = false;
  camera.position = new Cartesian3(0.0, 0.0, -100.0);
  camera.direction = Cartesian3.clone(Cartesian3.UNIT_Z);
  camera.up = Cartesian3.clone(Cartesian3.UNIT_Y);
  camera.right = Cartesian3.cross(
    camera.direction,
    camera.up,
    new Cartesian3(),
  );
}

function setUp3D(world) {
  const { scene } = world;
  scene.mode = SceneMode.SCENE3D;
  scene.mapProjection = new GeographicProjection(Ellipsoid.WGS84);
  scene.frameState = { mode: scene.mode, mapProjection: scene.mapProjection };
  scene.cameraUnderground = false;
  world.controller.enableCollisionDetection = true;
}

function setUp3DUnderground(world) {
  setUp3D(world);
  const { scene, camera } = world;
  scene.globe = new MockGlobe(scene.ellipsoid);
  scene.cameraUnderground = true;
  world.controller.enableCollisionDetection = false;
  camera.setView({ destination: Camera.DEFAULT_VIEW_RECTANGLE });
  const positionCart = Ellipsoid.WGS84.cartesianToCartographic(camera.position);
  positionCart.height = -100.0;
  camera.position = Ellipsoid.WGS84.cartographicToCartesian(positionCart);
}

function updateController(world) {
  world.camera.update(world.scene.mode);
  world.controller.update();
}

function rightDrag(world, start, end) {
  world.controller._aggregator.pending = {
    type: CameraEventType.RIGHT_DRAG,
    movement: {
      startPosition: Cartesian2.clone(start),
      endPosition: Cartesian2.clone(end),
    },
    startPosition: Cartesian2.clone(start),
  };
}

function wheel(world, delta) {
  const arcLength = 7.5 * CesiumMath.toRadians(delta);
  world.controller._aggregator.pending = {
    type: CameraEventType.WHEEL,
    movement: {
      startPosition: new Cartesian2(0.0, 0.0),
      endPosition: new Cartesian2(0.0, arcLength),
    },
    startPosition: new Cartesian2(0.0, 0.0),
  };
}

const upperMiddle = (world) =>
  new Cartesian2(world.canvas.clientWidth / 2, world.canvas.clientHeight / 4);
const center = (world) =>
  new Cartesian2(world.canvas.clientWidth / 2, world.canvas.clientHeight / 2);

// The Karma cases, by name, with the expectation each one states. `projects`
// records whether the case reaches the window-coordinate projection.
const CASES = [
  {
    name: "zoom in Columbus view when camera is underground",
    projects: true,
    run(world) {
      setUpCVUnderground(world);
      const before = Cartesian3.clone(world.camera.position);
      rightDrag(world, upperMiddle(world), center(world));
      updateController(world);
      return before;
    },
    check(world, before) {
      assert.ok(
        before.z < world.camera.position.z,
        `expected the camera to rise, got ${before.z} -> ${world.camera.position.z}`,
      );
    },
  },
  {
    name: "zoom in 3D when camera is underground",
    projects: true,
    run(world) {
      setUp3DUnderground(world);
      const before = {
        position: Cartesian3.clone(world.camera.position),
        direction: Cartesian3.clone(world.camera.direction),
      };
      rightDrag(world, upperMiddle(world), center(world));
      updateController(world);
      return before;
    },
    check(world, before) {
      const moved = Cartesian3.subtract(
        world.camera.position,
        before.position,
        new Cartesian3(),
      );
      const normalized = Cartesian3.normalize(moved, moved);
      assert.ok(
        Cartesian3.equalsEpsilon(
          normalized,
          before.direction,
          CesiumMath.EPSILON2,
        ),
        "expected the camera to move along its view direction",
      );
      assert.ok(
        Cartesian3.equalsEpsilon(
          world.camera.direction,
          before.direction,
          CesiumMath.EPSILON6,
        ),
        "expected the view direction to be unchanged",
      );
    },
  },
  {
    name: "camera does not go below the terrain in CV",
    projects: true,
    run(world) {
      setUpCV(world);
      world.scene.globe = new MockGlobe(world.scene.ellipsoid);
      updateController(world);
      world.camera.setView({
        destination: Cartesian3.fromDegrees(-72.0, 40.0, -10.0),
      });
      rightDrag(world, upperMiddle(world), center(world));
      updateController(world);
      return undefined;
    },
    check(world) {
      assert.ok(
        Math.abs(
          world.camera.position.z - world.controller.minimumZoomDistance,
        ) < CesiumMath.EPSILON7,
        `expected the camera to be held at the minimum zoom distance, got ${world.camera.position.z}`,
      );
    },
  },
  {
    name: "camera does go below the terrain in CV when collision detection is disabled",
    projects: true,
    run(world) {
      setUpCV(world);
      world.scene.globe = new MockGlobe(world.scene.ellipsoid);
      world.controller.enableCollisionDetection = false;
      updateController(world);
      world.camera.setView({
        destination: Cartesian3.fromDegrees(-72.0, 40.0, -10.0),
      });
      rightDrag(world, upperMiddle(world), center(world));
      updateController(world);
      return undefined;
    },
    check(world) {
      assert.ok(
        world.camera.position.z < world.controller.minimumZoomDistance,
        `expected the camera to sink below the minimum zoom distance, got ${world.camera.position.z}`,
      );
    },
  },
  // Controls: zoom cases that never project a target back to the window,
  // because no globe is present or the zoom is not aimed at a picked position.
  {
    name: "zoom in Columbus view",
    projects: false,
    run(world) {
      setUpCV(world);
      const before = Cartesian3.clone(world.camera.position);
      rightDrag(world, upperMiddle(world), center(world));
      updateController(world);
      return before;
    },
    check(world, before) {
      assert.ok(
        before.z > world.camera.position.z,
        "expected the camera to descend",
      );
    },
  },
  {
    name: "zoom in Columbus view with wheel",
    projects: false,
    run(world) {
      setUpCV(world);
      const before = Cartesian3.clone(world.camera.position);
      wheel(world, 120);
      updateController(world);
      return before;
    },
    check(world, before) {
      assert.ok(
        before.z > world.camera.position.z,
        "expected the camera to descend",
      );
    },
  },
  {
    name: "zooms in on an object in 3D",
    projects: false,
    run(world) {
      setUp3D(world);
      world.scene.globe = new MockGlobe(world.scene.ellipsoid);
      updateController(world);
      world.camera.setView({
        destination: Cartesian3.fromDegrees(-72.0, 40.0, 1.0),
      });
      updateController(world);
      world.scene.pickPositionSupported = true;
      world.scene.pickPositionWorldCoordinates = () =>
        Cartesian3.fromDegrees(-72.0, 40.0, -10.0);
      const before = Cartesian3.clone(world.camera.position);
      rightDrag(
        world,
        new Cartesian2(0.0, 0.0),
        new Cartesian2(0.0, world.canvas.clientHeight / 2),
      );
      updateController(world);
      return before;
    },
    check(world, before) {
      assert.ok(
        Cartesian3.magnitude(before) >
          Cartesian3.magnitude(world.camera.position),
        "expected the camera to approach the object",
      );
    },
  },
  {
    name: "camera does not go below the terrain in 3D",
    projects: false,
    run(world) {
      setUp3D(world);
      world.scene.globe = new MockGlobe(world.scene.ellipsoid);
      updateController(world);
      world.camera.setView({
        destination: Cartesian3.fromDegrees(-72.0, 40.0, -10.0),
      });
      rightDrag(world, upperMiddle(world), center(world));
      updateController(world);
      return undefined;
    },
    check(world) {
      assert.ok(
        Math.abs(
          world.camera.positionCartographic.height -
            world.controller.minimumZoomDistance,
        ) < CesiumMath.EPSILON5,
        `expected the camera to be held at the minimum zoom distance, got ${world.camera.positionCartographic.height}`,
      );
    },
  },
];

function drive(testCase, withContext) {
  const world = makeWorld(withContext);
  let thrown;
  let carried;
  try {
    carried = testCase.run(world);
  } catch (error) {
    thrown = error;
  }
  return { world, thrown, carried };
}

test("A. without a graphics context, only the projecting zoom cases fail", () => {
  const failed = [];
  for (const testCase of CASES) {
    const { thrown } = drive(testCase, false);
    if (thrown === undefined) {
      continue;
    }
    failed.push(testCase.name);
    assert.match(
      String(thrown.message),
      /clipSpaceConvention/,
      `${testCase.name} threw for an unrelated reason: ${thrown.message}`,
    );
    assert.match(
      String(thrown.stack),
      /SceneTransforms\.js/,
      `${testCase.name} threw outside SceneTransforms: ${thrown.stack}`,
    );
  }
  assert.deepEqual(
    failed,
    CASES.filter((testCase) => testCase.projects).map(
      (testCase) => testCase.name,
    ),
    "the set of cases that reach the window-coordinate projection changed",
  );
});

test("B. with the context a real Scene carries, every case runs and moves the camera", () => {
  for (const testCase of CASES) {
    const { world, thrown, carried } = drive(testCase, true);
    assert.equal(
      thrown,
      undefined,
      `${testCase.name} threw: ${thrown?.stack ?? ""}`,
    );
    testCase.check(world, carried);
  }
});

test("C. the frame-state read precedes the context read", () => {
  // A Scene releases its frame state before its context, so a scene that has
  // lost its context has already failed the frame-state read. Nothing reaches
  // the context read with a live frame state.
  const world = makeWorld(false);
  setUpCV(world);
  world.scene.frameState = undefined;
  assert.throws(
    () =>
      SceneTransforms.worldToWindowCoordinates(
        world.scene,
        new Cartesian3(0.0, 0.0, 1.0),
      ),
    (error) => {
      assert.doesNotMatch(String(error.message), /clipSpaceConvention/);
      assert.match(String(error.stack), /computeActualEllipsoidPosition/);
      return true;
    },
  );

  // With a live frame state and a context, the same call projects a position.
  const live = makeWorld(true);
  setUpCV(live);
  const windowPosition = SceneTransforms.worldToWindowCoordinates(
    live.scene,
    new Cartesian3(0.0, 0.0, 1.0),
  );
  assert.ok(
    windowPosition === undefined || Number.isFinite(windowPosition.x),
    "expected a window position or a documented undefined",
  );
});
