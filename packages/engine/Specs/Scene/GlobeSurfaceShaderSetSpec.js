import {
  DerivedCommand,
  GlobeSurfaceShaderSet,
  SceneMode,
  ShaderProgram,
  ShaderSource,
  TerrainQuantization,
} from "../../index.js";
import { isGroundAtmosphereCompanionDistance } from "../../Source/Scene/GlobeSurfaceTileProviderRendering.js";

describe(
  "Scene/GlobeSurfaceShaderSet",
  function () {
    let shaderSet;
    let frameState;
    let createdPrograms;
    let lifecycle;

    function createSurfaceTile() {
      return {
        renderedMesh: {
          encoding: {
            quantization: TerrainQuantization.NONE,
            getAttributeLocations: function () {
              return {};
            },
          },
        },
      };
    }

    function createOptions(surfaceTile) {
      return {
        frameState: frameState,
        surfaceTile: surfaceTile,
        numberOfDayTextures: 0,
      };
    }

    function createProgram(label) {
      const program = {
        label: label,
      };
      program.destroy = jasmine
        .createSpy(`destroy ${label}`)
        .and.callFake(function () {
          lifecycle.push(`release ${label}`);
          return undefined;
        });
      return program;
    }

    function installFogCompanionScheduler(
      schedule,
      context = frameState.context,
    ) {
      const preparations = [];
      context._parallelShaderCompile = {};
      context.shaderCache = {
        scheduleShaderProgramPreparation: jasmine
          .createSpy("scheduleShaderProgramPreparation")
          .and.callFake(function (prepare, owner) {
            const accepted = schedule?.(prepare, owner) ?? true;
            if (accepted) {
              preparations.push(prepare);
            }
            return accepted;
          }),
        cancelShaderProgramPreparations: jasmine
          .createSpy("cancelShaderProgramPreparations")
          .and.returnValue(0),
      };
      frameState.shadowState = {
        lightShadowsEnabled: false,
      };
      return preparations;
    }

    function enableFogCompanion(options) {
      options.enableFog = false;
      options.baseColorCorrect = false;
      options.fogCompanionEnabled = true;
    }

    function enableGroundAtmosphereCompanion(options) {
      options.showGroundAtmosphere = true;
      options.perFragmentGroundAtmosphere = false;
      options.baseColorCorrect = false;
      options.colorCorrect = false;
      options.groundAtmosphereCompanionEnabled = true;
    }

    beforeEach(function () {
      shaderSet = new GlobeSurfaceShaderSet();
      shaderSet.baseVertexShaderSource = new ShaderSource({
        sources: ["void main() { gl_Position = vec4(0.0); }"],
      });
      shaderSet.baseFragmentShaderSource = new ShaderSource({
        sources: ["void main() { out_FragColor = vec4(1.0); }"],
      });

      frameState = {
        context: {
          floatingPointTexture: true,
          limits: {
            maximumTextureSize: 4096,
          },
          webgl2: true,
        },
        mode: SceneMode.SCENE3D,
      };

      createdPrograms = [];
      lifecycle = [];
      spyOn(ShaderProgram, "fromCache").and.callFake(function () {
        const label = `program ${createdPrograms.length + 1}`;
        const program = createProgram(label);
        createdPrograms.push(program);
        lifecycle.push(`acquire ${label}`);
        return program;
      });
    });

    it("releases a displaced material variant and invalidates stale tiles", function () {
      const materialA = {};
      const materialB = {};
      const tileA = createSurfaceTile();
      const tileB = createSurfaceTile();
      const optionsA = createOptions(tileA);
      const optionsB = createOptions(tileB);

      shaderSet.material = materialA;
      const programA = shaderSet.getShaderProgram(optionsA);
      expect(shaderSet.getShaderProgram(optionsB)).toBe(programA);
      expect(ShaderProgram.fromCache).toHaveBeenCalledTimes(1);

      const sharedMaterialAWrapper = tileA.surfaceShader;
      expect(tileB.surfaceShader).toBe(sharedMaterialAWrapper);

      shaderSet.material = materialB;
      const programB = shaderSet.getShaderProgram(optionsA);
      expect(programB).toBe(createdPrograms[1]);
      expect(lifecycle.slice(0, 3)).toEqual([
        "acquire program 1",
        "acquire program 2",
        "release program 1",
      ]);
      expect(programA.destroy).toHaveBeenCalledTimes(1);
      expect(sharedMaterialAWrapper.shaderProgram).toBeUndefined();
      expect(tileB.surfaceShader).toBe(sharedMaterialAWrapper);

      shaderSet.material = materialA;
      const reacquiredMaterialAProgram = shaderSet.getShaderProgram(optionsB);
      expect(ShaderProgram.fromCache).toHaveBeenCalledTimes(3);
      expect(reacquiredMaterialAProgram).toBe(createdPrograms[2]);
      expect(programB.destroy).toHaveBeenCalledTimes(1);
      expect(tileB.surfaceShader).not.toBe(sharedMaterialAWrapper);

      shaderSet.destroy();
      expect(reacquiredMaterialAProgram.destroy).toHaveBeenCalledTimes(1);
    });

    it("keeps ownership continuous when replacement reuses the same cached program", function () {
      const tile = createSurfaceTile();
      const options = createOptions(tile);
      const cachedProgram = {
        references: 0,
      };
      cachedProgram.destroy = jasmine
        .createSpy("destroy cached program")
        .and.callFake(function () {
          --cachedProgram.references;
          lifecycle.push("release cached program");
          return undefined;
        });
      ShaderProgram.fromCache.and.callFake(function () {
        ++cachedProgram.references;
        lifecycle.push("acquire cached program");
        return cachedProgram;
      });

      shaderSet.material = {};
      expect(shaderSet.getShaderProgram(options)).toBe(cachedProgram);
      expect(cachedProgram.references).toBe(1);

      shaderSet.material = {};
      expect(shaderSet.getShaderProgram(options)).toBe(cachedProgram);
      expect(cachedProgram.references).toBe(1);
      expect(lifecycle).toEqual([
        "acquire cached program",
        "acquire cached program",
        "release cached program",
      ]);

      shaderSet.destroy();
      expect(cachedProgram.references).toBe(0);
      expect(cachedProgram.destroy).toHaveBeenCalledTimes(2);
    });

    it("keeps context-owned shader buckets across an A to B to A transition", function () {
      const contextA = frameState.context;
      contextA.shaderCache = {};
      const contextB = {
        ...contextA,
        shaderCache: {},
      };
      const tile = createSurfaceTile();
      const options = createOptions(tile);

      const programA = shaderSet.getShaderProgram(options);
      expect(tile.surfaceShader.context).toBe(contextA);

      frameState.context = contextB;
      const programB = shaderSet.getShaderProgram(options);
      expect(programB).not.toBe(programA);
      expect(tile.surfaceShader.context).toBe(contextB);
      expect(programA.destroy).not.toHaveBeenCalled();
      expect(programB.destroy).not.toHaveBeenCalled();

      frameState.context = contextA;
      expect(shaderSet.getShaderProgram(options)).toBe(programA);
      expect(tile.surfaceShader.context).toBe(contextA);
      expect(ShaderProgram.fromCache).toHaveBeenCalledTimes(2);
      expect(programA.destroy).not.toHaveBeenCalled();
      expect(programB.destroy).not.toHaveBeenCalled();

      shaderSet.destroy();
      expect(programA.destroy).toHaveBeenCalledTimes(1);
      expect(programB.destroy).toHaveBeenCalledTimes(1);
    });

    it("preserves the live cell when replacement acquisition throws", function () {
      const tile = createSurfaceTile();
      const options = createOptions(tile);

      shaderSet.material = {};
      const liveProgram = shaderSet.getShaderProgram(options);
      const liveWrapper = tile.surfaceShader;

      shaderSet.material = {};
      ShaderProgram.fromCache.and.throwError("replacement failed");
      expect(function () {
        shaderSet.getShaderProgram(options);
      }).toThrowError("replacement failed");

      expect(tile.surfaceShader).toBe(liveWrapper);
      expect(liveWrapper.shaderProgram).toBe(liveProgram);
      expect(liveProgram.destroy).not.toHaveBeenCalled();

      shaderSet.destroy();
      expect(liveProgram.destroy).toHaveBeenCalledTimes(1);
    });

    it("releases a displaced clipping variant and invalidates stale tiles", function () {
      const clippingPlanes = {
        length: 1,
        clippingPlanesState: -1,
        unionClippingRegions: false,
        texture: undefined,
      };
      const tileA = createSurfaceTile();
      const tileB = createSurfaceTile();
      const optionsA = createOptions(tileA);
      const optionsB = createOptions(tileB);
      optionsA.enableClippingPlanes = true;
      optionsA.clippingPlanes = clippingPlanes;
      optionsB.enableClippingPlanes = true;
      optionsB.clippingPlanes = clippingPlanes;

      const onePlaneProgram = shaderSet.getShaderProgram(optionsA);
      expect(shaderSet.getShaderProgram(optionsB)).toBe(onePlaneProgram);
      expect(ShaderProgram.fromCache).toHaveBeenCalledTimes(1);

      const sharedOnePlaneWrapper = tileA.surfaceShader;
      expect(tileB.surfaceShader).toBe(sharedOnePlaneWrapper);

      clippingPlanes.length = 2;
      clippingPlanes.clippingPlanesState = -2;
      const twoPlaneProgram = shaderSet.getShaderProgram(optionsA);
      expect(twoPlaneProgram).toBe(createdPrograms[1]);
      expect(lifecycle.slice(0, 3)).toEqual([
        "acquire program 1",
        "acquire program 2",
        "release program 1",
      ]);
      expect(onePlaneProgram.destroy).toHaveBeenCalledTimes(1);
      expect(sharedOnePlaneWrapper.shaderProgram).toBeUndefined();
      expect(tileB.surfaceShader).toBe(sharedOnePlaneWrapper);

      clippingPlanes.length = 1;
      clippingPlanes.clippingPlanesState = -1;
      const reacquiredOnePlaneProgram = shaderSet.getShaderProgram(optionsB);
      expect(ShaderProgram.fromCache).toHaveBeenCalledTimes(3);
      expect(reacquiredOnePlaneProgram).toBe(createdPrograms[2]);
      expect(twoPlaneProgram.destroy).toHaveBeenCalledTimes(1);
      expect(tileB.surfaceShader).not.toBe(sharedOnePlaneWrapper);

      shaderSet.destroy();
      expect(reacquiredOnePlaneProgram.destroy).toHaveBeenCalledTimes(1);
    });

    it("reuses independent inactive and active eclipse variants", function () {
      const tile = createSurfaceTile();
      const options = createOptions(tile);

      options.enableEclipseGlobeShadow = false;
      const inactiveProgram = shaderSet.getShaderProgram(options);

      options.enableEclipseGlobeShadow = true;
      const activeProgram = shaderSet.getShaderProgram(options);

      options.enableEclipseGlobeShadow = false;
      expect(shaderSet.getShaderProgram(options)).toBe(inactiveProgram);

      options.enableEclipseGlobeShadow = true;
      expect(shaderSet.getShaderProgram(options)).toBe(activeProgram);

      expect(ShaderProgram.fromCache).toHaveBeenCalledTimes(2);
      expect(inactiveProgram.destroy).not.toHaveBeenCalled();
      expect(activeProgram.destroy).not.toHaveBeenCalled();
      expect(lifecycle).toEqual(["acquire program 1", "acquire program 2"]);

      shaderSet.destroy();
      expect(inactiveProgram.destroy).toHaveBeenCalledTimes(1);
      expect(activeProgram.destroy).toHaveBeenCalledTimes(1);
    });

    it("requires a material-compatible opposite-fog occupant before treating it as ready", function () {
      const preparations = installFogCompanionScheduler();
      const fogTile = createSurfaceTile();
      const fogOptions = createOptions(fogTile);
      fogOptions.enableFog = true;

      const materialA = {};
      shaderSet.material = materialA;
      const materialAFogProgram = shaderSet.getShaderProgram(fogOptions);
      materialAFogProgram._linkState = "ready";

      const materialB = {};
      shaderSet.material = materialB;
      const visibleTile = createSurfaceTile();
      const visibleOptions = createOptions(visibleTile);
      enableFogCompanion(visibleOptions);
      shaderSet.getShaderProgram(visibleOptions);

      expect(
        frameState.context.shaderCache.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(1);
      expect(preparations.length).toBe(1);
      expect(visibleTile.surfaceShader.fogCompanionRequestMask).toBe(1 << 4);

      shaderSet.destroy();
    });

    it("requires a clipping-plane-compatible opposite-fog occupant before treating it as ready", function () {
      const preparations = installFogCompanionScheduler();
      const clippingPlanes = {
        length: 1,
        clippingPlanesState: -1,
        unionClippingRegions: false,
        texture: undefined,
      };
      const fogTile = createSurfaceTile();
      const fogOptions = createOptions(fogTile);
      fogOptions.enableFog = true;
      fogOptions.enableClippingPlanes = true;
      fogOptions.clippingPlanes = clippingPlanes;
      const oldClippingProgram = shaderSet.getShaderProgram(fogOptions);
      oldClippingProgram._linkState = "ready";

      clippingPlanes.clippingPlanesState = -2;
      const visibleTile = createSurfaceTile();
      const visibleOptions = createOptions(visibleTile);
      enableFogCompanion(visibleOptions);
      visibleOptions.enableClippingPlanes = true;
      visibleOptions.clippingPlanes = clippingPlanes;
      shaderSet.getShaderProgram(visibleOptions);

      expect(
        frameState.context.shaderCache.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(1);
      expect(preparations.length).toBe(1);

      shaderSet.destroy();
    });

    it("requires a clipping-polygon-compatible opposite-fog occupant before treating it as ready", function () {
      const preparations = installFogCompanionScheduler();
      const clippingPolygons = {
        length: 1,
        clippingPolygonsState: 1,
        inverse: false,
        extentsCount: 1,
      };
      const fogTile = createSurfaceTile();
      const fogOptions = createOptions(fogTile);
      fogOptions.enableFog = true;
      fogOptions.enableClippingPolygons = true;
      fogOptions.clippingPolygons = clippingPolygons;
      const oldClippingProgram = shaderSet.getShaderProgram(fogOptions);
      oldClippingProgram._linkState = "ready";

      clippingPolygons.clippingPolygonsState = 2;
      const visibleTile = createSurfaceTile();
      const visibleOptions = createOptions(visibleTile);
      enableFogCompanion(visibleOptions);
      visibleOptions.enableClippingPolygons = true;
      visibleOptions.clippingPolygons = clippingPolygons;
      shaderSet.getShaderProgram(visibleOptions);

      expect(
        frameState.context.shaderCache.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(1);
      expect(preparations.length).toBe(1);

      shaderSet.destroy();
    });

    it("retries stale and canceled fog preparation without duplicate queueing", function () {
      const preparations = installFogCompanionScheduler();
      const tile = createSurfaceTile();
      const options = createOptions(tile);
      enableFogCompanion(options);

      shaderSet.material = {};
      shaderSet.getShaderProgram(options);
      shaderSet.getShaderProgram(options);
      expect(
        frameState.context.shaderCache.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(1);
      expect(preparations.length).toBe(1);
      expect(tile.surfaceShader.fogCompanionRequestMask).toBe(1 << 4);

      frameState.mode = SceneMode.SCENE2D;
      expect(preparations[0]()).toBeUndefined();
      expect(tile.surfaceShader.fogCompanionRequestMask).toBe(0);

      frameState.mode = SceneMode.SCENE3D;
      shaderSet.getShaderProgram(options);
      shaderSet.getShaderProgram(options);
      expect(
        frameState.context.shaderCache.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(2);
      expect(preparations.length).toBe(2);
      expect(tile.surfaceShader.fogCompanionRequestMask).toBe(1 << 4);

      shaderSet._pendingFogCompanions.clear();
      expect(preparations[1]()).toBeUndefined();
      expect(tile.surfaceShader.fogCompanionRequestMask).toBe(0);
      shaderSet.getShaderProgram(options);
      shaderSet.getShaderProgram(options);
      expect(
        frameState.context.shaderCache.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(3);
      expect(preparations.length).toBe(3);

      expect(preparations[2]()).toBeDefined();
      expect(tile.surfaceShader.fogCompanionRequestMask).toBe(1 << 4);
      shaderSet.getShaderProgram(options);
      expect(
        frameState.context.shaderCache.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(3);

      shaderSet.destroy();
    });

    it("throttles queue-cap rejection and retries after a bounded frame cooldown", function () {
      let acceptPreparation = false;
      const preparations = installFogCompanionScheduler(function () {
        return acceptPreparation;
      });
      const tile = createSurfaceTile();
      const options = createOptions(tile);
      enableFogCompanion(options);
      frameState.frameNumber = 100;

      shaderSet.getShaderProgram(options);
      expect(
        frameState.context.shaderCache.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(1);
      expect(tile.surfaceShader.fogCompanionRequestMask).toBe(0);
      expect(tile.surfaceShader.fogCompanionRejectedMask).toBe(1 << 4);

      shaderSet.getShaderProgram(options);
      frameState.frameNumber = 129;
      shaderSet.getShaderProgram(options);
      expect(
        frameState.context.shaderCache.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(1);
      expect(preparations.length).toBe(0);

      acceptPreparation = true;
      frameState.frameNumber = 130;
      shaderSet.getShaderProgram(options);
      expect(
        frameState.context.shaderCache.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(2);
      expect(preparations.length).toBe(1);
      expect(tile.surfaceShader.fogCompanionRejectedMask).toBe(0);
      expect(tile.surfaceShader.fogCompanionRequestMask).toBe(1 << 4);

      shaderSet.destroy();
    });

    it("lets a current material schedule while a stale material request is pending", function () {
      const preparations = installFogCompanionScheduler();
      const tile = createSurfaceTile();
      const options = createOptions(tile);
      enableFogCompanion(options);

      shaderSet.material = {};
      shaderSet.getShaderProgram(options);
      const materialAWrapper = tile.surfaceShader;
      expect(
        frameState.context.shaderCache.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(1);

      shaderSet.material = {};
      shaderSet.getShaderProgram(options);
      const materialBWrapper = tile.surfaceShader;
      expect(materialBWrapper).not.toBe(materialAWrapper);
      expect(
        frameState.context.shaderCache.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(2);
      expect(preparations.length).toBe(2);

      expect(preparations[0]()).toBeUndefined();
      expect(materialAWrapper.fogCompanionRequestMask).toBe(0);
      expect(materialBWrapper.fogCompanionRequestMask).toBe(1 << 4);

      shaderSet.getShaderProgram(options);
      expect(
        frameState.context.shaderCache.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(2);

      shaderSet.destroy();
    });

    it("allows the same wrapper to transition from base-color exclusion to preparation", function () {
      const preparations = installFogCompanionScheduler();
      const tile = createSurfaceTile();
      const options = createOptions(tile);
      options.baseColorCorrect = true;
      options.fogCompanionEnabled = true;

      shaderSet.getShaderProgram(options);
      const surfaceShader = tile.surfaceShader;
      expect(surfaceShader.fogCompanionRequestMask).toBe(1);
      expect(
        frameState.context.shaderCache.scheduleShaderProgramPreparation,
      ).not.toHaveBeenCalled();

      options.baseColorCorrect = false;
      shaderSet.getShaderProgram(options);
      expect(tile.surfaceShader).toBe(surfaceShader);
      expect(
        frameState.context.shaderCache.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(1);
      expect(preparations.length).toBe(1);
      expect(surfaceShader.fogCompanionRequestMask).toBe(1 | (1 << 4));

      shaderSet.destroy();
    });

    it("uses one preparation owner per context bucket and cancels it on destroy", function () {
      installFogCompanionScheduler();
      const tile = createSurfaceTile();
      const options = createOptions(tile);
      enableFogCompanion(options);
      const shaderCache = frameState.context.shaderCache;

      frameState.highDynamicRange = false;
      shaderSet.getShaderProgram(options);
      frameState.highDynamicRange = true;
      shaderSet.getShaderProgram(options);

      expect(
        shaderCache.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(2);
      const owner =
        shaderCache.scheduleShaderProgramPreparation.calls.argsFor(0)[1];
      expect(owner).toBeDefined();
      expect(
        shaderCache.scheduleShaderProgramPreparation.calls.argsFor(1)[1],
      ).toBe(owner);

      shaderSet.destroy();
      expect(
        shaderCache.cancelShaderProgramPreparations,
      ).toHaveBeenCalledOnceWith(owner);
    });

    it("rejects a context-switched callback before cross-cache derivative creation", function () {
      const contextA = frameState.context;
      const preparationsA = installFogCompanionScheduler(undefined, contextA);
      const shaderCacheA = contextA.shaderCache;
      shaderCacheA.getDerivedShaderProgram = jasmine.createSpy(
        "getDerivedShaderProgram A",
      );
      frameState.useLogDepth = true;

      const createLogDepthCommand = spyOn(
        DerivedCommand,
        "createLogDepthCommand",
      );
      const tile = createSurfaceTile();
      const options = createOptions(tile);
      enableFogCompanion(options);

      shaderSet.getShaderProgram(options);
      const surfaceShader = tile.surfaceShader;
      expect(
        shaderCacheA.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(1);
      expect(surfaceShader.fogCompanionRequestMask).toBe(1 << 5);

      const contextB = {
        ...contextA,
      };
      const preparationsB = installFogCompanionScheduler(undefined, contextB);
      const shaderCacheB = contextB.shaderCache;
      shaderCacheB.getDerivedShaderProgram = jasmine.createSpy(
        "getDerivedShaderProgram B",
      );
      frameState.context = contextB;

      shaderSet.getShaderProgram(options);
      expect(
        shaderCacheB.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(1);
      expect(preparationsB.length).toBe(1);

      expect(preparationsA[0]()).toBeUndefined();
      expect(createLogDepthCommand).not.toHaveBeenCalled();
      expect(shaderCacheA.getDerivedShaderProgram).not.toHaveBeenCalled();
      expect(shaderCacheB.getDerivedShaderProgram).not.toHaveBeenCalled();
      expect(ShaderProgram.fromCache).toHaveBeenCalledTimes(2);
      expect(surfaceShader.fogCompanionRequestMask).toBe(0);
      expect(tile.surfaceShader.fogCompanionRequestMask).toBe(1 << 5);

      shaderSet.getShaderProgram(options);
      expect(
        shaderCacheB.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(1);

      shaderSet.destroy();
    });

    it("marks stable fog exclusions in an allocation-free request mask", function () {
      installFogCompanionScheduler();
      const baseCorrectTile = createSurfaceTile();
      const baseCorrectOptions = createOptions(baseCorrectTile);
      baseCorrectOptions.baseColorCorrect = true;
      baseCorrectOptions.fogCompanionEnabled = true;
      shaderSet.getShaderProgram(baseCorrectOptions);
      expect(baseCorrectTile.surfaceShader.fogCompanionRequestMask).toBe(1);

      const translucentTile = createSurfaceTile();
      const translucentOptions = createOptions(translucentTile);
      enableFogCompanion(translucentOptions);
      translucentOptions.translucent = true;
      shaderSet.getShaderProgram(translucentOptions);
      expect(translucentTile.surfaceShader.fogCompanionRequestMask).toBe(
        1 << 4,
      );

      const parallelShaderCompile = frameState.context._parallelShaderCompile;
      frameState.context._parallelShaderCompile = undefined;
      const noExtensionTile = createSurfaceTile();
      const noExtensionOptions = createOptions(noExtensionTile);
      enableFogCompanion(noExtensionOptions);
      noExtensionOptions.applyBrightness = true;
      shaderSet.getShaderProgram(noExtensionOptions);
      expect(noExtensionTile.surfaceShader.fogCompanionRequestMask).toBe(
        1 << 4,
      );
      frameState.context._parallelShaderCompile = parallelShaderCompile;

      const imageryTile = createSurfaceTile();
      const imageryOptions = createOptions(imageryTile);
      enableFogCompanion(imageryOptions);
      imageryOptions.numberOfDayTextures = 2;
      shaderSet.getShaderProgram(imageryOptions);
      expect(imageryTile.surfaceShader.fogCompanionRequestMask).toBe(1 << 4);

      shaderSet.getShaderProgram(baseCorrectOptions);
      shaderSet.getShaderProgram(translucentOptions);
      shaderSet.getShaderProgram(noExtensionOptions);
      shaderSet.getShaderProgram(imageryOptions);
      expect(
        frameState.context.shaderCache.scheduleShaderProgramPreparation,
      ).not.toHaveBeenCalled();

      shaderSet.destroy();
    });

    it("prepares one opposite-fog final executable outside the command path", function () {
      const preparations = [];
      frameState.context._parallelShaderCompile = {};
      frameState.context.shaderCache = {
        scheduleShaderProgramPreparation: jasmine
          .createSpy("scheduleShaderProgramPreparation")
          .and.callFake(function (prepare) {
            preparations.push(prepare);
            return true;
          }),
      };
      frameState.useLogDepth = true;
      frameState.highDynamicRange = false;
      frameState.shadowState = {
        lightShadowsEnabled: false,
      };

      const finalProgram = createProgram("final fog companion");
      spyOn(DerivedCommand, "createLogDepthCommand").and.returnValue({
        command: {
          shaderProgram: finalProgram,
        },
      });

      const tileA = createSurfaceTile();
      const tileB = createSurfaceTile();
      const optionsA = createOptions(tileA);
      const optionsB = createOptions(tileB);
      optionsA.enableFog = false;
      optionsA.baseColorCorrect = false;
      optionsA.fogCompanionEnabled = true;
      optionsB.enableFog = false;
      optionsB.baseColorCorrect = false;
      optionsB.fogCompanionEnabled = true;

      const visibleProgram = shaderSet.getShaderProgram(optionsA);
      expect(shaderSet.getShaderProgram(optionsB)).toBe(visibleProgram);
      expect(
        frameState.context.shaderCache.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(1);
      expect(preparations.length).toBe(1);
      expect(ShaderProgram.fromCache).toHaveBeenCalledTimes(1);
      expect(tileA.surfaceShader.fogCompanionRequestMask).toBe(1 << 5);

      expect(preparations[0]()).toBe(finalProgram);
      expect(tileA.surfaceShader.fogCompanionRequestMask).toBe(1 << 5);

      expect(ShaderProgram.fromCache).toHaveBeenCalledTimes(2);
      const companionOptions = ShaderProgram.fromCache.calls.argsFor(1)[0];
      expect(companionOptions.fragmentShaderSource.defines).toContain("FOG");
      expect(DerivedCommand.createLogDepthCommand).toHaveBeenCalledTimes(1);
      expect(tileA.surfaceShader.shaderProgram).toBe(visibleProgram);

      shaderSet.destroy();
      expect(visibleProgram.destroy).toHaveBeenCalledTimes(1);
      expect(createdPrograms[1].destroy).toHaveBeenCalledTimes(1);
    });

    it("uses an inclusive bounded altitude window for ground-atmosphere preparation", function () {
      const threshold = 1000.0;
      expect(
        isGroundAtmosphereCompanionDistance(0.75 * threshold, threshold),
      ).toBeTrue();
      expect(
        isGroundAtmosphereCompanionDistance(1.25 * threshold, threshold),
      ).toBeTrue();
      expect(
        isGroundAtmosphereCompanionDistance(0.749999 * threshold, threshold),
      ).toBeFalse();
      expect(
        isGroundAtmosphereCompanionDistance(1.250001 * threshold, threshold),
      ).toBeFalse();
      expect(isGroundAtmosphereCompanionDistance(threshold, 0.0)).toBeFalse();
      expect(
        isGroundAtmosphereCompanionDistance(
          Number.POSITIVE_INFINITY,
          threshold,
        ),
      ).toBeFalse();
    });

    it("prepares one exact ground-atmosphere final executable and flips only its altitude regime", function () {
      const preparations = installFogCompanionScheduler();
      frameState.useLogDepth = true;
      frameState.highDynamicRange = true;

      const logDepthProgram = createProgram(
        "ground atmosphere log-depth companion",
      );
      const finalProgram = createProgram("ground atmosphere HDR companion");
      spyOn(DerivedCommand, "createLogDepthCommand").and.returnValue({
        command: {
          shaderProgram: logDepthProgram,
        },
      });
      spyOn(DerivedCommand, "createHdrCommand").and.returnValue({
        command: {
          shaderProgram: finalProgram,
        },
      });

      const tile = createSurfaceTile();
      const attributeLocations = {
        position: 0,
      };
      tile.renderedMesh.encoding.quantization = TerrainQuantization.BITS12;
      tile.renderedMesh.encoding.getAttributeLocations = function () {
        return attributeLocations;
      };

      const options = createOptions(tile);
      enableGroundAtmosphereCompanion(options);
      options.numberOfDayTextures = 1;
      options.enableFog = true;
      options.fogCompanionEnabled = true;
      options.hasWaterMask = true;
      options.showReflectiveOcean = true;
      options.showOceanWaves = true;
      options.enableLighting = true;
      options.dynamicAtmosphereLighting = true;
      options.dynamicAtmosphereLightingFromSun = true;
      options.clippedByBoundaries = true;
      options.hasImageryLayerCutout = true;
      options.hasGeodeticSurfaceNormals = true;
      options.hasExaggeration = true;
      options.enableEclipseGlobeShadow = true;

      const visibleProgram = shaderSet.getShaderProgram(options);
      expect(
        frameState.context.shaderCache.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(1);
      expect(preparations.length).toBe(1);
      expect(tile.surfaceShader.fogCompanionRequestMask).toBe(0);
      expect(tile.surfaceShader.groundAtmosphereCompanionRequestMask).toBe(
        1 << 3,
      );

      expect(preparations[0]()).toBe(finalProgram);
      expect(
        frameState.context.shaderCache.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(1);
      expect(ShaderProgram.fromCache).toHaveBeenCalledTimes(2);

      const visibleShaderOptions = ShaderProgram.fromCache.calls.argsFor(0)[0];
      const companionShaderOptions =
        ShaderProgram.fromCache.calls.argsFor(1)[0];
      const normalizeDefines = function (defines) {
        return defines.filter((define) => define.length > 0).sort();
      };
      const visibleVertexDefines = normalizeDefines(
        visibleShaderOptions.vertexShaderSource.defines,
      );
      const companionVertexDefines = normalizeDefines(
        companionShaderOptions.vertexShaderSource.defines,
      );
      const visibleFragmentDefines = normalizeDefines(
        visibleShaderOptions.fragmentShaderSource.defines,
      );
      const companionFragmentDefines = normalizeDefines(
        companionShaderOptions.fragmentShaderSource.defines,
      );

      expect(visibleVertexDefines).not.toContain(
        "PER_FRAGMENT_GROUND_ATMOSPHERE",
      );
      expect(visibleFragmentDefines).not.toContain(
        "PER_FRAGMENT_GROUND_ATMOSPHERE",
      );
      expect(companionVertexDefines).toEqual(
        normalizeDefines([
          ...visibleVertexDefines,
          "PER_FRAGMENT_GROUND_ATMOSPHERE",
        ]),
      );
      expect(companionFragmentDefines).toEqual(
        normalizeDefines([
          ...visibleFragmentDefines,
          "PER_FRAGMENT_GROUND_ATMOSPHERE",
        ]),
      );
      expect(companionVertexDefines).toContain("QUANTIZATION_BITS12");
      expect(companionFragmentDefines).toContain("TEXTURE_UNITS 1");
      expect(companionFragmentDefines).toContain("FOG");
      expect(companionFragmentDefines).toContain("HAS_WATER_MASK");
      expect(companionShaderOptions.attributeLocations).toBe(
        attributeLocations,
      );
      expect(DerivedCommand.createLogDepthCommand).toHaveBeenCalledTimes(1);
      expect(DerivedCommand.createHdrCommand).toHaveBeenCalledTimes(1);
      expect(tile.surfaceShader.shaderProgram).toBe(visibleProgram);

      shaderSet.destroy();
      expect(visibleProgram.destroy).toHaveBeenCalledTimes(1);
      expect(createdPrograms[1].destroy).toHaveBeenCalledTimes(1);
    });

    it("guards ground-atmosphere preparation from unsupported or expansive variants", function () {
      installFogCompanionScheduler();

      const renderGuardedVariant = function (configure) {
        const tile = createSurfaceTile();
        const options = createOptions(tile);
        enableGroundAtmosphereCompanion(options);
        configure(options);
        shaderSet.getShaderProgram(options);
      };

      renderGuardedVariant(function (options) {
        options.baseColorCorrect = true;
      });
      renderGuardedVariant(function (options) {
        options.colorCorrect = true;
      });
      renderGuardedVariant(function (options) {
        options.translucent = true;
      });
      renderGuardedVariant(function (options) {
        options.numberOfDayTextures = 2;
      });
      renderGuardedVariant(function (options) {
        options.showGroundAtmosphere = false;
      });

      frameState.context.isWebGPU = true;
      renderGuardedVariant(function (options) {
        options.applySplit = true;
      });
      frameState.context.isWebGPU = false;

      const parallelShaderCompile = frameState.context._parallelShaderCompile;
      frameState.context._parallelShaderCompile = undefined;
      renderGuardedVariant(function (options) {
        options.applyAlpha = true;
      });
      frameState.context._parallelShaderCompile = parallelShaderCompile;

      frameState.shadowState.lightShadowsEnabled = true;
      renderGuardedVariant(function (options) {
        options.applyDayNightAlpha = true;
      });
      frameState.shadowState.lightShadowsEnabled = false;

      frameState.mode = SceneMode.SCENE2D;
      renderGuardedVariant(function (options) {
        options.hasWaterMask = true;
      });
      frameState.mode = SceneMode.SCENE3D;

      expect(
        frameState.context.shaderCache.scheduleShaderProgramPreparation,
      ).not.toHaveBeenCalled();

      shaderSet.destroy();
    });

    it("selects one exact ground-atmosphere cohort per band crossing without fog fan-out", function () {
      const preparations = installFogCompanionScheduler();
      const tileA = createSurfaceTile();
      const optionsA = createOptions(tileA);
      enableGroundAtmosphereCompanion(optionsA);
      optionsA.enableFog = false;
      optionsA.fogCompanionEnabled = true;

      const tileB = createSurfaceTile();
      const optionsB = createOptions(tileB);
      enableGroundAtmosphereCompanion(optionsB);
      optionsB.numberOfDayTextures = 1;
      optionsB.enableFog = true;
      optionsB.fogCompanionEnabled = true;

      shaderSet.getShaderProgram(optionsA);
      shaderSet.getShaderProgram(optionsB);
      expect(
        frameState.context.shaderCache.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(1);
      expect(preparations.length).toBe(1);
      expect(tileA.surfaceShader.fogCompanionRequestMask).toBe(0);
      expect(tileB.surfaceShader.fogCompanionRequestMask).toBe(0);

      expect(preparations[0]()).toBeDefined();
      shaderSet.getShaderProgram(optionsB);
      expect(
        frameState.context.shaderCache.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(1);

      optionsA.groundAtmosphereCompanionEnabled = false;
      optionsA.fogCompanionEnabled = false;
      shaderSet.getShaderProgram(optionsA);

      shaderSet.getShaderProgram(optionsB);
      expect(
        frameState.context.shaderCache.scheduleShaderProgramPreparation,
      ).toHaveBeenCalledTimes(2);
      expect(preparations.length).toBe(2);
      expect(preparations[1]()).toBeDefined();

      shaderSet.destroy();
    });

    it("rejects a stale ground-atmosphere material generation before compiling", function () {
      const preparations = installFogCompanionScheduler();
      const tile = createSurfaceTile();
      const options = createOptions(tile);
      enableGroundAtmosphereCompanion(options);

      const material = {};
      shaderSet.material = material;
      shaderSet.getShaderProgram(options);
      const sourceProgram = tile.surfaceShader.shaderProgram;
      expect(preparations.length).toBe(1);
      expect(ShaderProgram.fromCache).toHaveBeenCalledTimes(1);

      shaderSet.material = {};
      shaderSet.material = material;
      expect(preparations[0]()).toBeUndefined();
      expect(ShaderProgram.fromCache).toHaveBeenCalledTimes(1);
      expect(tile.surfaceShader.groundAtmosphereCompanionRequestMask).toBe(0);

      shaderSet.getShaderProgram(options);
      expect(tile.surfaceShader.shaderProgram).toBe(sourceProgram);
      expect(preparations.length).toBe(2);
      expect(preparations[1]()).toBeDefined();

      shaderSet.destroy();
    });

    it("rejects a stale ground-atmosphere context before derivative creation", function () {
      const contextA = frameState.context;
      const preparationsA = installFogCompanionScheduler(undefined, contextA);
      const shaderCacheA = contextA.shaderCache;
      shaderCacheA.getDerivedShaderProgram = jasmine.createSpy(
        "getDerivedShaderProgram A",
      );
      frameState.useLogDepth = true;

      const createLogDepthCommand = spyOn(
        DerivedCommand,
        "createLogDepthCommand",
      );
      const tile = createSurfaceTile();
      const options = createOptions(tile);
      enableGroundAtmosphereCompanion(options);

      shaderSet.getShaderProgram(options);
      const contextASurfaceShader = tile.surfaceShader;
      expect(preparationsA.length).toBe(1);

      const contextB = {
        ...contextA,
      };
      const preparationsB = installFogCompanionScheduler(undefined, contextB);
      const shaderCacheB = contextB.shaderCache;
      shaderCacheB.getDerivedShaderProgram = jasmine.createSpy(
        "getDerivedShaderProgram B",
      );
      frameState.context = contextB;
      shaderSet.getShaderProgram(options);

      expect(preparationsA[0]()).toBeUndefined();
      expect(createLogDepthCommand).not.toHaveBeenCalled();
      expect(shaderCacheA.getDerivedShaderProgram).not.toHaveBeenCalled();
      expect(shaderCacheB.getDerivedShaderProgram).not.toHaveBeenCalled();
      expect(contextASurfaceShader.groundAtmosphereCompanionRequestMask).toBe(
        0,
      );
      expect(preparationsB.length).toBe(1);

      shaderSet.destroy();
    });
  },
  "WebGL",
);
