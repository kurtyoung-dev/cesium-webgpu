#!/usr/bin/env node
// C11-184 WebGPU Model shadow-command graph probe.
//
// This is a runtime companion to the focused unit specs. It inspects commands
// at the PVS boundary, after Model has emitted its native WebGPU command graph
// but before camera/frustum binning can hide a malformed variant.
//
// Coverage:
//   1. Fresh standalone articulated models across every ShadowMode and a
//      global shadow OFF -> ON -> OFF sequence.
//   2. Native caster layout/resource completeness (`modelP12`,
//      `modelSkinned`, or `modelInstancedSB`).
//   3. Pick, metadata-pick, velocity, silhouette-rim, IDL-copy, and edge
//      variants never inherit shadow semantics when they are present.
//   4. No dedicated model-shadow UB allocation/upload while global shadows are
//      off, or for a fresh DISABLED/RECEIVE_ONLY model that never casts.
//   5. The local b3dm mixed/all-translucent styling cases retain the primary
//      as the only geometry caster. The visible translucent twin never casts,
//      but it still receives in ENABLED/RECEIVE_ONLY.
//   6. A non-identity BoxArticulations node proves that the matrix uploaded to
//      the buffer actually bound by the cast command carries the translation-
//      free model linear transform plus an RTE-encoded camera in model space.
//   7. Native WebGPU keeps the legacy scene shadow source at one pass and a
//      settled static caster performs zero dedicated UB creates/uploads.
//
// The probe intentionally does not start a server or build the bundle.
// Run only against a frozen bundle:
//
//   node Tools/visual-regression/probe-webgpu-model-shadow-command-graph.mjs
//
// Environment:
//   PROBE_BASE=http://localhost:8080

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Machine-safety watchdog (Batch 861+ fleet sweep). A probe that wedges holds a
// headless Edge + GPU process alive indefinitely; `unref` keeps the timer from
// extending a healthy run.
const WATCHDOG_MS = 600_000;
const watchdog = setTimeout(() => {
  console.error(
    `[probe-webgpu-model-shadow-command-graph] watchdog fired after ${WATCHDOG_MS} ms`,
  );
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref?.();

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "output");
const REPORT_PATH = join(
  OUT_DIR,
  "webgpu-model-shadow-command-graph-report.json",
);
const BOX_ARTICULATIONS =
  "/Specs/Data/Models/glTF-2.0/BoxArticulations/glTF/BoxArticulations.gltf";
const B3DM_TILESET =
  "/Apps/SampleData/Cesium3DTiles/Batched/BatchedWithBatchTable/tileset.json";
const SUPPORTED_LAYOUTS = new Set([
  "modelP12",
  "modelSkinned",
  "modelInstancedSB",
]);

mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const consoleErrors = [];
const pageErrors = [];

page.on("console", (message) => {
  if (message.type() === "error") {
    consoleErrors.push(message.text());
  }
});
page.on("pageerror", (error) => pageErrors.push(String(error)));

let result;
try {
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  result = await page.evaluate(
    async ({ boxUrl, tilesetUrl, supportedLayouts }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const viewer = window.viewer;
      const scene = viewer.scene;
      const device = scene.context?._device;
      const failures = [];
      const notes = [];

      function fail(message) {
        failures.push(message);
      }

      function clone(value) {
        return JSON.parse(JSON.stringify(value));
      }

      if (!scene.context?.isWebGPU || !device) {
        return {
          fatal: "Viewer did not initialize a native WebGPU device.",
          failures: ["Viewer did not initialize a native WebGPU device."],
        };
      }

      viewer.useDefaultRenderLoop = false;
      if (viewer.cesiumWidget) {
        viewer.cesiumWidget.useDefaultRenderLoop = false;
      }
      scene.requestRenderMode = false;
      scene.globe.show = false;
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.backgroundColor = C.Color.BLACK;
      scene.taaEnabled = true;
      scene._webgpuPickHoverEnabled = true;
      scene._webgpuPickPreciseEnabled = true;
      scene.useCascadedShadowMaps = false;
      viewer.clock.shouldAnimate = false;
      viewer.clock.currentTime = C.JulianDate.fromIso8601(
        "2026-06-15T18:00:00Z",
      );

      const deviceErrors = [];
      device.onuncapturederror = (event) => {
        deviceErrors.push(event?.error?.message ?? "unknown WebGPU error");
      };

      // Attribute only the dedicated shadow-transform family. Other model
      // allocations are deliberately ignored: this probe answers whether the
      // shadow path pays work while inactive, not total model allocation cost.
      const shadowAudit = {
        patchFailures: [],
        creates: [],
        writes: [],
        reset() {
          this.creates = [];
          this.writes = [];
        },
        snapshot() {
          return {
            creates: clone(this.creates),
            writes: clone(this.writes),
          };
        },
      };

      const shadowBufferLabel = (label) =>
        /^Model shadow cast UB(?: node\[\d+\])?$/.test(String(label || ""));

      try {
        const originalCreateBuffer = device.createBuffer.bind(device);
        device.createBuffer = (descriptor) => {
          const buffer = originalCreateBuffer(descriptor);
          if (shadowBufferLabel(descriptor?.label)) {
            shadowAudit.creates.push({
              label: descriptor.label,
              size: Number(descriptor.size) || 0,
              usage: Number(descriptor.usage) || 0,
            });
          }
          return buffer;
        };
      } catch (error) {
        shadowAudit.patchFailures.push(`GPUDevice.createBuffer: ${error}`);
      }

      function copyWriteBytes(data, dataOffset, size) {
        let buffer;
        let byteOffset;
        let available;
        if (data instanceof ArrayBuffer) {
          buffer = data;
          byteOffset = Number(dataOffset) || 0;
          available = data.byteLength - byteOffset;
        } else if (ArrayBuffer.isView(data)) {
          buffer = data.buffer;
          byteOffset = data.byteOffset + (Number(dataOffset) || 0);
          available = data.byteLength - (Number(dataOffset) || 0);
        } else {
          return new Uint8Array();
        }
        const byteLength = Math.max(
          0,
          Math.min(size === undefined ? available : Number(size), available),
        );
        return new Uint8Array(buffer, byteOffset, byteLength).slice();
      }

      try {
        const queue = device.queue;
        const originalWriteBuffer = queue.writeBuffer.bind(queue);
        queue.writeBuffer = (buffer, bufferOffset, data, dataOffset, size) => {
          if (shadowBufferLabel(buffer?.label)) {
            const bytes = copyWriteBytes(data, dataOffset, size);
            const floatByteLength = Math.floor(bytes.byteLength / 4) * 4;
            const floats =
              floatByteLength > 0
                ? Array.from(
                    new Float32Array(
                      bytes.buffer,
                      bytes.byteOffset,
                      floatByteLength / 4,
                    ),
                  )
                : [];
            shadowAudit.writes.push({
              label: buffer.label,
              bufferOffset: Number(bufferOffset) || 0,
              byteLength: bytes.byteLength,
              floats,
            });
          }
          return originalWriteBuffer(
            buffer,
            bufferOffset,
            data,
            dataOffset,
            size,
          );
        };
      } catch (error) {
        shadowAudit.patchFailures.push(`GPUQueue.writeBuffer: ${error}`);
      }

      if (shadowAudit.patchFailures.length > 0) {
        fail(
          `GPU allocation/upload instrumentation failed: ${shadowAudit.patchFailures.join(
            "; ",
          )}`,
        );
      }

      const passNames = {};
      for (const [name, value] of Object.entries(C.Pass)) {
        if (typeof value === "number") passNames[value] = name;
      }
      const edgePasses = new Set(
        [
          C.Pass.CESIUM_3D_TILE_EDGES,
          C.Pass.CESIUM_3D_TILE_EDGES_DIRECT,
        ].filter((value) => typeof value === "number"),
      );

      let targetOwner;
      let targetKind = "standalone";
      let latestGraph;
      const view = scene._view;
      const originalPVS = view.createPotentiallyVisibleSet.bind(view);

      function commandRole(command, path, topIndex) {
        if (path.includes(".velocityCommand")) return "velocity";
        if (path.includes("pickingMetadata")) return "metadata-pick";
        if (path.includes(".picking")) return "pick";

        const pipelineLabel = String(command?.pipeline?.label || "");
        if (/silhouette-color/i.test(pipelineLabel)) return "silhouette-rim";
        if (edgePasses.has(command?.pass) || /\bedge\b/i.test(pipelineLabel)) {
          return "edge";
        }
        if (
          targetKind === "styled-b3dm" &&
          command?.pass === C.Pass.TRANSLUCENT
        ) {
          return "styled-translucent-twin";
        }
        if (scene.mode === C.SceneMode.SCENE2D && topIndex > 0) {
          return "idl-copy-or-auxiliary";
        }
        return topIndex === 0 ? "primary" : "top-level-auxiliary";
      }

      function summarizeCommand(command, path, topIndex) {
        const ub = command?._shadowCastModelUB;
        const rawUB = ub?.buffer ?? ub;
        return {
          path,
          role: commandRole(command, path, topIndex),
          topLevel: !path.includes("."),
          isWebGPUDrawCommand: command?.isWebGPUDrawCommand === true,
          pass: command?.pass ?? null,
          passName: passNames[command?.pass] ?? String(command?.pass),
          pipelineLabel: String(command?.pipeline?.label || ""),
          castShadows: command?.castShadows === true,
          receiveShadows: command?.receiveShadows === true,
          pickOnly: command?.pickOnly === true,
          shadowCastLayout: command?._shadowCastLayout ?? null,
          shadowCastTopology: command?._shadowCastTopology ?? null,
          shadowModelBufferLabel: rawUB?.label ?? null,
          hasShadowModelUB: !!ub,
          hasStableShadowCacheHost: !!command?._shadowCastBindGroupCacheHost,
          hasShadowJointMatricesSB: !!command?._shadowCastJointMatricesSB,
          hasShadowInstancingSB: !!command?._shadowCastInstancingSB,
          vertexBufferCount: command?.vertexBuffers?.length ?? 0,
          bindGroupCount: command?.bindGroups?.length ?? 0,
          indexCount: command?.indexCount ?? 0,
          vertexCount: command?.vertexCount ?? 0,
        };
      }

      function summarizeTargetGraph() {
        const top = scene.frameState.commandList.filter(
          (command) =>
            command?.owner === targetOwner &&
            command?.isWebGPUDrawCommand === true,
        );
        const graph = [];
        const seen = new Set();

        function add(command, path, topIndex) {
          if (
            !command ||
            command.isWebGPUDrawCommand !== true ||
            seen.has(command)
          ) {
            return;
          }
          seen.add(command);
          graph.push(summarizeCommand(command, path, topIndex));

          if (command.velocityCommand) {
            add(command.velocityCommand, `${path}.velocityCommand`, topIndex);
          }

          function visitDerived(value, derivedPath, depth) {
            if (!value || depth > 5) return;
            if (value.isWebGPUDrawCommand === true) {
              add(value, derivedPath, topIndex);
              return;
            }
            if (typeof value !== "object") return;
            for (const [key, nested] of Object.entries(value)) {
              visitDerived(nested, `${derivedPath}.${key}`, depth + 1);
            }
          }
          visitDerived(command.derivedCommands, `${path}.derivedCommands`, 0);
        }

        for (let i = 0; i < top.length; i++) {
          add(top[i], `top[${i}]`, i);
        }

        return {
          frameNumber: scene.frameState.frameNumber,
          mode: scene.mode,
          shadowMapCount: scene.frameState.shadowMaps?.length ?? 0,
          shadowsEnabled: scene.frameState.shadowState?.shadowsEnabled === true,
          lightShadowsEnabled:
            scene.frameState.shadowState?.lightShadowsEnabled === true,
          shadowPassCounts:
            scene.frameState.shadowMaps?.map(
              (shadowMap) => shadowMap?.passes?.length ?? 0,
            ) ?? [],
          csmRequested: scene.frameState.useCascadedShadowMaps === true,
          commands: graph,
        };
      }

      view.createPotentiallyVisibleSet = function (pvsScene) {
        if (targetOwner) {
          latestGraph = summarizeTargetGraph();
        }
        return originalPVS(pvsScene);
      };

      function setTarget(owner, kind) {
        targetOwner = owner;
        targetKind = kind;
        latestGraph = undefined;
      }

      async function renderFrame() {
        scene.render();
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }

      async function renderUntil(predicate, maxFrames, description) {
        for (let i = 0; i < maxFrames; i++) {
          await renderFrame();
          if (predicate()) return i + 1;
        }
        fail(`Timed out waiting for ${description}.`);
        return maxFrames;
      }

      async function renderFrames(count) {
        for (let i = 0; i < count; i++) await renderFrame();
      }

      function setGlobalShadows(enabled) {
        viewer.shadows = enabled;
        if (scene.shadowMap) scene.shadowMap.enabled = enabled;
        scene.requestRender();
      }

      function phaseSnapshot() {
        return {
          graph: latestGraph ? clone(latestGraph) : null,
          audit: shadowAudit.snapshot(),
        };
      }

      function matrixArray(matrix) {
        return Array.from(C.Matrix4.toArray(matrix, new Array(16)));
      }

      function float32MatrixArray(matrix) {
        return Array.from(new Float32Array(C.Matrix4.toArray(matrix)));
      }

      const modes = [
        {
          name: "DISABLED",
          value: C.ShadowMode.DISABLED,
          cast: false,
          receive: false,
        },
        {
          name: "ENABLED",
          value: C.ShadowMode.ENABLED,
          cast: true,
          receive: true,
        },
        {
          name: "CAST_ONLY",
          value: C.ShadowMode.CAST_ONLY,
          cast: true,
          receive: false,
        },
        {
          name: "RECEIVE_ONLY",
          value: C.ShadowMode.RECEIVE_ONLY,
          cast: false,
          receive: true,
        },
      ];

      const standaloneCells = [];
      let articulationEvidence = null;
      const origin = C.Cartesian3.fromDegrees(-75.0, 40.0, 100.0);
      const rootModelMatrix = C.Transforms.eastNorthUpToFixedFrame(origin);

      for (const mode of modes) {
        setGlobalShadows(false);
        shadowAudit.reset();

        const model = await C.Model.fromGltfAsync({
          url: boxUrl,
          modelMatrix: C.Matrix4.clone(rootModelMatrix),
          shadows: mode.value,
          allowPicking: true,
        });
        model.silhouetteSize = 3.0;
        model.silhouetteColor = C.Color.YELLOW;
        scene.primitives.add(model);
        setTarget(model, "standalone");

        await renderUntil(
          () => model.ready === true,
          300,
          `${mode.name} BoxArticulations readiness`,
        );

        // Force a non-identity hierarchy. The renderable Mesh child inherits
        // this articulated Root transform through computedTransform.
        model.setArticulationStage("SampleArticulation MoveX", 12.0);
        model.setArticulationStage("SampleArticulation MoveY", 3.0);
        model.setArticulationStage("SampleArticulation Yaw", 17.0);
        model.applyArticulations();

        const sphere = model.boundingSphere;
        if (sphere) {
          scene.camera.viewBoundingSphere(
            sphere,
            new C.HeadingPitchRange(
              0.0,
              -0.25,
              Math.max(sphere.radius * 5.0, 12.0),
            ),
          );
          scene.camera.lookAtTransform(C.Matrix4.IDENTITY);
        }

        await renderUntil(
          // eslint-disable-next-line no-loop-func -- the closure is consumed inside this iteration (or reads a shared kill switch), not a stale per-iteration binding
          () =>
            latestGraph?.commands?.some(
              (command) => command.role === "primary",
            ),
          300,
          `${mode.name} initial model command graph`,
        );
        await renderFrames(8);
        const offFresh = phaseSnapshot();

        setGlobalShadows(true);
        shadowAudit.reset();
        await renderUntil(
          // eslint-disable-next-line no-loop-func -- the closure is consumed inside this iteration (or reads a shared kill switch), not a stale per-iteration binding
          () => {
            if (!latestGraph || latestGraph.shadowMapCount < 1) return false;
            const primaries = latestGraph.commands.filter(
              (command) => command.role === "primary",
            );
            if (primaries.length < 1) return false;
            return mode.cast
              ? primaries.every((command) => !!command.shadowCastLayout)
              : true;
          },
          300,
          `${mode.name} shadow-ON command graph`,
        );
        await renderFrames(4);
        const on = phaseSnapshot();

        // Dedicated cast resources are byte-dirty. Once the camera, hierarchy,
        // and shadow mode settle, the command graph may continue rendering but
        // the model-shadow UB must not be recreated or rewritten.
        shadowAudit.reset();
        await renderFrames(3);
        const onSettled = phaseSnapshot();

        if (mode.name === "ENABLED") {
          const runtimeNode = model._sceneGraph?._runtimeNodes?.find(
            (node) => node?.runtimePrimitives?.length > 0,
          );
          const rendererRootMatrix =
            model._sceneGraph?._computedModelMatrix ?? model.modelMatrix;
          const expectedMatrix =
            rendererRootMatrix &&
            runtimeNode?.computedTransform &&
            C.Matrix4.multiplyTransformation(
              rendererRootMatrix,
              runtimeNode.computedTransform,
              new C.Matrix4(),
            );
          const expectedLinear = expectedMatrix
            ? C.Matrix4.clone(expectedMatrix, new C.Matrix4())
            : null;
          if (expectedLinear) {
            expectedLinear[12] = 0.0;
            expectedLinear[13] = 0.0;
            expectedLinear[14] = 0.0;
          }
          const inverseExpected = expectedMatrix
            ? C.Matrix4.inverse(expectedMatrix, new C.Matrix4())
            : null;
          const cameraWC = scene.context.uniformState.cameraPosition;
          const expectedCameraMC =
            inverseExpected && cameraWC
              ? C.Matrix4.multiplyByPoint(
                  inverseExpected,
                  cameraWC,
                  new C.Cartesian3(),
                )
              : null;
          const encodedCameraMC = expectedCameraMC
            ? C.EncodedCartesian3.fromCartesian(expectedCameraMC)
            : null;
          const primary = on.graph?.commands?.find(
            (command) => command.role === "primary",
          );
          const boundLabel = primary?.shadowModelBufferLabel ?? null;
          const boundWrite = [...(on.audit?.writes ?? [])]
            .reverse()
            .find((write) => write.label === boundLabel);
          articulationEvidence = {
            runtimeNodeFound: !!runtimeNode,
            sourceModelMatrix: matrixArray(model.modelMatrix),
            rendererRootMatrix: rendererRootMatrix
              ? matrixArray(rendererRootMatrix)
              : null,
            nodeComputedTransform: runtimeNode?.computedTransform
              ? matrixArray(runtimeNode.computedTransform)
              : null,
            expectedLinear: expectedLinear
              ? float32MatrixArray(expectedLinear)
              : null,
            expectedEncodedCameraMC: encodedCameraMC
              ? Array.from(
                  new Float32Array([
                    encodedCameraMC.high.x,
                    encodedCameraMC.high.y,
                    encodedCameraMC.high.z,
                    0.0,
                    encodedCameraMC.low.x,
                    encodedCameraMC.low.y,
                    encodedCameraMC.low.z,
                    0.0,
                  ]),
                )
              : null,
            boundBufferLabel: boundLabel,
            uploadedLinear: boundWrite?.floats?.slice(0, 16) ?? null,
            uploadedEncodedCameraMC: boundWrite?.floats?.slice(16, 24) ?? null,
            uploadByteLength: boundWrite?.byteLength ?? 0,
          };
        }

        setGlobalShadows(false);
        shadowAudit.reset();
        await renderUntil(
          // eslint-disable-next-line no-loop-func -- the closure is consumed inside this iteration (or reads a shared kill switch), not a stale per-iteration binding
          () => !!latestGraph && latestGraph.shadowMapCount === 0,
          120,
          `${mode.name} shadow-OFF-again command graph`,
        );
        await renderFrames(4);
        const offAgain = phaseSnapshot();

        standaloneCells.push({
          mode: mode.name,
          expected: { cast: mode.cast, receive: mode.receive },
          offFresh,
          on,
          onSettled,
          offAgain,
        });

        setTarget(undefined, "standalone");
        scene.primitives.remove(model);
        await renderFrames(2);
      }

      function primaryCommands(phase) {
        return (
          phase?.graph?.commands?.filter(
            (command) => command.role === "primary",
          ) ?? []
        );
      }

      function validateLayout(command, label) {
        if (!supportedLayouts.includes(command.shadowCastLayout)) {
          fail(
            `${label}: unsupported/missing caster layout ${String(
              command.shadowCastLayout,
            )}.`,
          );
          return;
        }
        if (!command.hasShadowModelUB || !command.shadowModelBufferLabel) {
          fail(`${label}: caster has no bound model shadow uniform buffer.`);
        }
        if (
          command.shadowCastLayout === "modelSkinned" &&
          !command.hasShadowJointMatricesSB
        ) {
          fail(`${label}: modelSkinned caster has no joint-matrix buffer.`);
        }
        if (
          command.shadowCastLayout === "modelInstancedSB" &&
          !command.hasShadowInstancingSB
        ) {
          fail(`${label}: modelInstancedSB caster has no instance buffer.`);
        }
        if (command.vertexBufferCount < 1) {
          fail(`${label}: caster has no vertex buffers.`);
        }
      }

      for (const cell of standaloneCells) {
        for (const [phaseName, phase] of [
          ["offFresh", cell.offFresh],
          ["on", cell.on],
          ["offAgain", cell.offAgain],
        ]) {
          const label = `${cell.mode}/${phaseName}`;
          const primaries = primaryCommands(phase);
          if (primaries.length !== 1) {
            fail(`${label}: expected one primary, found ${primaries.length}.`);
          }
          for (const primary of primaries) {
            if (primary.castShadows !== cell.expected.cast) {
              fail(`${label}: primary castShadows semantic is wrong.`);
            }
            if (primary.receiveShadows !== cell.expected.receive) {
              fail(`${label}: primary receiveShadows semantic is wrong.`);
            }
          }

          const auxiliaries =
            phase?.graph?.commands?.filter(
              (command) => command.role !== "primary",
            ) ?? [];
          for (const auxiliary of auxiliaries) {
            if (auxiliary.castShadows || auxiliary.receiveShadows) {
              fail(
                `${label}: ${auxiliary.role} (${auxiliary.path}) inherited shadow flags.`,
              );
            }
          }
        }

        if (cell.offFresh.graph?.shadowMapCount !== 0) {
          fail(
            `${cell.mode}/offFresh: global OFF still published shadow maps.`,
          );
        }
        if (cell.on.graph?.shadowMapCount < 1) {
          fail(`${cell.mode}/on: global ON published no shadow map.`);
        }
        if (
          cell.on.graph?.shadowPassCounts?.some((passCount) => passCount !== 1)
        ) {
          fail(
            `${cell.mode}/on: native WebGPU expected one legacy source pass per shadow map, got ${cell.on.graph.shadowPassCounts.join(
              ",",
            )}.`,
          );
        }
        if (cell.offAgain.graph?.shadowMapCount !== 0) {
          fail(
            `${cell.mode}/offAgain: global OFF still published shadow maps.`,
          );
        }

        if (
          cell.offFresh.audit.creates.length !== 0 ||
          cell.offFresh.audit.writes.length !== 0
        ) {
          fail(
            `${cell.mode}/offFresh: fresh globally-OFF model allocated/uploaded a shadow UB.`,
          );
        }
        if (
          cell.offAgain.audit.creates.length !== 0 ||
          cell.offAgain.audit.writes.length !== 0
        ) {
          fail(`${cell.mode}/offAgain: disabling shadows did shadow UB work.`);
        }

        const onPrimaries = primaryCommands(cell.on);
        if (cell.expected.cast) {
          for (const primary of onPrimaries) {
            validateLayout(primary, `${cell.mode}/on`);
          }
          if (
            cell.on.audit.creates.length < 1 ||
            cell.on.audit.writes.length < 1
          ) {
            fail(
              `${cell.mode}/on: fresh casting model did not create and seed a shadow UB.`,
            );
          }
          if (
            cell.onSettled.audit.creates.length !== 0 ||
            cell.onSettled.audit.writes.length !== 0
          ) {
            fail(
              `${cell.mode}/onSettled: static caster recreated or rewrote its dedicated shadow UB.`,
            );
          }
        } else {
          if (
            cell.on.audit.creates.length !== 0 ||
            cell.on.audit.writes.length !== 0
          ) {
            fail(
              `${cell.mode}/on: non-casting model allocated/uploaded a shadow UB.`,
            );
          }
          if (
            onPrimaries.some(
              (command) =>
                command.shadowCastLayout ||
                command.hasShadowModelUB ||
                command.hasShadowJointMatricesSB ||
                command.hasShadowInstancingSB,
            )
          ) {
            fail(`${cell.mode}/on: non-caster carried native cast resources.`);
          }
        }
      }

      const standaloneRoles = new Set(
        standaloneCells.flatMap((cell) =>
          [cell.offFresh, cell.on, cell.offAgain].flatMap(
            (phase) =>
              phase?.graph?.commands?.map((command) => command.role) ?? [],
          ),
        ),
      );
      for (const configuredRole of ["pick", "velocity", "silhouette-rim"]) {
        if (!standaloneRoles.has(configuredRole)) {
          fail(
            `Configured standalone coverage never emitted a ${configuredRole} command.`,
          );
        }
      }
      for (const optionalRole of [
        "metadata-pick",
        "idl-copy-or-auxiliary",
        "edge",
      ]) {
        if (!standaloneRoles.has(optionalRole)) {
          notes.push(
            `${optionalRole} was not present in this 3D BoxArticulations fixture; the graph walker will validate it when present.`,
          );
        }
      }

      if (
        !articulationEvidence?.runtimeNodeFound ||
        !articulationEvidence?.expectedLinear ||
        !articulationEvidence?.expectedEncodedCameraMC ||
        !articulationEvidence?.uploadedLinear ||
        !articulationEvidence?.uploadedEncodedCameraMC ||
        !articulationEvidence?.boundBufferLabel
      ) {
        fail(
          "HARD GAP: no bound BoxArticulations shadow-UB matrix evidence was captured.",
        );
      } else {
        const expected = [
          ...articulationEvidence.expectedLinear,
          ...articulationEvidence.expectedEncodedCameraMC,
        ];
        const actual = [
          ...articulationEvidence.uploadedLinear,
          ...articulationEvidence.uploadedEncodedCameraMC,
        ];
        if (actual.length !== 24) {
          fail(
            `Articulation upload contained ${actual.length} floats instead of 24.`,
          );
        } else {
          let maxRelativeError = 0;
          let mismatchIndex = -1;
          for (let i = 0; i < 16; i++) {
            const scale = Math.max(1, Math.abs(expected[i]));
            const relativeError = Math.abs(actual[i] - expected[i]) / scale;
            maxRelativeError = Math.max(maxRelativeError, relativeError);
            if (relativeError > 1e-6 && mismatchIndex < 0) {
              mismatchIndex = i;
            }
          }
          articulationEvidence.maxRelativeError = maxRelativeError;
          articulationEvidence.matchesRteTransform = mismatchIndex < 0;
          if (mismatchIndex >= 0) {
            fail(
              `Articulation shadow RTE payload differs at index ${mismatchIndex}: expected ${expected[mismatchIndex]}, uploaded ${actual[mismatchIndex]}.`,
            );
          }
        }
        if (articulationEvidence.uploadByteLength !== 96) {
          fail(
            `Articulation shadow payload was ${articulationEvidence.uploadByteLength} bytes instead of 96.`,
          );
        }
      }

      // Local b3dm styled-command economics companion.
      setGlobalShadows(true);
      shadowAudit.reset();
      const tileset = await C.Cesium3DTileset.fromUrl(tilesetUrl, {
        shadows: C.ShadowMode.ENABLED,
      });
      scene.primitives.add(tileset);

      // fromUrl resolves the tileset JSON/root bounding volume before content
      // selection. Frame that root first; waiting for a selected Model while
      // the default viewer camera points elsewhere is a circular wait.
      const initialTileSphere = tileset.boundingSphere;
      if (initialTileSphere) {
        scene.camera.viewBoundingSphere(
          initialTileSphere,
          new C.HeadingPitchRange(
            0.0,
            -0.35,
            Math.max(initialTileSphere.radius * 3.0, 20.0),
          ),
        );
        scene.camera.lookAtTransform(C.Matrix4.IDENTITY);
      }

      await renderUntil(
        () => {
          const selected = tileset._selectedTiles ?? [];
          return selected.some((tile) => tile.content?._model?.ready === true);
        },
        400,
        "local b3dm model readiness",
      );

      const tileSphere = tileset.boundingSphere;
      if (tileSphere) {
        scene.camera.viewBoundingSphere(
          tileSphere,
          new C.HeadingPitchRange(
            0.0,
            -0.35,
            Math.max(tileSphere.radius * 3.0, 20.0),
          ),
        );
        scene.camera.lookAtTransform(C.Matrix4.IDENTITY);
      }

      function selectedContent() {
        for (const tile of tileset._selectedTiles ?? []) {
          const content = tile.content;
          const model = content?._model;
          if (model?.featureTables?.length) {
            const featureTable = model.featureTables[model.featureTableId];
            return { content, model, featureTable };
          }
        }
        return null;
      }

      await renderUntil(
        () => !!selectedContent(),
        300,
        "selected b3dm feature table",
      );
      const tileInfo = selectedContent();
      if (!tileInfo) {
        fail("Local b3dm selected no feature-bearing Model.");
      }

      const styledCells = [];
      if (tileInfo) {
        const featureCount = tileInfo.featureTable.featuresLength;

        function applyMixed() {
          for (let i = 0; i < featureCount; i++) {
            const feature = tileInfo.content.getFeature(i);
            if (!feature) continue;
            feature.color =
              i % 2 === 0 ? C.Color.fromBytes(255, 0, 0, 102) : C.Color.WHITE;
          }
        }

        function applyAllTranslucent() {
          for (let i = 0; i < featureCount; i++) {
            const feature = tileInfo.content.getFeature(i);
            if (!feature) continue;
            feature.color = C.Color.fromBytes(0, 255, 0, 102);
          }
        }

        for (const style of [
          { name: "mixed", apply: applyMixed },
          { name: "all-translucent", apply: applyAllTranslucent },
        ]) {
          style.apply();
          setTarget(tileInfo.model, "styled-b3dm");

          for (const mode of modes) {
            tileset.shadows = mode.value;
            shadowAudit.reset();
            await renderUntil(
              // eslint-disable-next-line no-loop-func -- the closure is consumed inside this iteration (or reads a shared kill switch), not a stale per-iteration binding
              () => {
                if (!latestGraph || latestGraph.shadowMapCount < 1)
                  return false;
                const commands = latestGraph.commands;
                const primary = commands.find(
                  (command) => command.role === "primary",
                );
                const twin = commands.find(
                  (command) => command.role === "styled-translucent-twin",
                );
                if (!primary || !twin) return false;
                return (
                  primary.castShadows === mode.cast &&
                  primary.receiveShadows === mode.receive &&
                  twin.receiveShadows === mode.receive &&
                  twin.castShadows === false
                );
              },
              300,
              `${style.name}/${mode.name} styled b3dm graph`,
            );
            await renderFrames(3);
            styledCells.push({
              style: style.name,
              mode: mode.name,
              expected: { cast: mode.cast, receive: mode.receive },
              phase: phaseSnapshot(),
              styleCommandsNeeded: tileInfo.model.styleCommandsNeeded,
              translucentFeaturesLength:
                tileInfo.featureTable.batchTexture.translucentFeaturesLength,
              featureCount,
            });
          }
        }
      }

      for (const cell of styledCells) {
        const label = `${cell.style}/${cell.mode}`;
        const commands = cell.phase.graph?.commands ?? [];
        const primaries = commands.filter(
          (command) => command.role === "primary",
        );
        const twins = commands.filter(
          (command) => command.role === "styled-translucent-twin",
        );
        const casters = commands.filter(
          (command) =>
            command.topLevel === true && command.castShadows === true,
        );

        if (primaries.length !== 1) {
          fail(`${label}: expected one primary, found ${primaries.length}.`);
        }
        if (twins.length !== 1) {
          fail(
            `${label}: expected one styled translucent twin, found ${twins.length}.`,
          );
        }
        if (cell.expected.cast ? casters.length !== 1 : casters.length !== 0) {
          fail(
            `${label}: expected ${cell.expected.cast ? 1 : 0} geometry caster(s), found ${casters.length}.`,
          );
        }

        for (const primary of primaries) {
          if (
            primary.castShadows !== cell.expected.cast ||
            primary.receiveShadows !== cell.expected.receive
          ) {
            fail(`${label}: primary shadow-mode semantics are wrong.`);
          }
          if (cell.expected.cast) {
            validateLayout(primary, label);
          }
        }
        for (const twin of twins) {
          if (twin.castShadows) {
            fail(`${label}: styled translucent twin casts geometry twice.`);
          }
          if (twin.receiveShadows !== cell.expected.receive) {
            fail(`${label}: styled translucent twin receive flag is wrong.`);
          }
          if (
            twin.shadowCastLayout ||
            twin.hasShadowModelUB ||
            twin.hasShadowJointMatricesSB ||
            twin.hasShadowInstancingSB
          ) {
            fail(`${label}: styled translucent twin carries cast resources.`);
          }
        }

        const nonColor = commands.filter(
          (command) =>
            command.role !== "primary" &&
            command.role !== "styled-translucent-twin",
        );
        for (const command of nonColor) {
          if (command.castShadows || command.receiveShadows) {
            fail(
              `${label}: ${command.role} (${command.path}) inherited shadow flags.`,
            );
          }
        }

        if (
          !cell.expected.cast &&
          (cell.phase.audit.creates.length > 0 ||
            cell.phase.audit.writes.length > 0)
        ) {
          fail(`${label}: non-casting styled model did shadow UB work.`);
        }
        if (
          cell.style === "all-translucent" &&
          cell.expected.cast &&
          casters.length !== 1
        ) {
          fail(
            `${label}: ALL_TRANSLUCENT did not retain exactly one primary caster.`,
          );
        }
      }

      setTarget(undefined, "standalone");
      scene.primitives.remove(tileset);
      view.createPotentiallyVisibleSet = originalPVS;

      if (deviceErrors.length > 0) {
        fail(`WebGPU validation errors: ${deviceErrors.join(" | ")}`);
      }

      return {
        renderer: scene.context?.rendererType ?? "unknown",
        isWebGPU: scene.context?.isWebGPU === true,
        instrumentation: {
          patchFailures: shadowAudit.patchFailures,
        },
        standaloneCells,
        standaloneRoles: [...standaloneRoles].sort(),
        articulationEvidence,
        styledCells,
        deviceErrors,
        notes,
        failures,
        pass: failures.length === 0,
      };
    },
    {
      boxUrl: BOX_ARTICULATIONS,
      tilesetUrl: B3DM_TILESET,
      supportedLayouts: [...SUPPORTED_LAYOUTS],
    },
  );
} catch (error) {
  result = {
    fatal: String(error?.stack || error),
    failures: [`Probe execution failed: ${String(error?.message || error)}`],
    notes: [],
    pass: false,
  };
} finally {
  await browser.close();
}

if (pageErrors.length > 0) {
  result.failures.push(`Page errors: ${pageErrors.join(" | ")}`);
}
if (consoleErrors.length > 0) {
  result.failures.push(`Console errors: ${consoleErrors.join(" | ")}`);
}
result.pageErrors = pageErrors;
result.consoleErrors = consoleErrors;
result.pass = result.failures.length === 0;
result.runAt = new Date().toISOString();
result.base = BASE;

writeFileSync(REPORT_PATH, JSON.stringify(result, null, 2));

console.log("[probe-webgpu-model-shadow-command-graph]");
console.log(`  renderer: ${result.renderer}`);
console.log(
  `  standalone roles: ${(result.standaloneRoles ?? []).join(", ") || "(none)"}`,
);
console.log(
  `  standalone cells: ${result.standaloneCells?.length ?? 0}; styled cells: ${
    result.styledCells?.length ?? 0
  }`,
);
console.log(
  `  articulated root*node: ${
    result.articulationEvidence?.matchesRteTransform ? "PASS" : "FAIL"
  }`,
);
for (const note of result.notes ?? []) console.log(`  NOTE: ${note}`);
for (const failure of result.failures ?? []) console.log(`  FAIL: ${failure}`);
console.log(`  report: ${REPORT_PATH}`);
console.log(`  OVERALL: ${result.pass ? "PASS" : "FAIL"}`);

process.exitCode = result.pass ? 0 : 1;
