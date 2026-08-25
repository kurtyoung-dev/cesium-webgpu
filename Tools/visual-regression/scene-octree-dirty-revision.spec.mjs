// @purpose Proves SceneOctree revision reuse, mutation rebuilds, and disabled/restored PVS behavior.
// @status ACTIVE

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import BoundingSphere from "../../packages/engine/Source/Core/BoundingSphere.js";
import Cartesian3 from "../../packages/engine/Source/Core/Cartesian3.js";
import defined from "../../packages/engine/Source/Core/defined.js";
import Intersect from "../../packages/engine/Source/Core/Intersect.js";
import SceneMode from "../../packages/engine/Source/Scene/SceneMode.js";
import Pass from "../../packages/engine/Source/Renderer/Pass.js";
import OctreeNode from "../../packages/engine/Source/Scene/OctreeNode.js";
import SceneOctree from "../../packages/engine/Source/Scene/SceneOctree.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const sceneOctreePath = path.join(
  repoRoot,
  "packages/engine/Source/Scene/SceneOctree.js",
);
const viewportExecutorPath = path.join(
  repoRoot,
  "packages/engine/Source/Scene/ViewportExecutor.js",
);
let sourceCache;
let viewportHarnessCache;

function loadSources() {
  if (!sourceCache) {
    sourceCache = {
      sceneOctree: readFileSync(sceneOctreePath, "utf8").replace(/\r\n/g, "\n"),
      viewportExecutor: readFileSync(viewportExecutorPath, "utf8").replace(
        /\r\n/g,
        "\n",
      ),
    };
  }
  return sourceCache;
}

function block(source, header) {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `block not found: ${header}`);
  const open = source.indexOf("{", start);
  assert.notEqual(open, -1, `block has no body: ${header}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
    } else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  assert.fail(`block never closed: ${header}`);
}

function instantiate(sourceText, returnExpression, dependencies = {}) {
  const names = Object.keys(dependencies);
  // The oracle executes shipped source so a hand-written twin cannot silently
  // drift away from the executor gate or the revision producer under test.
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    ...names,
    `${sourceText}\nreturn ${returnExpression};`,
  );
  return factory(...names.map((name) => dependencies[name]));
}

function compileSceneOctree(source) {
  const executable = source
    .replace(/^import .*;\n/gm, "")
    .replace(/export default SceneOctree;\s*$/, "");
  return instantiate(executable, "SceneOctree", {
    Cartesian3,
    defined,
    OctreeNode,
    Pass,
  });
}

function compileSceneOctreeMutation(name, anchor, replacement) {
  const { sceneOctree } = loadSources();
  assert.equal(
    sceneOctree.split(anchor).length - 1,
    1,
    `${name} source anchor must occur exactly once`,
  );
  const mutatedSource = sceneOctree.replace(anchor, replacement);
  assert.notEqual(mutatedSource, sceneOctree, `${name} mutation did not apply`);
  return compileSceneOctree(mutatedSource);
}

function loadViewportHarness() {
  if (viewportHarnessCache) {
    return viewportHarnessCache;
  }

  const { viewportExecutor } = loadSources();
  const executeViewport = block(
    viewportExecutor,
    "function executeCommandsInViewport(",
  );
  const applySceneOctree = instantiate(
    block(viewportExecutor, "function applySceneOctree("),
    "applySceneOctree",
    {
      collectPrePvsShadowCasters() {},
      SceneMode,
    },
  );
  const octreeGateSource = block(executeViewport, "if (octree.enabled) {");
  const ordinaryPvsCall = "view.createPotentiallyVisibleSet(scene);";
  const octreeDeclarationIndex = executeViewport.indexOf(
    "const octree = scheduler.octree;",
  );
  const octreeGateIndex = executeViewport.indexOf(octreeGateSource);
  const ordinaryPvsIndex = executeViewport.indexOf(
    ordinaryPvsCall,
    octreeGateIndex,
  );
  assert.ok(
    octreeDeclarationIndex !== -1 &&
      octreeGateIndex > octreeDeclarationIndex &&
      ordinaryPvsIndex > octreeGateIndex,
    "the opt-in octree gate must remain between declaration and ordinary PVS",
  );
  const preGate = executeViewport.slice(
    octreeDeclarationIndex,
    octreeGateIndex,
  );
  assert.doesNotMatch(
    preGate,
    /updateCommandSetRevision|octree\.build\(|octree\.enabled\s*=/,
    "the default executor path must do no revision/build/promotion work",
  );
  assert.doesNotMatch(
    viewportExecutor,
    /octree\.enabled\s*=/,
    "ViewportExecutor must never auto-promote the opt-in octree",
  );

  viewportHarnessCache = {
    runExecutorPvsSlice: instantiate(
      `function runExecutorPvsSlice(scene, cmdList, octree, shadowState, view) {
        let prePvsShadowCastersCaptured = false;
        ${octreeGateSource}
        ${ordinaryPvsCall}
        return prePvsShadowCastersCaptured;
      }`,
      "runExecutorPvsSlice",
      { applySceneOctree },
    ),
  };
  return viewportHarnessCache;
}

function identityMatrix() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function makeCommand(id, x, y = x, z = x) {
  return {
    id,
    boundingVolume: new BoundingSphere(new Cartesian3(x, y, z), 1),
    modelMatrix: identityMatrix(),
    pass: Pass.OPAQUE,
    cull: true,
    occlude: true,
    visibilityMask: 0xffffffff,
  };
}

function makeCommands() {
  return [makeCommand("mover", -50), makeCommand("anchor", 50)];
}

function makeBypassCommand(id, x, radius = 1, pass = Pass.GLOBE) {
  const command = makeCommand(id, x);
  command.boundingVolume.radius = radius;
  command.pass = pass;
  return command;
}

function makeTree(options = {}, SceneOctreeClass = SceneOctree) {
  return new SceneOctreeClass({
    enabled: true,
    maxCommandsPerNode: 1,
    maxDepth: 1,
    minCommandsForOctree: 1,
    rootHalfExtent: 100,
    ...options,
  });
}

function buildTracked(octree, commands, frameNumber = 1) {
  const revision = octree.updateCommandSetRevision(commands);
  const result = octree.build(commands, frameNumber, revision);
  return { result, revision };
}

function halfSpaceCullingVolume(direction) {
  return {
    computeVisibilityWithPlaneMask(sphere) {
      if (sphere.radius > 100) {
        return Intersect.INTERSECTING;
      }
      return sphere.center.x * direction > 0
        ? Intersect.INSIDE
        : Intersect.OUTSIDE;
    },
  };
}

const leftCullingVolume = halfSpaceCullingVolume(-1);
const rightCullingVolume = halfSpaceCullingVolume(1);

function queryIds(octree, cullingVolume) {
  return octree.collectVisible(cullingVolume).map((command) => command.id);
}

function freshQueryIds(commands, cullingVolume) {
  const fresh = makeTree();
  buildTracked(fresh, commands);
  return queryIds(fresh, cullingVolume);
}

function instrumentRoot(root) {
  const counts = { clear: 0, insert: 0 };
  const originalClear = root.clear;
  const originalInsert = root.insert;
  root.clear = function () {
    counts.clear++;
    return originalClear.call(this);
  };
  root.insert = function (command) {
    counts.insert++;
    return originalInsert.call(this, command);
  };
  return counts;
}

function assertIneligibleChurnReuse(SceneOctreeClass = SceneOctree) {
  const oldBypass = makeBypassCommand("old-globe", 0, 2, Pass.GLOBE);
  const commands = [
    makeCommand("left", -50),
    oldBypass,
    makeCommand("right", 50),
  ];
  const octree = makeTree({}, SceneOctreeClass);
  const first = buildTracked(octree, commands, 1);
  const work = instrumentRoot(octree._root);
  const skipsBefore = octree.stats.rebuildSkips;

  const currentBypass = makeBypassCommand(
    "current-compute",
    25,
    9,
    Pass.COMPUTE,
  );
  commands[1] = currentBypass;
  const second = buildTracked(octree, commands, 2);

  assert.equal(second.revision, first.revision);
  assert.deepEqual(work, { clear: 0, insert: 0 });
  assert.equal(octree.stats.commandsInserted, 0);
  assert.equal(octree.stats.rebuildSkips, skipsBefore + 1);
  assert.equal(second.result.bypassCommands.length, 1);
  assert.equal(second.result.bypassCommands[0], currentBypass);
  assert.notEqual(second.result.bypassCommands[0], oldBypass);
  assert.deepEqual(
    queryIds(octree, leftCullingVolume),
    freshQueryIds(commands, leftCullingVolume),
  );
  assert.deepEqual(
    queryIds(octree, rightCullingVolume),
    freshQueryIds(commands, rightCullingVolume),
  );
}

function assertCurrentBypassPublished(SceneOctreeClass = SceneOctree) {
  const previousBypasses = [
    makeBypassCommand("old-a", -10),
    makeBypassCommand("old-b", 0),
    makeBypassCommand("old-c", 10),
  ];
  const commands = [
    makeCommand("left", -50),
    previousBypasses[0],
    previousBypasses[1],
    makeCommand("right", 50),
    previousBypasses[2],
  ];
  const octree = makeTree({}, SceneOctreeClass);
  const first = buildTracked(octree, commands, 1);
  const skipsBefore = octree.stats.rebuildSkips;
  const currentBypasses = [
    makeBypassCommand("current-a", -30, 3),
    makeBypassCommand("current-b", 0, 4),
    makeBypassCommand("current-c", 30, 5),
  ];
  commands[1] = currentBypasses[0];
  commands[2] = currentBypasses[1];
  commands[4] = currentBypasses[2];

  const second = buildTracked(octree, commands, 2);

  assert.equal(second.revision, first.revision);
  assert.equal(octree.stats.rebuildSkips, skipsBefore + 1);
  assert.equal(second.result.bypassCommands.length, currentBypasses.length);
  for (let i = 0; i < currentBypasses.length; i++) {
    assert.equal(second.result.bypassCommands[i], currentBypasses[i]);
    assert.notEqual(second.result.bypassCommands[i], previousBypasses[i]);
  }
}

function assertEligibilityTransitionsRebuild(MutantBuildClass) {
  const leaving = makeCommand("leaving", -50);
  const anchor = makeCommand("anchor", 50);
  const entering = makeBypassCommand("entering", -25);
  const commands = [leaving, anchor, entering];
  const octree = makeTree();
  const first = buildTracked(octree, commands, 1);
  assert.deepEqual(queryIds(octree, leftCullingVolume), ["leaving"]);

  if (defined(MutantBuildClass)) {
    octree.build = MutantBuildClass.prototype.build.bind(octree);
  }
  const work = instrumentRoot(octree._root);

  leaving._moonPhysicalDepthRoute = true;
  const second = buildTracked(octree, commands, 2);
  assert.equal(second.revision, first.revision + 1);
  assert.deepEqual(work, { clear: 1, insert: 1 });
  assert.ok(!queryIds(octree, leftCullingVolume).includes("leaving"));

  const clearBeforeEntry = work.clear;
  const insertBeforeEntry = work.insert;
  entering.pass = Pass.OPAQUE;
  const third = buildTracked(octree, commands, 3);
  assert.equal(third.revision, second.revision + 1);
  assert.equal(work.clear, clearBeforeEntry + 1);
  assert.equal(work.insert, insertBeforeEntry + 2);
  assert.ok(queryIds(octree, leftCullingVolume).includes("entering"));
  assert.ok(!queryIds(octree, leftCullingVolume).includes("leaving"));
}

function makeScanSizedCommands(count) {
  const commands = [];
  for (let i = 0; i < count; i++) {
    // Spread inside the root half-extent so every command lands in the tree.
    commands.push(makeCommand(`scan-${i}`, -99 + (i % 199)));
  }
  return commands;
}

function assertScanAuthorizesOneBuild(SceneOctreeClass = SceneOctree) {
  const commands = makeScanSizedCommands(210);
  const octree = makeTree({}, SceneOctreeClass);
  const revision = octree.updateCommandSetRevision(commands);
  const first = octree.build(commands, 1, revision);

  assert.equal(first.useOctree, true);
  assert.equal(octree.stats.rebuilds, 1);
  assert.equal(octree.stats.rebuildSkips, 0);
  assert.equal(octree.stats.commandsInserted, commands.length);

  // An indexed command moves and no new scan runs, so the revision the caller
  // still holds no longer describes the list it is about to build.
  commands[100].boundingVolume.center.x = 42;
  commands[100].boundingVolume.center.y = 42;
  commands[100].boundingVolume.center.z = 42;
  octree.build(commands, 2, revision);

  assert.equal(octree.stats.rebuilds, 2);
  assert.equal(octree.stats.rebuildSkips, 0);
  assert.equal(octree.stats.commandsInserted, commands.length);
  assert.deepEqual(
    queryIds(octree, leftCullingVolume),
    freshQueryIds(commands, leftCullingVolume),
  );
  assert.deepEqual(
    queryIds(octree, rightCullingVolume),
    freshQueryIds(commands, rightCullingVolume),
  );
}

test("unchanged revision skips all clear/insert work and preserves fresh parity", () => {
  const defaultOctree = new SceneOctree();
  assert.equal(defaultOctree.enabled, false);
  assert.equal("_commandSetRevisionState" in defaultOctree, false);
  assert.equal("rebuilds" in defaultOctree.stats, false);
  assert.equal("rebuildSkips" in defaultOctree.stats, false);

  const commands = makeCommands();
  const octree = makeTree();
  const first = buildTracked(octree, commands, 1);
  assert.equal(first.result.useOctree, true);
  assert.equal(first.result.octreeCommands, 2);

  const rootBefore = octree._root;
  const work = instrumentRoot(rootBefore);
  const skipsBefore = octree.stats.rebuildSkips;
  const second = buildTracked(octree, commands, 2);

  assert.equal(second.revision, first.revision);
  assert.equal(octree._root, rootBefore);
  assert.equal(work.clear, 0);
  assert.equal(work.insert, 0);
  assert.equal(octree.stats.commandsInserted, 0);
  assert.equal(octree.stats.rebuildSkips, skipsBefore + 1);
  assert.deepEqual(
    queryIds(octree, leftCullingVolume),
    freshQueryIds(commands, leftCullingVolume),
  );
  assert.deepEqual(
    queryIds(octree, rightCullingVolume),
    freshQueryIds(commands, rightCullingVolume),
  );
});

test("two-argument direct builds retain conservative full-rebuild behavior", () => {
  const commands = makeCommands();
  const octree = makeTree();
  octree.build(commands, 1);
  const work = instrumentRoot(octree._root);

  octree.build(commands, 2);

  assert.deepEqual(work, { clear: 1, insert: commands.length });
  assert.equal(octree.stats.rebuilds, 2);
  assert.equal(octree.stats.rebuildSkips, 0);
});

test("T1: ineligible command churn preserves revision reuse and fresh-tree parity", () => {
  assertIneligibleChurnReuse();
});

test("T2: a skipped build publishes current bypass objects in command-list order", () => {
  assertCurrentBypassPublished();
});

test("T3: commands leaving and entering eligibility rebuild tree membership", () => {
  assertEligibilityTransitionsRebuild();
});

test("T4: a warm skipped build reuses the bypass array with current contents", () => {
  const oldBypasses = [
    makeBypassCommand("old-a", -10),
    makeBypassCommand("old-b", 10),
  ];
  const commands = [
    makeCommand("left", -50),
    oldBypasses[0],
    makeCommand("right", 50),
    oldBypasses[1],
  ];
  const octree = makeTree();
  const first = buildTracked(octree, commands, 1);
  const bypassArray = first.result.bypassCommands;
  assert.equal(bypassArray[0], oldBypasses[0]);
  assert.equal(bypassArray[1], oldBypasses[1]);

  const currentBypasses = [
    makeBypassCommand("current-a", -20, 4),
    makeBypassCommand("current-b", 20, 6),
  ];
  commands[1] = currentBypasses[0];
  commands[3] = currentBypasses[1];
  const second = buildTracked(octree, commands, 2);

  assert.equal(second.result.bypassCommands, bypassArray);
  assert.equal(second.result.bypassCommands.length, currentBypasses.length);
  assert.equal(second.result.bypassCommands[0], currentBypasses[0]);
  assert.equal(second.result.bypassCommands[1], currentBypasses[1]);
});

test("T5: a two-argument build repartitions its own list after another list was scanned", () => {
  const listA = [
    makeCommand("a-eligible", -50),
    makeBypassCommand("a-bypass", 0),
  ];
  const octree = makeTree();
  buildTracked(octree, listA, 1);
  octree.updateCommandSetRevision(listA);
  const work = instrumentRoot(octree._root);

  const listBBypass = makeBypassCommand("b-bypass", 0, 8);
  const listB = [
    listBBypass,
    makeCommand("b-left", -30),
    makeCommand("b-right", 30),
  ];
  const result = octree.build(listB, 2);

  assert.deepEqual(work, { clear: 1, insert: 2 });
  assert.equal(octree.stats.rebuilds, 2);
  assert.equal(octree.stats.rebuildSkips, 0);
  assert.equal(result.bypassCommands.length, 1);
  assert.equal(result.bypassCommands[0], listBBypass);
  assert.deepEqual(
    queryIds(octree, leftCullingVolume),
    freshQueryIds(listB, leftCullingVolume),
  );
  assert.deepEqual(
    queryIds(octree, rightCullingVolume),
    freshQueryIds(listB, rightCullingVolume),
  );
});

test("a revision from one list cannot authorize reuse of a tree built from another list", () => {
  const listABypass = makeBypassCommand("a-bypass", 0, 3);
  const listA = [
    makeCommand("a-left", -50),
    listABypass,
    makeCommand("a-right", 50),
  ];
  const listBBypass = makeBypassCommand("b-bypass", 0, 5);
  const listB = [
    makeCommand("b-left", -25),
    makeCommand("b-right", 25),
    listBBypass,
  ];
  const octree = makeTree();

  const listARevision = octree.updateCommandSetRevision(listA);
  const listBResult = octree.build(listB, 1, listARevision);
  assert.equal(octree.stats.commandsInserted, 2);
  assert.equal(octree.stats.rebuilds, 1);
  assert.equal(octree.stats.rebuildSkips, 0);
  assert.equal(listBResult.bypassCommands.length, 1);
  assert.equal(listBResult.bypassCommands[0], listBBypass);
  assert.deepEqual(queryIds(octree, leftCullingVolume), ["b-left"]);
  assert.deepEqual(queryIds(octree, rightCullingVolume), ["b-right"]);

  const work = instrumentRoot(octree._root);
  const currentListARevision = octree.updateCommandSetRevision(listA);
  const listAResult = octree.build(listA, 2, currentListARevision);

  assert.deepEqual(work, { clear: 1, insert: 2 });
  assert.equal(octree.stats.commandsInserted, 2);
  assert.equal(octree.stats.rebuilds, 2);
  assert.equal(octree.stats.rebuildSkips, 0);
  assert.equal(listAResult.bypassCommands.length, 1);
  assert.equal(listAResult.bypassCommands[0], listABypass);
  assert.deepEqual(
    queryIds(octree, leftCullingVolume),
    freshQueryIds(listA, leftCullingVolume),
  );
  assert.deepEqual(
    queryIds(octree, rightCullingVolume),
    freshQueryIds(listA, rightCullingVolume),
  );
});

test("T6: one scan authorizes one build, so a second build of the same list rebuilds", () => {
  assertScanAuthorizesOneBuild();
});

test("the exact revision producer covers identity, eligibility, and indexed state", async (t) => {
  const cases = [
    ["count", (commands) => commands.push(makeCommand("third", -25))],
    [
      "count shrink",
      (commands) => {
        commands.pop();
      },
    ],
    ["order", (commands) => commands.reverse()],
    [
      "command identity",
      (commands) => {
        commands[0] = { ...commands[0] };
      },
    ],
    [
      "bounding-volume identity",
      (commands) => {
        const original = commands[0].boundingVolume;
        const replacement = BoundingSphere.clone(original);
        replacement.center = original.center;
        commands[0].boundingVolume = replacement;
      },
    ],
    [
      "bounding-volume center",
      (commands) => {
        commands[0].boundingVolume.center.x++;
      },
    ],
    [
      "bounding-volume center y",
      (commands) => {
        commands[0].boundingVolume.center.y++;
      },
    ],
    [
      "bounding-volume center z",
      (commands) => {
        commands[0].boundingVolume.center.z++;
      },
    ],
    [
      "bounding-volume radius",
      (commands) => {
        commands[0].boundingVolume.radius++;
      },
    ],
    [
      "bounding-volume definedness",
      (commands) => {
        commands[0].boundingVolume = undefined;
      },
    ],
    [
      "resolved pass",
      (commands) => {
        commands[0].pass = Pass.TRANSLUCENT;
      },
    ],
    [
      "lunar eligibility route",
      (commands) => {
        commands[0]._moonPhysicalDepthRoute = true;
      },
    ],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const commands = makeCommands();
      const octree = makeTree();
      const baseline = octree.updateCommandSetRevision(commands);
      assert.equal(octree.updateCommandSetRevision(commands), baseline);
      mutate(commands);
      const changed = octree.updateCommandSetRevision(commands);
      assert.equal(changed, baseline + 1);
      assert.equal(octree.updateCommandSetRevision(commands), changed);
    });
  }

  await t.test("non-finite sphere remains volatile", () => {
    const commands = makeCommands();
    const octree = makeTree();
    const baseline = octree.updateCommandSetRevision(commands);
    assert.equal(octree.updateCommandSetRevision(commands), baseline);
    commands[0].boundingVolume.radius = Infinity;
    const firstVolatileRevision = octree.updateCommandSetRevision(commands);
    assert.equal(firstVolatileRevision, baseline + 1);
    assert.equal(
      octree.updateCommandSetRevision(commands),
      firstVolatileRevision + 1,
    );
  });

  await t.test("tree configuration", () => {
    const commands = makeCommands();
    const octree = makeTree();
    const { revision } = buildTracked(octree, commands);
    const originalRoot = octree._root;
    octree.rootHalfExtent++;
    octree.build(commands, 2, revision);
    assert.notEqual(octree._root, originalRoot);
    const secondRoot = octree._root;
    octree.maxDepth++;
    octree.build(commands, 3, revision);
    assert.notEqual(octree._root, secondRoot);
    const thirdRoot = octree._root;
    octree.maxCommandsPerNode++;
    octree.build(commands, 4, revision);
    assert.notEqual(octree._root, thirdRoot);
    assert.equal(octree.stats.rebuilds, 4);
  });
});

test("an indexed mutation bumps the revision, rebuilds, and cannot leave stale results", () => {
  const commands = makeCommands();
  const octree = makeTree();
  const first = buildTracked(octree, commands, 1);
  assert.deepEqual(queryIds(octree, leftCullingVolume), ["mover"]);

  const work = instrumentRoot(octree._root);
  commands[0].boundingVolume.center.x = 50;
  commands[0].boundingVolume.center.y = 50;
  commands[0].boundingVolume.center.z = 50;
  const second = buildTracked(octree, commands, 2);

  assert.equal(second.revision, first.revision + 1);
  assert.equal(work.clear, 1);
  assert.equal(work.insert, commands.length);
  assert.deepEqual(queryIds(octree, leftCullingVolume), []);
  assert.deepEqual(
    queryIds(octree, rightCullingVolume),
    freshQueryIds(commands, rightCullingVolume),
  );
});

test("a failed revision scan cannot leave the old reuse token live", () => {
  const commands = makeCommands();
  const octree = makeTree();
  const first = buildTracked(octree, commands, 1);
  const anchorVolume = commands[1].boundingVolume;

  commands[0].boundingVolume.center.x = 50;
  Object.defineProperty(commands[1], "boundingVolume", {
    configurable: true,
    get() {
      throw new Error("synthetic getter failure");
    },
  });
  assert.throws(
    () => octree.updateCommandSetRevision(commands),
    /synthetic getter failure/,
  );
  assert.equal(octree._lastBuildResult, undefined);

  Object.defineProperty(commands[1], "boundingVolume", {
    configurable: true,
    value: anchorVolume,
    writable: true,
  });
  const recoveredRevision = octree.updateCommandSetRevision(commands);
  assert.equal(recoveredRevision, first.revision + 1);
  octree.build(commands, 2, recoveredRevision);
  assert.deepEqual(
    queryIds(octree, rightCullingVolume),
    freshQueryIds(commands, rightCullingVolume),
  );
});

test("disabled executor uses ordinary PVS only and re-enable matches a fresh octree", () => {
  const { runExecutorPvsSlice } = loadViewportHarness();
  const commands = makeCommands();
  const octree = makeTree();
  const scene = {
    frameState: {
      commandList: commands.slice(),
      cullingVolume: leftCullingVolume,
      frameNumber: 1,
      mode: SceneMode.SCENE3D,
      occluder: undefined,
    },
  };
  const shadowState = { shadowsEnabled: false };
  const ordinaryInputs = [];
  const view = {
    createPotentiallyVisibleSet(currentScene) {
      ordinaryInputs.push(
        currentScene.frameState.commandList.map((command) => command.id),
      );
    },
  };

  let callsBefore = ordinaryInputs.length;
  runExecutorPvsSlice(
    scene,
    scene.frameState.commandList,
    octree,
    shadowState,
    view,
  );
  assert.equal(ordinaryInputs.length, callsBefore + 1);
  assert.deepEqual(ordinaryInputs.at(-1), ["mover"]);

  let revisionCalls = 0;
  let buildCalls = 0;
  const originalUpdate = octree.updateCommandSetRevision;
  const originalBuild = octree.build;
  octree.updateCommandSetRevision = function (commandList) {
    revisionCalls++;
    return originalUpdate.call(this, commandList);
  };
  octree.build = function (commandList, frameNumber, revision) {
    buildCalls++;
    return originalBuild.call(this, commandList, frameNumber, revision);
  };
  const work = instrumentRoot(octree._root);

  octree.enabled = false;
  scene.frameState.commandList = commands.slice();
  scene.frameState.frameNumber++;
  callsBefore = ordinaryInputs.length;
  runExecutorPvsSlice(
    scene,
    scene.frameState.commandList,
    octree,
    shadowState,
    view,
  );
  assert.equal(ordinaryInputs.length, callsBefore + 1);
  assert.deepEqual(ordinaryInputs.at(-1), ["mover", "anchor"]);
  assert.equal(revisionCalls, 0);
  assert.equal(buildCalls, 0);
  assert.deepEqual(work, { clear: 0, insert: 0 });

  commands[0].boundingVolume.center.x = 50;
  commands[0].boundingVolume.center.y = 50;
  commands[0].boundingVolume.center.z = 50;
  octree.enabled = true;
  scene.frameState.commandList = commands.slice();
  scene.frameState.cullingVolume = rightCullingVolume;
  scene.frameState.frameNumber++;
  callsBefore = ordinaryInputs.length;
  runExecutorPvsSlice(
    scene,
    scene.frameState.commandList,
    octree,
    shadowState,
    view,
  );
  assert.equal(ordinaryInputs.length, callsBefore + 1);

  const freshCommands = commands.slice();
  const freshTree = makeTree();
  const freshScene = {
    frameState: {
      ...scene.frameState,
      commandList: freshCommands,
    },
  };
  const freshInputs = [];
  runExecutorPvsSlice(freshScene, freshCommands, freshTree, shadowState, {
    createPotentiallyVisibleSet(currentScene) {
      freshInputs.push(
        currentScene.frameState.commandList.map((command) => command.id),
      );
    },
  });

  assert.equal(revisionCalls, 1);
  assert.equal(buildCalls, 1);
  assert.equal(work.clear, 1);
  assert.equal(work.insert, commands.length);
  assert.deepEqual(ordinaryInputs.at(-1), ["mover", "anchor"]);
  assert.deepEqual(ordinaryInputs.at(-1), freshInputs.at(-1));
});

test("M1 mutation control: an inert dirty signal kills stale-query parity", () => {
  const { sceneOctree: sceneOctreeSource } = loadSources();
  const anchor = "    if (dirty) {\n      state.revision++;";
  assert.equal(sceneOctreeSource.split(anchor).length - 1, 1);
  const mutatedSource = sceneOctreeSource.replace(
    anchor,
    "    if (false && dirty) {\n      state.revision++;",
  );
  assert.notEqual(mutatedSource, sceneOctreeSource, "mutation did not apply");
  const MutantSceneOctree = compileSceneOctree(mutatedSource);

  const commands = makeCommands();
  const octree = makeTree();
  const first = buildTracked(octree, commands, 1);
  assert.deepEqual(queryIds(octree, leftCullingVolume), ["mover"]);

  octree.updateCommandSetRevision =
    MutantSceneOctree.prototype.updateCommandSetRevision.bind(octree);
  commands[0].boundingVolume.center.x = 50;
  commands[0].boundingVolume.center.y = 50;
  commands[0].boundingVolume.center.z = 50;
  const second = buildTracked(octree, commands, 2);
  const stale = queryIds(octree, rightCullingVolume);
  const fresh = freshQueryIds(commands, rightCullingVolume);

  assert.equal(second.revision, first.revision);
  assert.equal(octree.stats.rebuildSkips, 1);
  assert.deepEqual(stale, ["anchor"]);
  assert.deepEqual(fresh, ["mover", "anchor"]);
  assert.throws(() => assert.deepEqual(stale, fresh), {
    name: "AssertionError",
  });
});

test("M2 mutation control: inert bypass refresh kills T2 current-object publication", () => {
  const anchor = [
    "        if (!isOctreeEligible(command)) {",
    "          bypassCommands.push(command);",
    "          continue;",
    "        }",
  ].join("\n");
  const replacement = [
    "        if (!isOctreeEligible(command)) {",
    "          if (false && !isOctreeEligible(command)) {",
    "            bypassCommands.push(command);",
    "          }",
    "          continue;",
    "        }",
  ].join("\n");
  const MutantSceneOctree = compileSceneOctreeMutation(
    "M2 inert bypass refresh",
    anchor,
    replacement,
  );

  assert.throws(() => assertCurrentBypassPublished(MutantSceneOctree), {
    name: "AssertionError",
  });
});

test("M3 mutation control: forced reuse kills T3 eligibility transitions", () => {
  const anchor = "    if (canReuse) {";
  const MutantSceneOctree = compileSceneOctreeMutation(
    "M3 forced reuse",
    anchor,
    "    if (true) {",
  );

  assert.throws(() => assertEligibilityTransitionsRebuild(MutantSceneOctree), {
    name: "AssertionError",
  });
});

test("M4 mutation control: disabled reuse kills T1 ineligible-churn skip", () => {
  const anchor = "    if (canReuse) {";
  const MutantSceneOctree = compileSceneOctreeMutation(
    "M4 disabled reuse",
    anchor,
    "    if (false) {",
  );

  assert.throws(() => assertIneligibleChurnReuse(MutantSceneOctree), {
    name: "AssertionError",
  });
});

test("M5 mutation control: whole-list snapshotting kills T1 ineligible-churn reuse", () => {
  const anchor = [
    "        if (!isOctreeEligible(command)) {",
    "          bypassCommands.push(command);",
    "          continue;",
    "        }",
  ].join("\n");
  const replacement = [
    "        if (false && !isOctreeEligible(command)) {",
    "          bypassCommands.push(command);",
    "          continue;",
    "        }",
  ].join("\n");
  const MutantSceneOctree = compileSceneOctreeMutation(
    "M5 whole-list snapshots",
    anchor,
    replacement,
  );

  assert.throws(() => assertIneligibleChurnReuse(MutantSceneOctree), {
    name: "AssertionError",
  });
});

test("M6 mutation control: retaining the scan token past its build kills T6", () => {
  const anchor = [
    "    // A scan is a one-build token. Direct callers and failed builds must",
    "    // repartition rather than publishing references from an earlier list.",
    "    state.commandList = undefined;",
  ].join("\n");
  const MutantSceneOctree = compileSceneOctreeMutation(
    "M6 retained scan token",
    anchor,
    [
      "    // A scan is a one-build token. Direct callers and failed builds must",
      "    // repartition rather than publishing references from an earlier list.",
    ].join("\n"),
  );

  assert.throws(() => assertScanAuthorizesOneBuild(MutantSceneOctree), {
    name: "AssertionError",
  });
});
