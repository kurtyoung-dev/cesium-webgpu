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
import { solarDiscAtmosphereAlpha } from "./SolarDiscModel.js";
import {
  createSunDiscAppearance,
  readSunDiscAppearance,
} from "./SunDiscAppearance.js";
import {
  createSunHaloAppearance,
  readSunHaloAppearance,
} from "./SunHaloAppearance.js";
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

    // Per-frame RGB atmospheric transmittance along the camera-to-sun ray.
    // `Cartesian3.ONE` leaves the sun byte-identical (`color * 1.0`), so the
    // effect is inert until the sky atmosphere is visible and the sun sits
    // low over the horizon.
    this._atmosphereExtinction = Cartesian3.clone(Cartesian3.ONE);
    this._atmosphereExtinctionCache = createAtmosphereExtinctionCache();

    // Alpha co-fade derived from the same atmospheric transmittance. Exactly
    // 1.0 when that transmittance is the identity.
    this._atmosphereAlpha = 1.0;

    // Continuous occlusion fade. 1.0, the multiplicative identity, whenever
    // nothing occults the sun or the effect is off, so the shader multiply is
    // byte-identical in those frames.
    this._eclipseAlpha = 1.0;

    // Resolved sun-bake appearance, published to frameState before the
    // backend branch so the GLSL bake (uniforms below) and the WebGPU CPU
    // bake consume one identical resolution. `_bakedAppearanceKey` is the
    // toggle signature the texture was last baked with; a mismatch forces a
    // rebuild exactly as `_glowFactorDirty` does.
    this._discAppearance = createSunDiscAppearance();
    this._bakedAppearanceKey = undefined;
    this._limbDarkening = new Cartesian3(1.0, 0.0, 0.0);
    this._glareProfile = new Cartesian4(0.0, 0.0, 0.0, 1.0);

    // Disc size and halo-source resolution, published on frameState before
    // the backend branch by the same convention as `_discAppearance`.
    // `_haloGain` is the bake's halo weight: 1.0 keeps the halo in the bake,
    // 0.0 hands it to the post-process chain.
    this._haloAppearance = createSunHaloAppearance();
    this._haloGain = 1.0;

    // The disc's linear radiance, applied in `SunFS.glsl` after
    // `czm_gammaCorrect`. Exactly 1.0 in SDR, so the billboard is unchanged
    // bit for bit there. Not a bake input: it never touches
    // `_bakedAppearanceKey`.
    this._discRadiance = 1.0;

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
      u_atmosphereAlpha: function () {
        return that._atmosphereAlpha;
      },
      u_eclipseAlpha: function () {
        return that._eclipseAlpha;
      },
      u_discRadiance: function () {
        return that._discRadiance;
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

    // Attenuate and redden the sun by the atmospheric optical path along the
    // camera-to-sun ray, as the Moon does. Gated on the sky atmosphere
    // actually being rendered, so the sun is byte-identical when the
    // atmosphere is hidden. Computed before the backend branch, published to
    // frameState for the WebGPU sun renderer and stored on the primitive for
    // the WebGL uniform below, so both paths read the same transmittance.
    //
    // It is not inert from orbit. From a 400 km vantage the 111 km shell
    // subtends 73.1 deg from nadir and the solid Earth 70.2 deg, so a
    // 2.9-deg-wide annulus of directions produces limb-grazing rays that
    // traverse the whole atmosphere — the band the sun crosses during an
    // orbital sunset. Over that band the transmittance is exactly (1,1,1)
    // for tangent heights above 111 km and then ramps monotonically to blue
    // 8.3e-12 / red 1.7e-5 at a grazing altitude of 0 km, with the red/blue
    // ratio climbing from 1.0 to 2.0e6; `sun-orbital-limb-extinction.spec.mjs`
    // pins that ramp.
    //
    // The integral is evaluated on the camera-to-sun-centre ray only, so the
    // whole billboard receives one uniform tint where a real setting sun is
    // graded across its disc. At this vantage the sun's 0.5327 deg angular
    // diameter maps to a 21.33 km span in tangent height, over which the
    // upper-limb to lower-limb transmittance ratio is strongly altitude- and
    // channel-dependent — 1.12 in blue at a 60 km tangent height, 2.33 at
    // 40 km, 2.0e5 at 15 km and 1.9e17 at 0 km. Differential extinction
    // across the disc, and refraction lift and flattening, are not
    // implemented.
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
    // WebGL uniform source. One when the atmosphere is hidden, making the
    // shader multiply byte-identical.
    this._atmosphereExtinction = Cartesian3.clone(
      extinction,
      this._atmosphereExtinction,
    );
    const atmosphereAlpha = solarDiscAtmosphereAlpha(extinction);
    frameState.sunAtmosphereAlpha = atmosphereAlpha;
    this._atmosphereAlpha = atmosphereAlpha;

    // Continuous occlusion fade, which is what makes the sun set rather than
    // vanish.
    //
    // `Scene.updateEnvironment` still runs its binary cull
    // (`environmentState.isSunVisible = isVisible(..., occluder)`) and is
    // deliberately left alone. That test culls only when the sun's
    // six-solar-radii glow bounding sphere lies entirely inside the Earth
    // occluder's horizon cone, which implies the far smaller solar disc is
    // fully occluded, so the cull can only fire in frames where
    // `sunVisibleFraction` is already exactly 0. The cull boundary therefore
    // sits well inside the alpha-zero region and the visible transition is
    // the fade below; keeping it also keeps the disabled position trivially
    // byte-identical and preserves the culling cost saving.
    //
    // The fade multiplies alpha, not rgb. Both backends blend this billboard
    // `ALPHA_BLEND` — `BlendingState.ALPHA_BLEND` below on WebGL, and the same
    // `src-alpha` / `one-minus-src-alpha` pair in the sun pipeline
    // `WebGPUEnvironmentRenderer.js` builds. Under that function alpha is the
    // blend weight and dimming rgb instead paints a dark disc over the sky
    // rather than fading the sun out of it. Alpha is the weight under an
    // additive `src-alpha` function too, so the multiply stays correct if a
    // backend's blend mode ever changes.
    //
    // Published to frameState before the backend branch so the WebGL uniform
    // and the WebGPU uniform buffer read one identical scalar.
    const eclipseAlpha = getEclipseSunFactor(frameState.eclipseState);
    frameState.sunEclipseAlpha = eclipseAlpha;
    this._eclipseAlpha = eclipseAlpha;

    // The limb-darkened disc and the inverse-square glare falloff. Resolved
    // before the backend branch and published on frameState so the WebGL
    // uniform payload below and the WebGPU CPU bake are fed the same numbers
    // rather than each reading `atmosphericConditions` independently.
    const appearance = readSunDiscAppearance(frameState, this._discAppearance);
    frameState.sunDiscAppearance = appearance;
    this._limbDarkening.x = appearance.a0;
    this._limbDarkening.y = appearance.a1;
    this._limbDarkening.z = appearance.a2;
    this._glareProfile.x = appearance.glareCore;
    this._glareProfile.y = appearance.glarePedestal;
    this._glareProfile.z = appearance.glareLegacyEdge;
    this._glareProfile.w = appearance.glareLegacy;

    // The disc's true angular size and the halo-source decision, resolved
    // before the feature-renderer branch for the same reason the disc
    // appearance is: the GLSL bake takes these as uniforms and the WebGPU CPU
    // bake reads the published object, so they are the same numbers rather
    // than two independent derivations. The screen-space consumers —
    // `SunPostProcess`'s `SolarHalo` stage on WebGL, `SunHaloEffect` on
    // WebGPU — read the same publication.
    //
    // `glowLengthTS` is hoisted out of the texture-rebuild block below
    // because the halo geometry needs it on the WebGPU path too, which
    // returns before that block ever runs.
    const glowLengthTS = this._glowFactor * 5.0;
    const halo = readSunHaloAppearance(
      frameState,
      glowLengthTS,
      this._haloAppearance,
    );
    frameState.sunHalo = halo;
    this._haloGain = halo.bakeHaloGain;
    // Read from the same publication both bakes and the `SunPostProcess`
    // bright pass read, so the WebGL uniform below cannot disagree with
    // WebGPU's uniform slot about how bright the sun is.
    this._discRadiance = halo.discRadiance;

    // Backend-specific rendering via Feature Renderer. Environment commands
    // are return-only: Scene publishes the result as sunDrawCommand, then the
    // renderer applies the authoritative visibility result while injecting it
    // into the ENVIRONMENT pass. EnvironmentFrustumDemand guarantees a
    // frustum for a visible sun-only frame, so a second binned copy is neither
    // needed nor correct (it would bypass isSunVisible).
    const fr = frameState.context.getFeatureRenderer(FeatureRendererKey.SUN);
    if (fr) {
      const drawCommand = fr.update(this, frameState);
      scratchBackendCommands.drawCommand = drawCommand;
      if (defined(drawCommand)) {
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
      // A toggle flip changes the baked profile, so the texture must be
      // re-baked exactly as a glowFactor change does. The halo key is folded
      // into the same signature at bits 2-3, so one comparison covers every
      // bake-shaping toggle.
      this._bakedAppearanceKey !== appearance.key + (halo.key << 2)
    ) {
      this._texture = this._texture && this._texture.destroy();
      this._drawingBufferWidth = drawingBufferWidth;
      this._drawingBufferHeight = drawingBufferHeight;
      this._glowFactorDirty = false;
      this._useHdr = useHdr;
      this._bakedAppearanceKey = appearance.key + (halo.key << 2);

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

      this._glowLengthTS = glowLengthTS;
      // The disc's terminating radius, resolved by `SunHaloAppearance`. The
      // expression `0.5 / (1 + 2*glowLengthTS)` is the
      // `enableTrueSolarDiscSize = false` position and is returned bit for
      // bit there; the default multiplies it by the bakes' own `lengthScalar`
      // so the disc subtends the Sun's true angular radius instead of
      // 1/sqrt(2) of it. `SolarDiscModel.solarDiscBakeEdgeLegacy` derives the
      // shortfall.
      this._radiusTS = halo.discEdge;

      const that = this;
      const uniformMap = {
        u_radiusTS: function () {
          return that._radiusTS;
        },
        // 1.0 keeps the baked halo and its lens-flare bursts; 0.0 removes
        // them from the bake because the post-process chain is drawing the
        // halo this frame. Derived in `SunHaloAppearance` and never set
        // independently, so a double halo is unrepresentable.
        u_haloGain: function () {
          return that._haloGain;
        },
        // The bake's only numeric source. `SunTextureFS` holds no copy of the
        // limb-darkening triple or the glare parameters; they arrive here
        // from `Scene/SolarDiscModel.js` through
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
// Extinction scratch. The exact-input cache writes identity when the
// atmosphere gate is disabled and reuses this result object every frame.
const scratchExtinction = new Cartesian3();

// Return shape for the feature-renderer path. Mirrors the WebGL
// `{ drawCommand, computeCommand }` pair so Scene routes the command through
// `environmentState.sunDrawCommand`, which the environment injection orders
// after the sky atmosphere.
const scratchBackendCommands = {
  drawCommand: undefined,
  computeCommand: undefined,
};

export default Sun;
