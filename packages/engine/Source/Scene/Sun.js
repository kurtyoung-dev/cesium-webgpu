import BoundingSphere from "../Core/BoundingSphere.js";
import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartesian4 from "../Core/Cartesian4.js";
import ComponentDatatype from "../Core/ComponentDatatype.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import IndexDatatype from "../Core/IndexDatatype.js";
import CesiumMath from "../Core/Math.js";
import Matrix4 from "../Core/Matrix4.js";
import PixelFormat from "../Core/PixelFormat.js";
import PrimitiveType from "../Core/PrimitiveType.js";
import Buffer from "../Renderer/Buffer.js";
import BufferUsage from "../Renderer/BufferUsage.js";
import ComputeCommand from "../Renderer/ComputeCommand.js";
import DrawCommand from "../Renderer/DrawCommand.js";
import Ellipsoid from "../Core/Ellipsoid.js";
import {
  computeAtmosphereExtinctionCached,
  createAtmosphereExtinctionCache,
} from "./computeAtmosphereExtinction.js";
import { getEclipseSunFactor } from "./EclipseState.js";
import {
  createSunDiscAppearance,
  readSunDiscAppearance,
} from "./SunDiscAppearance.js";
import PixelDatatype from "../Renderer/PixelDatatype.js";
import RenderState from "../Renderer/RenderState.js";
import ShaderProgram from "../Renderer/ShaderProgram.js";
import Texture from "../Renderer/Texture.js";
import VertexArray from "../Renderer/VertexArray.js";
import FeatureRendererKey from "../Renderer/FeatureRendererKey.js";
import SunFS from "../Shaders/SunFS.js";
import SunTextureFS from "../Shaders/SunTextureFS.js";
import SunVS from "../Shaders/SunVS.js";
import BlendingState from "./BlendingState.js";
import SceneMode from "./SceneMode.js";
import SceneTransforms from "./SceneTransforms.js";

/**
 * Draws a sun billboard.
 * <p>This is only supported in 3D and Columbus view.</p>
 *
 * @alias Sun
 *
 *
 * @example
 * scene.sun = new Cesium.Sun();
 *
 * @see Scene#sun
 */
class Sun {
  constructor() {
    /**
     * Determines if the sun will be shown.
     *
     * @type {boolean}
     * @default true
     */
    this.show = true;

    this._drawCommand = new DrawCommand({
      primitiveType: PrimitiveType.TRIANGLES,
      boundingVolume: new BoundingSphere(),
      owner: this,
    });
    this._commands = {
      drawCommand: this._drawCommand,
      computeCommand: undefined,
    };
    this._boundingVolume = new BoundingSphere();
    this._boundingVolume2D = new BoundingSphere();

    this._texture = undefined;
    this._drawingBufferWidth = undefined;
    this._drawingBufferHeight = undefined;
    this._radiusTS = undefined;
    this._size = undefined;

    this._glowFactor = 1.0;
    this._glowFactorDirty = false;

    this._useHdr = undefined;

    // C7-SUN-STARS-EXTINCTION — per-frame RGB atmospheric transmittance
    // along the camera→sun ray. Cartesian3.ONE (the default) leaves the
    // sun byte-identical (color * 1.0), so the effect is inert until the
    // sky atmosphere is visible and the sun sits low over the horizon.
    this._atmosphereExtinction = Cartesian3.clone(Cartesian3.ONE);
    this._atmosphereExtinctionCache = createAtmosphereExtinctionCache();

    // C12-29 S1 — continuous occlusion fade. 1.0 (the multiplicative
    // identity) whenever nothing occults the sun or the effect is off, so
    // the shader multiply is byte-identical in those frames.
    this._eclipseAlpha = 1.0;

    // C12-15 / C12-16 — resolved sun-bake appearance, published to
    // frameState before the backend branch so the GLSL bake (uniforms below)
    // and the WebGPU CPU bake consume one identical resolution. `_bakedKey`
    // is the 2-bit toggle signature the texture was last baked with; a
    // mismatch forces a rebuild exactly like `_glowFactorDirty` does.
    this._discAppearance = createSunDiscAppearance();
    this._bakedAppearanceKey = undefined;
    this._limbDarkening = new Cartesian3(1.0, 0.0, 0.0);
    this._glareProfile = new Cartesian4(0.0, 0.0, 0.0, 1.0);

    const that = this;
    this._uniformMap = {
      u_texture: function () {
        return that._texture;
      },
      u_size: function () {
        return that._size;
      },
      u_atmosphereExtinction: function () {
        return that._atmosphereExtinction;
      },
      u_eclipseAlpha: function () {
        return that._eclipseAlpha;
      },
    };
  }

  /**
   * Gets or sets a number that controls how "bright" the Sun's lens flare appears
   * to be.  Zero shows just the Sun's disc without any flare.
   * Use larger values for a more pronounced flare around the Sun.
   *
   * @type {number}
   * @default 1.0
   */
  get glowFactor() {
    return this._glowFactor;
  }

  set glowFactor(glowFactor) {
    glowFactor = Math.max(glowFactor, 0.0);
    this._glowFactor = glowFactor;
    this._glowFactorDirty = true;
  }

  /**
   * @private
   */
  update(frameState, passState, useHdr) {
    if (!this.show) {
      return undefined;
    }

    const mode = frameState.mode;
    if (mode === SceneMode.SCENE2D || mode === SceneMode.MORPHING) {
      return undefined;
    }

    if (!frameState.passes.render) {
      return undefined;
    }

    // C7-SUN-STARS-EXTINCTION — attenuate + redden the sun by the
    // atmospheric optical path along the camera→sun ray, mirroring the Moon
    // (B629). Gated on the sky atmosphere actually being rendered so the sun
    // is byte-identical when the atmosphere is hidden. Published to
    // frameState for the WebGPU sun renderer and stored on the primitive for
    // the WebGL uniform below. Computed here (before the backend branch) so
    // both paths read the same transmittance.
    //
    // C12-29 S4 CORRECTION (2026-07-25). This block used to claim "the
    // physics yields exactly Cartesian3.ONE from orbit (the ray never
    // crosses the shell), so the from-orbit case is byte-identical too".
    // That is FALSE in exactly the geometry S4 exists for. From a 400 km
    // vantage the 111 km shell subtends 73.1° from nadir and the solid
    // Earth 70.2°, so a 2.9°-wide annulus of directions produces
    // limb-GRAZING rays that traverse the entire atmosphere — the band the
    // sun crosses during an orbital sunset. Measured over that band
    // (`Tools/visual-regression/sun-orbital-limb-extinction.spec.mjs`): the
    // transmittance is EXACTLY (1,1,1) for tangent heights above 111 km,
    // then ramps monotonically to blue 8.3e-12 / red 1.7e-5 at a grazing
    // altitude of 0 km, with the red/blue ratio climbing 1.0 → 2.0e6. The
    // orbital-sunset reddening ramp S4 was scoped to build ALREADY EXISTS
    // here; what kept it invisible was the legacy binary cull (replaced by
    // S1's continuous fade) — see the S4 verdict in the debugging log.
    //
    // KNOWN LIMIT (deferred polish, recorded on the C12-29 S4 row): the
    // integral is evaluated on the camera→sun-CENTRE ray only, so the whole
    // billboard receives ONE uniform tint. A real setting sun is graded
    // ACROSS its disc. At this vantage the sun's 0.5327° angular diameter
    // maps to a 21.33 km span in tangent height, and the upper-limb /
    // lower-limb transmittance ratio measured with THIS integrator is
    // strongly altitude- and channel-dependent:
    //
    //   tangent h | ratio red | ratio green | ratio blue
    //   ----------+-----------+-------------+-----------
    //      60 km  |    1.02   |     1.05    |    1.12
    //      40 km  |    1.18   |     1.47    |    2.33
    //      25 km  |    2.27   |     6.16    |   4.8e1
    //      20 km  |    5.03   |     2.6e1   |   7.7e2
    //      15 km  |    5.1e1  |     7.7e2   |   2.0e5
    //      10 km  |    1.7e5  |     1.4e7   |   1.2e11
    //       0 km  |    2.6e9  |     9.7e11  |   1.9e17
    //
    // An earlier revision of this comment quoted "~5.6x in blue" as if it
    // were the figure; it is only reached in a narrow ~31.75–34.25 km band
    // and UNDERSTATES the deferred limit by many orders of magnitude across
    // the 0–15 km band, which is exactly where an orbital sunset is
    // visually interesting. Differential extinction across the disc and
    // refraction lift/flattening are deliberately not implemented.
    const uniformState = frameState.context.uniformState;
    const sunPositionWC = uniformState.sunPositionWC;
    const camPos = defined(frameState.camera)
      ? frameState.camera.positionWC
      : undefined;
    const extinctionEnabled =
      frameState.skyAtmosphereVisible === true &&
      defined(frameState.atmosphere) &&
      defined(camPos) &&
      defined(sunPositionWC);
    const extinction = computeAtmosphereExtinctionCached(
      this._atmosphereExtinctionCache,
      scratchExtinction,
      extinctionEnabled,
      camPos,
      sunPositionWC,
      frameState.atmosphere,
      Ellipsoid.default.maximumRadius,
    );
    frameState.sunAtmosphereExtinction = Cartesian3.clone(
      extinction,
      frameState.sunAtmosphereExtinction,
    );
    // WebGL uniform source. ONE when the atmosphere is hidden / from orbit,
    // making the shader multiply a no-op (byte-identical).
    this._atmosphereExtinction = Cartesian3.clone(
      extinction,
      this._atmosphereExtinction,
    );

    // C12-29 S1 — CONTINUOUS OCCLUSION FADE (the pop killer).
    //
    // Premise: `Scene.updateEnvironment` still runs the legacy binary cull
    // (`environmentState.isSunVisible = isVisible(..., occluder)`), and it
    // is deliberately left alone. That test culls only when the sun's
    // ~6-solar-radii glow bounding sphere lies ENTIRELY inside the Earth
    // occluder's horizon cone, which strictly implies the far smaller solar
    // DISC is fully occluded too — i.e. the cull can only fire in frames
    // where `sunVisibleFraction` is already exactly 0. So the cull boundary
    // now sits well inside the alpha-zero region instead of being the
    // moment the sun snapped to full brightness, and the visible transition
    // is the fade below. Keeping the cull also keeps the disabled position
    // trivially byte-identical and preserves the culling perf.
    //
    // ALPHA, not RGB: WebGL blends the sun with ALPHA_BLEND (below) where
    // dimming rgb produces a black disc over the sky, while WebGPU blends
    // additively with src-alpha (`WebGPUEnvironmentRenderer.js`). An
    // alpha-only multiply fades correctly under BOTH, so the design is
    // invariant to the C11-115 blend flip.
    //
    // Published to frameState before the backend branch (the
    // C7-SUN-STARS-EXTINCTION convention) so the WebGL uniform and the
    // WebGPU uniform buffer read one identical scalar.
    const eclipseAlpha = getEclipseSunFactor(frameState.eclipseState);
    frameState.sunEclipseAlpha = eclipseAlpha;
    this._eclipseAlpha = eclipseAlpha;

    // C12-15 (limb-darkened disc) + C12-16 (inverse-square glare falloff).
    // Resolved BEFORE the backend branch and published on frameState, the
    // C7-SUN-STARS-EXTINCTION convention, so the WebGL uniform payload below
    // and the WebGPU CPU bake are provably fed the same numbers rather than
    // each reading `atmosphericConditions` independently.
    const appearance = readSunDiscAppearance(frameState, this._discAppearance);
    frameState.sunDiscAppearance = appearance;
    this._limbDarkening.x = appearance.a0;
    this._limbDarkening.y = appearance.a1;
    this._limbDarkening.z = appearance.a2;
    this._glareProfile.x = appearance.glareCore;
    this._glareProfile.y = appearance.glarePedestal;
    this._glareProfile.z = appearance.glareLegacyEdge;
    this._glareProfile.w = appearance.glareLegacy;

    // Backend-specific rendering via Feature Renderer.
    //
    // Batch 247 (NEW-GROUND-VIEW-ENV-DIVERGENCES fix 2) — the SkyAtmosphere
    // convention: the FR pushes its command onto `frameState.commandList`
    // (a BV-less command spans near→far, guaranteeing a frustum exists even
    // on sky-only views where nothing else renders) AND we return it so
    // Scene tracks it as `environmentState.sunDrawCommand`. The WebGPU
    // scene renderer's ENVIRONMENT injection dedupes commands already
    // binned from the commandList (SceneRenderer.js) — pre-fix the
    // injected skyAtmosphere DUPLICATE executed after the binned sun and
    // its alpha-over shell (alpha ≈ 1 at ground level) overwrote the disk.
    const fr = frameState.context.getFeatureRenderer(FeatureRendererKey.SUN);
    if (fr) {
      const lengthBefore = frameState.commandList.length;
      fr.update(this, frameState, frameState.commandList);
      if (frameState.commandList.length === lengthBefore + 1) {
        scratchBackendCommands.drawCommand =
          frameState.commandList[lengthBefore];
        return scratchBackendCommands;
      }
      return undefined;
    }

    const context = frameState.context;
    const drawingBufferWidth = passState.viewport.width;
    const drawingBufferHeight = passState.viewport.height;

    if (
      !defined(this._texture) ||
      drawingBufferWidth !== this._drawingBufferWidth ||
      drawingBufferHeight !== this._drawingBufferHeight ||
      this._glowFactorDirty ||
      useHdr !== this._useHdr ||
      // C12-15 / C12-16 — a toggle flip changes the baked profile, so the
      // texture must be re-baked exactly as a glowFactor change does.
      this._bakedAppearanceKey !== appearance.key
    ) {
      this._texture = this._texture && this._texture.destroy();
      this._drawingBufferWidth = drawingBufferWidth;
      this._drawingBufferHeight = drawingBufferHeight;
      this._glowFactorDirty = false;
      this._useHdr = useHdr;
      this._bakedAppearanceKey = appearance.key;

      let size = Math.max(drawingBufferWidth, drawingBufferHeight);
      size = Math.pow(2.0, Math.ceil(Math.log(size) / Math.log(2.0)) - 2.0);

      // The size computed above can be less than 1.0 if size < 4.0. This will probably
      // never happen in practice, but does in the tests. Clamp to 1.0 to prevent WebGL
      // errors in the tests.
      size = Math.max(1.0, size);

      const pixelDatatype = useHdr
        ? context.halfFloatingPointTexture
          ? PixelDatatype.HALF_FLOAT
          : PixelDatatype.FLOAT
        : PixelDatatype.UNSIGNED_BYTE;
      this._texture = new Texture({
        context: context,
        width: size,
        height: size,
        pixelFormat: PixelFormat.RGBA,
        pixelDatatype: pixelDatatype,
      });

      this._glowLengthTS = this._glowFactor * 5.0;
      this._radiusTS = (1.0 / (1.0 + 2.0 * this._glowLengthTS)) * 0.5;

      const that = this;
      const uniformMap = {
        u_radiusTS: function () {
          return that._radiusTS;
        },
        // C12-15 / C12-16 — the bake's only numeric source. `SunTextureFS`
        // holds no copy of the limb-darkening triple or the glare
        // parameters; they arrive here from `Scene/SolarDiscModel.js` via
        // `SunDiscAppearance.readSunDiscAppearance` above.
        u_limbDarkening: function () {
          return that._limbDarkening;
        },
        u_glareProfile: function () {
          return that._glareProfile;
        },
      };

      this._commands.computeCommand = new ComputeCommand({
        fragmentShaderSource: SunTextureFS,
        outputTexture: this._texture,
        uniformMap: uniformMap,
        persists: false,
        owner: this,
        postExecute: function () {
          that._commands.computeCommand = undefined;
        },
      });
    }

    const drawCommand = this._drawCommand;

    if (!defined(drawCommand.vertexArray)) {
      const attributeLocations = {
        direction: 0,
      };

      const directions = new Uint8Array(4 * 2);
      directions[0] = 0;
      directions[1] = 0;

      directions[2] = 255;
      directions[3] = 0.0;

      directions[4] = 255;
      directions[5] = 255;

      directions[6] = 0.0;
      directions[7] = 255;

      const vertexBuffer = Buffer.createVertexBuffer({
        context: context,
        typedArray: directions,
        usage: BufferUsage.STATIC_DRAW,
      });
      const attributes = [
        {
          index: attributeLocations.direction,
          vertexBuffer: vertexBuffer,
          componentsPerAttribute: 2,
          normalize: true,
          componentDatatype: ComponentDatatype.UNSIGNED_BYTE,
        },
      ];
      // Workaround Internet Explorer 11.0.8 lack of TRIANGLE_FAN
      const indexBuffer = Buffer.createIndexBuffer({
        context: context,
        typedArray: new Uint16Array([0, 1, 2, 0, 2, 3]),
        usage: BufferUsage.STATIC_DRAW,
        indexDatatype: IndexDatatype.UNSIGNED_SHORT,
      });
      drawCommand.vertexArray = new VertexArray({
        context: context,
        attributes: attributes,
        indexBuffer: indexBuffer,
      });

      drawCommand.shaderProgram = ShaderProgram.fromCache({
        context: context,
        vertexShaderSource: SunVS,
        fragmentShaderSource: SunFS,
        attributeLocations: attributeLocations,
      });

      drawCommand.renderState = RenderState.fromCache({
        blending: BlendingState.ALPHA_BLEND,
      });
      drawCommand.uniformMap = this._uniformMap;
    }

    const sunPosition = context.uniformState.sunPositionWC;
    const sunPositionCV = context.uniformState.sunPositionColumbusView;

    const boundingVolume = this._boundingVolume;
    const boundingVolume2D = this._boundingVolume2D;

    Cartesian3.clone(sunPosition, boundingVolume.center);
    boundingVolume2D.center.x = sunPositionCV.z;
    boundingVolume2D.center.y = sunPositionCV.x;
    boundingVolume2D.center.z = sunPositionCV.y;

    boundingVolume.radius =
      CesiumMath.SOLAR_RADIUS + CesiumMath.SOLAR_RADIUS * this._glowLengthTS;
    boundingVolume2D.radius = boundingVolume.radius;

    if (mode === SceneMode.SCENE3D) {
      BoundingSphere.clone(boundingVolume, drawCommand.boundingVolume);
    } else if (mode === SceneMode.COLUMBUS_VIEW) {
      BoundingSphere.clone(boundingVolume2D, drawCommand.boundingVolume);
    }

    const position = SceneTransforms.computeActualEllipsoidPosition(
      frameState,
      sunPosition,
      scratchCartesian4,
    );

    const dist = Cartesian3.magnitude(
      Cartesian3.subtract(
        position,
        frameState.camera.position,
        scratchCartesian4,
      ),
    );
    const projMatrix = context.uniformState.projection;

    const positionEC = scratchPositionEC;
    positionEC.x = 0;
    positionEC.y = 0;
    positionEC.z = -dist;
    positionEC.w = 1;

    const positionCC = Matrix4.multiplyByVector(
      projMatrix,
      positionEC,
      scratchCartesian4,
    );
    const positionWC = SceneTransforms.clipToGLWindowCoordinates(
      passState.viewport,
      positionCC,
      scratchPositionWC,
    );

    positionEC.x = CesiumMath.SOLAR_RADIUS;
    const limbCC = Matrix4.multiplyByVector(
      projMatrix,
      positionEC,
      scratchCartesian4,
    );
    const limbWC = SceneTransforms.clipToGLWindowCoordinates(
      passState.viewport,
      limbCC,
      scratchLimbWC,
    );

    this._size = Cartesian2.magnitude(
      Cartesian2.subtract(limbWC, positionWC, scratchCartesian4),
    );
    this._size = 2.0 * this._size * (1.0 + 2.0 * this._glowLengthTS);
    this._size = Math.ceil(this._size);

    return this._commands;
  }

  /**
   * Returns true if this object was destroyed; otherwise, false.
   * <br /><br />
   * If this object was destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
   *
   * @returns {boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
   *
   * @see Sun#destroy
   */
  isDestroyed() {
    return false;
  }

  /**
   * Destroys the WebGL resources held by this object.  Destroying an object allows for deterministic
   * release of WebGL resources, instead of relying on the garbage collector to destroy this object.
   * <br /><br />
   * Once an object is destroyed, it should not be used; calling any function other than
   * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.  Therefore,
   * assign the return value (<code>undefined</code>) to the object as done in the example.
   *
   * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
   *
   *
   * @example
   * sun = sun && sun.destroy();
   *
   *  @see Sun#isDestroyed
   */
  destroy() {
    const command = this._drawCommand;
    command.vertexArray = command.vertexArray && command.vertexArray.destroy();
    command.shaderProgram =
      command.shaderProgram && command.shaderProgram.destroy();

    this._texture = this._texture && this._texture.destroy();

    return destroyObject(this);
  }
}

const scratchPositionWC = new Cartesian2();
const scratchLimbWC = new Cartesian2();
const scratchPositionEC = new Cartesian4();
const scratchCartesian4 = new Cartesian4();
// C7-SUN-STARS-EXTINCTION scratch. The exact-input cache writes identity when
// the atmosphere gate is disabled and reuses this result object every frame.
const scratchExtinction = new Cartesian3();

// Batch 247 — return shape for the feature-renderer (WebGPU) path:
// mirrors the WebGL `{ drawCommand, computeCommand }` pair so Scene
// routes the FR command through `environmentState.sunDrawCommand`
// (ordered after skyAtmosphere by the ENVIRONMENT injection).
const scratchBackendCommands = {
  drawCommand: undefined,
  computeCommand: undefined,
};

export default Sun;
