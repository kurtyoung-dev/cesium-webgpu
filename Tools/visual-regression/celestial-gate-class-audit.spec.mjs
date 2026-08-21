// Audit boundary: boolean literals in buildLighting/buildSkyAtmosphere plus
// the !== false convention scan; delegated getters are outside scope.
// The convention scan masks comments and strings. Needles inside JavaScript
// template strings are therefore a known discovery exemption, although direct
// evidence bindings may still assert them.
// Run: node --test Tools/visual-regression/celestial-gate-class-audit.spec.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const ATMOSPHERIC_CONDITIONS =
  "packages/engine/Source/Scene/AtmosphericConditions.js";

const CELESTIAL_FLAG_CLASSIFICATION = Object.freeze({
  "lighting.enableSunLight": {
    scope: "audit-gate",
    gate: "enableSunLight",
  },
  "lighting.enableMoonLight": {
    scope: "audit-gate",
    gate: "enableMoonLight",
  },
  "lighting.enableMoonPhase": {
    scope: "audit-gate",
    gate: "enableMoonPhase",
  },
  "lighting.enableEarthshine": {
    scope: "audit-gate",
    gate: "enableEarthshine",
  },
  "lighting.enableEarthshinePhase": {
    scope: "audit-gate",
    gate: "enableEarthshinePhase",
  },
  "lighting.enableSoftTerminator": {
    scope: "audit-gate",
    gate: "enableSoftTerminator",
  },
  "lighting.enableDualLightAtmosphere": {
    scope: "audit-gate",
    gate: "enableDualLightAtmosphere",
  },
  "lighting.enableLunarBRDF": {
    scope: "audit-gate",
    gate: "enableLunarBRDF",
  },
  "lighting.enableOppositionSurge": {
    scope: "audit-gate",
    gate: "enableOppositionSurge",
  },
  "lighting.enableMoonSkyWash": {
    scope: "audit-gate",
    gate: "enableMoonSkyWash",
  },
  "lighting.enableLunarNormalMap": {
    scope: "audit-gate",
    gate: "enableLunarNormalMap",
  },
  "lighting.enableEclipse": {
    scope: "audit-gate",
    gate: "enableEclipse",
  },
  "lighting.enableEclipseGlobeShadow": {
    scope: "audit-gate",
    gate: "enableEclipseGlobeShadow",
  },
  "lighting.enableSolarLimbDarkening": {
    scope: "audit-gate",
    gate: "enableSolarLimbDarkening",
  },
  "lighting.enableSolarGlareFalloff": {
    scope: "audit-gate",
    gate: "enableSolarGlareFalloff",
  },
  "lighting.enableTrueSolarDiscSize": {
    scope: "audit-gate",
    gate: "enableTrueSolarDiscSize",
  },
  "lighting.enableScreenSpaceSunHalo": {
    scope: "audit-gate",
    gate: "enableScreenSpaceSunHalo",
  },
  "lighting.enableAngularSolarGlare": {
    scope: "audit-gate",
    gate: "enableAngularSolarGlare",
  },
  "lighting.enableEclipseHorizonTwilight": {
    scope: "audit-gate",
    gate: "enableEclipseHorizonTwilight",
  },
  "skyAtmosphere.enableStarBrightnessModulation": {
    scope: "audit-gate",
    gate: "enableStarBrightnessModulation",
  },
  "skyAtmosphere.enableNightSkyDimming": {
    scope: "audit-gate",
    gate: "enableNightSkyDimming",
  },
});

const evidence = (relativePath, ...needles) => ({ relativePath, needles });

const AUDIT_GATES = Object.freeze([
  {
    flag: "enableSunLight",
    discoveryKey: "lighting.enableSunLight",
    kind: "UNWIRED",
    noConsumerCensus: true,
    evidence: [
      evidence(ATMOSPHERIC_CONDITIONS, "enableSunLight: true,"),
      evidence(
        "packages/sandcastle/gallery/eclipse-explorer/main.js",
        "enableSunLight: true,",
      ),
    ],
    chains: [],
  },
  {
    flag: "enableMoonLight",
    discoveryKey: "lighting.enableMoonLight",
    kind: "UNWIRED",
    noConsumerCensus: true,
    evidence: [
      evidence(ATMOSPHERIC_CONDITIONS, "enableMoonLight: true,"),
      evidence(
        "packages/sandcastle/gallery/eclipse-explorer/main.js",
        "enableMoonLight: true,",
      ),
    ],
    chains: [],
  },
  {
    flag: "enableMoonPhase",
    discoveryKey: "lighting.enableMoonPhase",
    kind: "BOTH-BACKEND",
    chains: [
      {
        name: "moon phase feeding earthshine phase scale",
        resolvedQuantity:
          "phaseModelled plus phaseFraction -> frameState.moonEarthshinePhaseScale",
        chain:
          "Scene/Moon.js -> Scene/MoonPhaseAppearance.js -> WebGPU moon packer / EllipsoidPrimitive -> moon fragment shaders",
        plumbing: [
          evidence(
            "packages/engine/Source/Scene/Moon.js",
            "ac.lighting.enableMoonPhase",
            "if (!enableMoonPhase) {",
            "frameState.moonPhaseFraction = phaseFraction;",
            "frameState.moonEarthshinePhaseScale = phaseAppearance.earthshinePhaseScale;",
          ),
          evidence(
            "packages/engine/Source/Scene/MoonPhaseAppearance.js",
            "phaseModelled === true && lighting?.enableEarthshinePhase === true;",
            "? computeEarthshinePhaseScale(phaseFraction)",
            ": 1.0;",
          ),
          evidence(
            "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
            "ud[85] = frameState.moonEarthshinePhaseScale ?? 1.0;",
          ),
          evidence(
            "packages/engine/Source/Scene/EllipsoidPrimitive.js",
            "u_earthshinePhaseScale: function () {",
            "return that.earthshinePhaseScale ?? 1.0;",
          ),
        ],
        wgslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl",
            "earthshinePhaseScale: f32,",
            "(1.0 - rawNdotL) * u.earthshinePhaseScale;",
          ),
        ],
        glslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/EllipsoidFS.glsl",
            "uniform float u_earthshinePhaseScale;",
            "(1.0 - rawNdotL) * u_earthshinePhaseScale;",
          ),
        ],
      },
    ],
  },
  {
    flag: "enableEarthshine",
    discoveryKey: "lighting.enableEarthshine",
    kind: "BOTH-BACKEND",
    chains: [
      {
        name: "earthshine contribution enabled",
        resolvedQuantity:
          "WGSL earthshineOn 0/1; GLSL EARTHSHINE define from resolved term presence",
        chain:
          "AtmosphericConditions.lighting -> WebGPU moon packer / Scene/Moon.js and EllipsoidPrimitive -> moon fragment shaders",
        plumbing: [
          evidence(
            "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
            "ac.lighting.enableEarthshine === true",
            "ud[68] = earthshineOn;",
          ),
          evidence(
            "packages/engine/Source/Scene/Moon.js",
            "lighting.enableEarthshine === true;",
            "ellipsoidPrimitive.earthshinePhaseScale = earthshineEnabled",
          ),
          evidence(
            "packages/engine/Source/Scene/EllipsoidPrimitive.js",
            "const earthshineEnabled = defined(this.earthshinePhaseScale);",
            'fs.defines.push("EARTHSHINE");',
          ),
        ],
        wgslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl",
            "let earthshineOn: bool = u32(round(u.enableEarthshine)) == 1u;",
            "if (earthshineOn) {",
            "color = color + earthshine;",
          ),
        ],
        glslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/EllipsoidFS.glsl",
            "#ifdef EARTHSHINE",
            "litColor.rgb += vec3(0.4, 0.5, 0.7) * 0.08",
          ),
        ],
      },
    ],
  },
  {
    flag: "enableEarthshinePhase",
    discoveryKey: "lighting.enableEarthshinePhase",
    kind: "BOTH-BACKEND",
    chains: [
      {
        name: "earthshine phase scale",
        resolvedQuantity:
          "enableEarthshinePhase -> resolved Earth illumination scale",
        chain:
          "Scene/MoonPhaseAppearance.js -> Moon frameState publication -> WebGPU packer / WebGL uniform -> moon shaders",
        plumbing: [
          evidence(
            "packages/engine/Source/Scene/MoonPhaseAppearance.js",
            "lighting?.enableEarthshinePhase === true;",
            "result.earthshinePhaseScale = earthshinePhase",
            "? computeEarthshinePhaseScale(phaseFraction)",
          ),
          evidence(
            "packages/engine/Source/Scene/Moon.js",
            "frameState.moonEarthshinePhaseScale = phaseAppearance.earthshinePhaseScale;",
            "ellipsoidPrimitive.earthshinePhaseScale = earthshineEnabled",
          ),
          evidence(
            "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
            "ud[85] = frameState.moonEarthshinePhaseScale ?? 1.0;",
          ),
          evidence(
            "packages/engine/Source/Scene/EllipsoidPrimitive.js",
            "u_earthshinePhaseScale: function () {",
            "return that.earthshinePhaseScale ?? 1.0;",
          ),
        ],
        wgslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl",
            "(1.0 - rawNdotL) * u.earthshinePhaseScale;",
          ),
        ],
        glslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/EllipsoidFS.glsl",
            "(1.0 - rawNdotL) * u_earthshinePhaseScale;",
          ),
        ],
      },
    ],
  },
  {
    flag: "enableSoftTerminator",
    discoveryKey: "lighting.enableSoftTerminator",
    kind: "BOTH-BACKEND",
    chains: [
      {
        name: "finite-solar-disc terminator softness",
        resolvedQuantity:
          "enableSoftTerminator -> solar angular radius or exact zero identity",
        chain:
          "MoonPhaseAppearance -> Moon frameState publication -> WebGPU packer / EllipsoidPrimitive -> moon shaders",
        plumbing: [
          evidence(
            "packages/engine/Source/Scene/MoonPhaseAppearance.js",
            "const softTerminator = lighting?.enableSoftTerminator === true;",
            "result.terminatorSoftness = softTerminator",
            "? computeSolarAngularRadius(sunDistance)",
          ),
          evidence(
            "packages/engine/Source/Scene/Moon.js",
            "frameState.moonTerminatorSoftness = phaseAppearance.terminatorSoftness;",
            "ellipsoidPrimitive.terminatorSoftness = phaseAppearance.softTerminator",
          ),
          evidence(
            "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
            "ud[86] = frameState.moonTerminatorSoftness ?? 0.0;",
          ),
          evidence(
            "packages/engine/Source/Scene/EllipsoidPrimitive.js",
            'fs.defines.push("SOFT_TERMINATOR");',
            "u_terminatorSoftness: function () {",
          ),
        ],
        wgslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl",
            "fn softTerminatorMu0(",
            "let mu0 = softTerminatorMu0(dot(N, L), mu0Hard, u.terminatorSoftness);",
          ),
        ],
        glslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/EllipsoidFS.glsl",
            "float softTerminatorMu0(float nDotL, float hardMu0, float softness)",
            "mu0 = softTerminatorMu0(dot(material.normal, lunarLightDirEC), mu0, u_terminatorSoftness);",
          ),
        ],
      },
    ],
  },
  {
    flag: "enableDualLightAtmosphere",
    discoveryKey: "lighting.enableDualLightAtmosphere",
    kind: "DORMANT-WGSL-SCAFFOLD",
    evidence: [
      evidence(
        ATMOSPHERIC_CONDITIONS,
        "enableDualLightAtmosphere: true,",
        "moonIntensity: 0.05,",
      ),
    ],
    chains: [
      {
        name: "dormant moon-inscatter LUT contribution",
        resolvedQuantity:
          "dualLightControl.x is pinned to 0 because the shipped sky LUT consumer is disabled",
        chain:
          "ENABLE_SKY_INSCATTER_LUT=false -> packUniforms(useLut=false) -> enableDual=false -> dormant WGSL LUT branch",
        plumbing: [
          evidence(
            "packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js",
            "const ENABLE_SKY_INSCATTER_LUT = false;",
            "ENABLE_SKY_INSCATTER_LUT && lutInfo.useLut,",
            "acLighting.enableDualLightAtmosphere !== false &&",
            "useLut === true;",
            "uniformData[60] = enableDual ? 1.0 : 0.0;",
            "uniformData[62] = acLighting?.moonIntensity ?? 0.05;",
          ),
        ],
        wgslConsumers: [],
        glslConsumers: [],
        dormantWgslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/WebGPU/Environment/SkyAtmosphere.wgsl",
            "if (u.dualLightControl.x > 0.5 && u.dualLightControl.y > 0.001) {",
            "moonInscatterLut, startPoint, rayDir, innerRadius, outerRadius,",
            "let moonScale = u.dualLightControl.y * u.dualLightControl.z;",
            "color = color + moonColor * moonScale;",
          ),
        ],
        counterpartEvidence: [
          evidence(
            "packages/engine/Source/Shaders/SkyAtmosphereFS.glsl",
            "GLSL has NO dual-light (sun+moon) scattering",
          ),
        ],
      },
      {
        name: "dormant inline moon-scattering contribution",
        resolvedQuantity:
          "atmosControl.y is pinned to 0 because dualLightInline ships disabled",
        chain:
          "dualLightInline=false -> packUniforms(dualLightInline=false) -> atmosControl.y=0 -> dormant WGSL inline branch",
        plumbing: [
          evidence(
            "packages/engine/Source/Scene/SkyAtmosphere.js",
            "this.dualLightInline = false;",
          ),
          evidence(
            "packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js",
            "const dualLightInline = skyAtmosphere.dualLightInline === true;",
          ),
        ],
        wgslConsumers: [],
        glslConsumers: [],
        dormantWgslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/WebGPU/Environment/SkyAtmosphere.wgsl",
            "if (u.atmosControl.y > 0.5 && u.moonControl.x > 0.001) {",
          ),
        ],
      },
    ],
  },
  {
    flag: "enableLunarBRDF",
    discoveryKey: "lighting.enableLunarBRDF",
    kind: "BOTH-BACKEND",
    chains: [
      {
        name: "Lommel-Seeliger lunar reflectance",
        resolvedQuantity: "runtime lunarBRDF selection",
        chain:
          "Moon.js -> WebGPU uniform / WebGL shader define -> moon shaders",
        plumbing: [
          evidence(
            "packages/engine/Source/Scene/Moon.js",
            "const lunarBRDF = defined(lighting) && lighting.enableLunarBRDF === true;",
            "ellipsoidPrimitive.lunarBRDF = lunarBRDF;",
          ),
          evidence(
            "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
            "ac.lighting.enableLunarBRDF === true",
            "ud[79] =",
          ),
          evidence(
            "packages/engine/Source/Scene/EllipsoidPrimitive.js",
            "const lunarBRDFEnabled = this.lunarBRDF === true;",
            'fs.defines.push("LUNAR_BRDF");',
          ),
        ],
        wgslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl",
            "let useLunar: bool = u32(round(u.lunarBRDF)) == 1u;",
            "let lommelSeeliger = 2.0 * mu0 / (mu0 + mu + 1.0e-4);",
            "lit = m.diffuse * lommelSeeliger * u.oppositionSurge;",
          ),
        ],
        glslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/EllipsoidFS.glsl",
            "#ifdef LUNAR_BRDF",
            "float lommelSeeliger = 2.0 * mu0 / (mu0 + mu + 1.0e-4);",
            "vec4 litColor = vec4(material.diffuse * lommelSeeliger, material.alpha);",
          ),
        ],
      },
    ],
  },
  {
    flag: "enableOppositionSurge",
    discoveryKey: "lighting.enableOppositionSurge",
    kind: "BOTH-BACKEND",
    chains: [
      {
        name: "Hapke opposition-surge multiplier",
        resolvedQuantity: "CPU phase-angle multiplier or exact 1.0 identity",
        chain:
          "Moon.js -> frameState / EllipsoidPrimitive -> WebGPU and WebGL moon shaders",
        plumbing: [
          evidence(
            "packages/engine/Source/Scene/Moon.js",
            "lighting.enableOppositionSurge === true;",
            "oppositionSurge = computeLunarOppositionSurge(Math.acos(cosPhaseAngle));",
            "frameState.moonOppositionSurge = oppositionSurge;",
            "ellipsoidPrimitive.oppositionSurge = surgeEnabled",
          ),
          evidence(
            "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
            "ud[83] = frameState.moonOppositionSurge ?? 1.0;",
          ),
          evidence(
            "packages/engine/Source/Scene/EllipsoidPrimitive.js",
            'fs.defines.push("OPPOSITION_SURGE");',
            "u_oppositionSurge: function () {",
          ),
        ],
        wgslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl",
            "lit = m.diffuse * lommelSeeliger * u.oppositionSurge;",
            "lit = phongCsmMaterial(m, L, toEyeMC) * u.oppositionSurge;",
          ),
        ],
        glslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/EllipsoidFS.glsl",
            "#ifdef OPPOSITION_SURGE",
            "litColor.rgb *= u_oppositionSurge;",
          ),
        ],
      },
    ],
  },
  {
    flag: "enableMoonSkyWash",
    discoveryKey: "lighting.enableMoonSkyWash",
    kind: "BOTH-BACKEND",
    chains: [
      {
        name: "additive lunar sky wash",
        resolvedQuantity:
          "CPU atmosphere inscatter or exact vec3(0) additive identity",
        chain:
          "Moon.js -> frameState / EllipsoidPrimitive -> WebGPU and WebGL moon shaders",
        plumbing: [
          evidence(
            "packages/engine/Source/Scene/Moon.js",
            "lighting.enableMoonSkyWash === true;",
            "frameState.moonAtmosphereInscatter = Cartesian3.clone(",
            "ellipsoidPrimitive.atmosphereInscatter = washEnabled",
          ),
          evidence(
            "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
            "ud[80] = defined(inscatter) ? inscatter.x : 0.0;",
            "ud[81] = defined(inscatter) ? inscatter.y : 0.0;",
            "ud[82] = defined(inscatter) ? inscatter.z : 0.0;",
          ),
          evidence(
            "packages/engine/Source/Scene/EllipsoidPrimitive.js",
            'fs.defines.push("ATMOSPHERE_INSCATTER");',
            "u_atmosphereInscatter: function () {",
          ),
        ],
        wgslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl",
            "out.color = vec4<f32>(hitColor.rgb * u.extinction + u.inscatter, 1.0);",
          ),
        ],
        glslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/EllipsoidFS.glsl",
            "#ifdef ATMOSPHERE_INSCATTER",
            "out_FragColor.rgb += u_atmosphereInscatter;",
          ),
        ],
      },
    ],
  },
  {
    flag: "enableLunarNormalMap",
    discoveryKey: "lighting.enableLunarNormalMap",
    kind: "BOTH-BACKEND",
    chains: [
      {
        name: "LOLA tangent-space lunar relief",
        resolvedQuantity:
          "normal-map strength greater than zero or exact zero identity",
        chain:
          "Moon.js -> WebGPU uniform / WebGL define and sampler -> moon shaders",
        plumbing: [
          evidence(
            "packages/engine/Source/Scene/Moon.js",
            "lighting.enableLunarNormalMap === true;",
            "const normalMapStrength = resolveMoonNormalMapStrength(",
            "frameState.moonNormalMapStrength = normalMapStrength;",
          ),
          evidence(
            "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
            "ud[84] = frameState.moonNormalMapStrength ?? 0.0;",
          ),
          evidence(
            "packages/engine/Source/Scene/EllipsoidPrimitive.js",
            'fs.defines.push("LUNAR_NORMAL_MAP");',
            "u_lunarNormalMap: function () {",
          ),
        ],
        wgslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/WebGPU/Environment/Moon.wgsl",
            "if (u.normalStrength > 0.0) {",
            "let nRaw = textureSampleGrad(normalTex, samp, uv, uvDx, uvDy).xyz * 2.0 - 1.0;",
            "N = normalize(eastMC * nTS.x + northMC * nTS.y + upMC * nTS.z);",
          ),
        ],
        glslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/EllipsoidFS.glsl",
            "#ifdef LUNAR_NORMAL_MAP",
            "vec3 nTS = texture(u_lunarNormalMap, st).xyz * 2.0 - 1.0;",
            "material.normal = normalize(czm_normal * perturbedMC);",
          ),
        ],
      },
    ],
  },
  {
    flag: "enableEclipse",
    discoveryKey: "lighting.enableEclipse",
    kind: "BOTH-BACKEND",
    chains: [
      {
        name: "continuous solar-disc eclipse fade",
        resolvedQuantity:
          "enabled EclipseState -> sunVisibleFraction -> sunEclipseAlpha",
        chain:
          "Scene.js -> EclipseState -> Sun.js -> WebGPU sun packer / WebGL uniform -> sun fragment shaders",
        plumbing: [
          evidence(
            "packages/engine/Source/Scene/Scene.js",
            "eclipseLighting.enableEclipse !== false",
            "scratchEclipseOptions.enabled = defined(eclipseLighting)",
          ),
          evidence(
            "packages/engine/Source/Scene/Sun.js",
            "const eclipseAlpha = getEclipseSunFactor(frameState.eclipseState);",
            "frameState.sunEclipseAlpha = eclipseAlpha;",
            "u_eclipseAlpha: function () {",
          ),
          evidence(
            "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
            'uniformData[31] = typeof eclipseAlpha === "number" ? eclipseAlpha : 1.0;',
          ),
        ],
        wgslConsumers: [
          {
            relativePath:
              "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
            description: "production WGSL template scales sun alpha",
            needles: ["color = vec4f(color.rgb, color.a * u.eclipseAlpha);"],
          },
        ],
        glslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/SunFS.glsl",
            "uniform float u_eclipseAlpha;",
            "out_FragColor.a *= u_eclipseAlpha;",
          ),
        ],
      },
    ],
  },
  {
    flag: "enableEclipseGlobeShadow",
    discoveryKey: "lighting.enableEclipseGlobeShadow",
    kind: "BOTH-BACKEND",
    chains: [
      {
        name: "per-fragment lunar shadow on globe terrain",
        resolvedQuantity:
          "active eclipse-globe block or inert four-vec4 uniform",
        chain:
          "EclipseGlobeShadow -> WebGPU eclipse UBO / WebGL globe define and uniform -> globe shaders",
        plumbing: [
          evidence(
            "packages/engine/Source/Scene/EclipseGlobeShadow.js",
            "eclipseLighting?.enableEclipse !== false &&",
            "eclipseLighting?.enableEclipseGlobeShadow !== false;",
            "frameState.eclipseGlobeShadow = updateEclipseGlobeShadow(",
          ),
          evidence(
            "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeEclipseUniforms.ts",
            ").eclipseGlobeShadow;",
            "packEclipseUniforms(block, this._scratch);",
          ),
          evidence(
            "packages/engine/Source/Scene/GlobeSurfaceShaderSet.js",
            'fs.defines.push("ENABLE_ECLIPSE_GLOBE_SHADOW");',
          ),
        ],
        wgslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
            "if (eclipseUniforms.params.x > 0.5) {",
            "eclipseAbsolute = globe_eclipseFragmentFactor(input.v_positionMC);",
            "color = color * eclipseAbsolute;",
          ),
        ],
        glslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/GlobeFS.glsl",
            "#ifdef ENABLE_ECLIPSE_GLOBE_SHADOW",
            "eclipseAbsolute = eclipseFragmentFactor(v_positionMC);",
            "finalColor.rgb *= eclipseAbsolute;",
          ),
        ],
      },
    ],
  },
  {
    flag: "enableSolarLimbDarkening",
    discoveryKey: "lighting.enableSolarLimbDarkening",
    kind: "NO-WGSL-CONSUMER",
    chains: [
      {
        name: "solar limb-darkening bake",
        resolvedQuantity:
          "resolved limb polynomial consumed by WebGPU CPU bake and WebGL GLSL bake",
        chain:
          "SunDiscAppearance -> frameState -> WebGPUEnvironmentRenderer CPU loop / SunTextureFS.glsl",
        plumbing: [
          evidence(
            "packages/engine/Source/Scene/SunDiscAppearance.js",
            "const limbDarkening = lighting?.enableSolarLimbDarkening !== false;",
            "result.a0 = limbDarkening ? SOLAR_LIMB_DARKENING_A0 : 1.0;",
          ),
          evidence(
            "packages/engine/Source/Scene/Sun.js",
            "frameState.sunDiscAppearance = appearance;",
            "u_limbDarkening: function () {",
          ),
        ],
        cpuConsumers: [
          evidence(
            "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
            "const limb = a0 + a1 * mu + a2 * mu * mu;",
            "const surface = (radius <= radiusTS ? 1.0 : 0.0) * limb;",
          ),
        ],
        wgslConsumers: [],
        glslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/SunTextureFS.glsl",
            "float limb = u_limbDarkening.x + u_limbDarkening.y * mu + u_limbDarkening.z * mu * mu;",
          ),
        ],
      },
    ],
  },
  {
    flag: "enableSolarGlareFalloff",
    discoveryKey: "lighting.enableSolarGlareFalloff",
    kind: "NO-WGSL-CONSUMER",
    chains: [
      {
        name: "solar glare falloff bake",
        resolvedQuantity:
          "resolved Lorentzian/legacy selector consumed by WebGPU CPU bake and WebGL GLSL bake",
        chain:
          "SunDiscAppearance -> frameState -> WebGPUEnvironmentRenderer CPU loop / SunTextureFS.glsl",
        plumbing: [
          evidence(
            "packages/engine/Source/Scene/SunDiscAppearance.js",
            "const glareFalloff = lighting?.enableSolarGlareFalloff !== false;",
            "result.glareLegacy = glareFalloff ? 0.0 : 1.0;",
          ),
        ],
        cpuConsumers: [
          evidence(
            "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
            "const sunGlare = (radius) => {",
            "const raw = 1.0 / (1.0 + t * t);",
            "return Math.min(1.0, Math.max(0.0, shaped));",
          ),
        ],
        wgslConsumers: [],
        glslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/SunTextureFS.glsl",
            "float sunGlare(float radius)",
            "float raw = 1.0 / (1.0 + t * t);",
            "return u_glareProfile.w > 0.5 ? legacy : shaped;",
          ),
        ],
      },
    ],
  },
  {
    flag: "enableTrueSolarDiscSize",
    discoveryKey: "lighting.enableTrueSolarDiscSize",
    kind: "NO-WGSL-CONSUMER",
    chains: [
      {
        name: "solar-disc bake radius",
        resolvedQuantity:
          "true disc edge or legacy undersized edge consumed by both bakes",
        chain:
          "SunHaloAppearance -> WebGPU CPU bake / WebGL SunTextureFS uniform",
        plumbing: [
          evidence(
            "packages/engine/Source/Scene/SunHaloAppearance.js",
            "const trueDiscSize = lighting?.enableTrueSolarDiscSize !== false;",
            "result.discEdge = trueDiscSize",
            "? solarDiscBakeEdge(glowLengthTS, true)",
            ": solarDiscBakeEdgeLegacy(glowLengthTS);",
          ),
          evidence(
            "packages/engine/Source/Scene/Sun.js",
            "this._radiusTS = halo.discEdge;",
            "u_radiusTS: function () {",
          ),
        ],
        cpuConsumers: [
          evidence(
            "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
            "const radiusTS = halo ? halo.discEdge : 0.5 / (1.0 + 2.0 * glowLengthTS);",
            "const surface = (radius <= radiusTS ? 1.0 : 0.0) * limb;",
          ),
        ],
        wgslConsumers: [],
        glslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/SunTextureFS.glsl",
            "uniform float u_radiusTS;",
            "float surface = step(radius, u_radiusTS) * limb;",
          ),
        ],
      },
    ],
  },
  {
    flag: "enableScreenSpaceSunHalo",
    discoveryKey: "lighting.enableScreenSpaceSunHalo",
    kind: "BOTH-BACKEND",
    chains: [
      {
        name: "screen-space solar halo",
        resolvedQuantity:
          "frameState.sunHalo intensity and geometry or exact zero intensity",
        chain:
          "SunHaloAppearance -> WebGPU/WebGL post-process state -> paired SolarHalo shaders",
        plumbing: [
          evidence(
            "packages/engine/Source/Scene/SunHaloAppearance.js",
            "const haloRequested = lighting?.enableScreenSpaceSunHalo !== false;",
            "const screenHalo = haloRequested && chainAvailable;",
            "result.haloIntensity = result.visible",
          ),
          evidence(
            "packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessStageCollection.ts",
            "intensity: halo.haloIntensity ?? 0,",
          ),
          evidence(
            "packages/engine/Source/Scene/SunPostProcess.js",
            "postProcess._haloIntensity = halo.haloIntensity;",
          ),
        ],
        wgslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/WebGPU/PostProcess/SolarHalo.wgsl",
            "let veil = 1.0 / (1.0 + t * t);",
            "return vec4<f32>(color.rgb + halo.tint.xyz * (veil * halo.tint.w), color.a);",
          ),
        ],
        glslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/PostProcessStages/SolarHalo.glsl",
            "float veil = 1.0 / (1.0 + t * t);",
            "out_FragColor = vec4(color.rgb + u_haloColor * (veil * u_haloIntensity), color.a);",
          ),
        ],
      },
    ],
  },
  {
    flag: "enableAngularSolarGlare",
    discoveryKey: "lighting.enableAngularSolarGlare",
    kind: "BOTH-BACKEND",
    chains: [
      {
        name: "panorama angular solar glare",
        resolvedQuantity: "TEME sun direction plus glare curve and strength",
        chain:
          "SolarGlareAppearance -> CubeMapPanorama -> WebGPU packer / WebGL uniforms -> panorama shaders",
        plumbing: [
          evidence(
            "packages/engine/Source/Scene/SolarGlareAppearance.js",
            "lighting?.enableAngularSolarGlare === true && defined(sunDirectionWC);",
            "result.strength = enabled",
          ),
          evidence(
            "packages/engine/Source/Scene/CubeMapPanorama.js",
            "const glareAppearance = frameState.solarGlareAppearance;",
            "g.w = glareAppearance.strength;",
          ),
          evidence(
            "packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js",
            "uniformData[63] = solarGlare?.w ?? 0.0;",
          ),
        ],
        wgslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/WebGPU/CubeMapPanorama.wgsl",
            "if (uniforms.solarGlare.w > 0.0) {",
            "modulated = modulated * (1.0 - uniforms.solarGlare.w * veil);",
          ),
        ],
        glslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/SkyBoxFS.glsl",
            "if (u_solarGlare.w > 0.0)",
            "color.rgb *= (1.0 - u_solarGlare.w * veil);",
          ),
        ],
      },
      {
        name: "catalogue angular solar glare",
        resolvedQuantity:
          "same TEME sun direction and glare curve applied per catalogue star",
        chain:
          "SolarGlareAppearance -> WebGPU/WebGL star packers -> catalogue vertex shaders",
        plumbing: [
          evidence(
            "packages/engine/Source/Renderer/WebGPU/WebGPUStarFieldRenderer.ts",
            "const glare = frameState.solarGlareAppearance;",
            "uniformData[31] = glare.strength;",
          ),
          evidence(
            "packages/engine/Source/Renderer/WebGLStarFieldRenderer.js",
            "const glare = frameState.solarGlareAppearance;",
            "cache.solarGlare.w = glare.strength;",
            "u_solarGlare: function () {",
          ),
        ],
        wgslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/WebGPU/Catalog/StarField.wgsl",
            "if (u.solarGlare.w > 0.0) {",
            "output.color = input.color * input.intensity * u.intensityScale * extinction * glare;",
          ),
        ],
        glslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/StarFieldVS.glsl",
            "if (u_solarGlare.w > 0.0)",
            "v_color = starColor * intensity * u_intensityScale * extinction * glare;",
          ),
        ],
      },
    ],
  },
  {
    flag: "enableEclipseHorizonTwilight",
    discoveryKey: "lighting.enableEclipseHorizonTwilight",
    kind: "BOTH-BACKEND",
    chains: [
      {
        name: "360-degree eclipse horizon twilight",
        resolvedQuantity:
          "EclipseState horizon factor -> WebGPU eclipseControl.x / WebGL uniform",
        chain:
          "Scene.js -> EclipseState -> SkyAtmosphere -> WebGPU packer / WebGL uniform -> sky shaders",
        plumbing: [
          evidence(
            "packages/engine/Source/Scene/Scene.js",
            "eclipseLighting.enableEclipseHorizonTwilight !== false",
            "frameState.eclipseHorizonTwilight = view._eclipseHorizonTwilight;",
          ),
          evidence(
            "packages/engine/Source/Scene/SkyAtmosphere.js",
            "this._eclipseHorizonTwilight = frameState.eclipseHorizonTwilight ?? 0.0;",
            "u_eclipseHorizonTwilight: function () {",
          ),
          evidence(
            "packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js",
            "uniformData[116] = skyAtmosphere._eclipseHorizonTwilight ?? 0.0;",
          ),
        ],
        wgslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/WebGPU/Environment/SkyAtmosphere.wgsl",
            "if (u.eclipseControl.x > 0.0) {",
            "color = color + skyLuminance * ECLIPSE_TWILIGHT_TINT * (u.eclipseControl.x * band);",
          ),
        ],
        glslConsumers: [
          evidence(
            "packages/engine/Source/Shaders/SkyAtmosphereFS.glsl",
            "if (u_eclipseHorizonTwilight > 0.0 && translucent == 0.0)",
            "color.rgb += skyLuminance * ECLIPSE_TWILIGHT_TINT * (u_eclipseHorizonTwilight * band);",
          ),
        ],
      },
    ],
  },
  {
    flag: "enableStarBrightnessModulation",
    discoveryKey: "skyAtmosphere.enableStarBrightnessModulation",
    kind: "BOTH-BACKEND",
    chains: [
      {
        name: "star cubemap modulation factor",
        resolvedQuantity:
          "CubeMapPanorama._starModulation.z plus _skyBrightness -> 1 - smoothstep(t)",
        chain:
          "Scene/CubeMapPanorama.js -> WebGPU panorama packer / WebGL uniform map -> panorama fragment shaders",
        plumbing: [
          evidence(
            "packages/engine/Source/Scene/CubeMapPanorama.js",
            "sky.enableStarBrightnessModulation === true",
            "m.z = enable ? 1.0 : 0.0;",
            "panorama._skyBrightness = frameState.skyBrightness ?? 1.0;",
            "u_starModulation: function () {",
            "u_skyBrightness: function () {",
          ),
          evidence(
            "packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js",
            "uniformData[51] = panorama?._skyBrightness ?? 1.0;",
            "uniformData[54] = starModulation?.z ?? 0.0;",
          ),
        ],
        wgslConsumers: [
          {
            relativePath:
              "packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js",
            description:
              "embedded production WGSL multiplies by the resolved factor",
            needles: [
              "let enableMod = uniforms.starModulation.z > 0.5;",
              "let factor = 1.0 - smoothstep(0.0, 1.0, t);",
              "modulated = modulated * factor;",
            ],
          },
          {
            relativePath:
              "packages/engine/Source/Shaders/WebGPU/CubeMapPanorama.wgsl",
            description: "standalone WGSL twin consumes the same factor",
            needles: [
              "let enableMod = uniforms.starModulation.z > 0.5;",
              "modulated = modulated * factor;",
            ],
          },
        ],
        glslConsumers: [
          {
            relativePath: "packages/engine/Source/Shaders/SkyBoxFS.glsl",
            description:
              "WebGL star cubemap multiplies by the same resolved factor",
            needles: [
              "if (u_starModulation.z > 0.5)",
              "float factor = 1.0 - smoothstep(0.0, 1.0, t);",
              "color.rgb *= factor;",
            ],
          },
        ],
      },
      {
        name: "catalogue effective intensity scale",
        resolvedQuantity:
          "StarField._effectiveIntensityScale = intensity * resolved reveal",
        chain:
          "Scene/StarField.js -> WebGPU/WebGL star packers -> catalogue vertex shaders",
        plumbing: [
          evidence(
            "packages/engine/Source/Scene/StarField.js",
            "skyLeaf.enableStarBrightnessModulation === true",
            "const modulation = computeStarBrightnessModulation(",
            "const effectiveIntensityScale = this._intensity * reveal;",
            "this._effectiveIntensityScale = effectiveIntensityScale;",
          ),
          evidence(
            "packages/engine/Source/Renderer/WebGPU/WebGPUStarFieldRenderer.ts",
            "uniformData[18] = effectiveIntensityScale;",
          ),
          evidence(
            "packages/engine/Source/Renderer/WebGLStarFieldRenderer.js",
            "cache.intensityScale = effectiveIntensityScale;",
            "u_intensityScale: function () {",
          ),
        ],
        wgslConsumers: [
          {
            relativePath:
              "packages/engine/Source/Shaders/WebGPU/Catalog/StarField.wgsl",
            description: "WebGPU catalogue multiplies by u.intensityScale",
            needles: [
              "output.color = input.color * input.intensity * u.intensityScale * extinction * glare;",
            ],
          },
        ],
        glslConsumers: [
          {
            relativePath: "packages/engine/Source/Shaders/StarFieldVS.glsl",
            description: "WebGL catalogue multiplies by u_intensityScale",
            needles: [
              "v_color = starColor * intensity * u_intensityScale * extinction * glare;",
            ],
          },
        ],
      },
    ],
  },
  {
    flag: "enableNightSkyDimming",
    discoveryKey: "skyAtmosphere.enableNightSkyDimming",
    kind: "UNWIRED",
    noConsumerCensus: true,
    evidence: [
      evidence(
        ATMOSPHERIC_CONDITIONS,
        "Reserved and currently unwired: this is the only reference to",
        "enableNightSkyDimming: true,",
      ),
    ],
    chains: [],
  },
  {
    flag: "cloud-cover occlusion",
    kind: "ROUTED-COMPARATOR",
    shippedDefault: {
      on: false,
      description:
        "OFF effectively: weather.enabled defaults false; raw cloud coverage defaults 0.5",
      evidence: [
        evidence(
          "packages/engine/Source/Scene/Scene.js",
          "this._enableWeather = false;",
        ),
        evidence(
          "packages/engine/Source/Scene/CloudVolumetrics.js",
          "this.cloudCoverage = options.cloudCoverage ?? 0.5;",
        ),
        evidence(
          ATMOSPHERIC_CONDITIONS,
          "return globe.defaultCloudCollection.volumetric.cloudCoverage;",
          "return scene.enableWeather;",
        ),
      ],
    },
    maintainerRoute: "C13_READ_ONLY",
    chains: [
      {
        name: "effective star-map cloud cover",
        resolvedQuantity:
          "weather.enabled ? weather.cloudCover : 0 -> CubeMapPanorama._starModulation.w",
        chain:
          "AtmosphericConditions.weather -> Scene/CubeMapPanorama.js -> WebGPU packer / WebGL uniform map -> panorama fragment shaders",
        plumbing: [
          evidence(
            "packages/engine/Source/Scene/CubeMapPanorama.js",
            "weather.enabled === true",
            "? weather.cloudCover",
            "m.w = cloudCover;",
            "u_starModulation: function () {",
          ),
          evidence(
            "packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js",
            "uniformData[55] = starModulation?.w ?? 0.0;",
          ),
        ],
        wgslConsumers: [
          {
            relativePath:
              "packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js",
            description:
              "embedded production WGSL multiplies by one minus cloud cover",
            needles: [
              "let cloudCover = clamp(uniforms.starModulation.w, 0.0, 1.0);",
              "modulated = modulated * (1.0 - cloudCover);",
            ],
          },
          {
            relativePath:
              "packages/engine/Source/Shaders/WebGPU/CubeMapPanorama.wgsl",
            description: "standalone WGSL twin consumes the same coverage",
            needles: [
              "let cloudCover = clamp(uniforms.starModulation.w, 0.0, 1.0);",
              "modulated = modulated * (1.0 - cloudCover);",
            ],
          },
        ],
        glslConsumers: [
          {
            relativePath: "packages/engine/Source/Shaders/SkyBoxFS.glsl",
            description:
              "WebGL star cubemap multiplies by one minus the same coverage",
            needles: [
              "color.rgb *= (1.0 - clamp(u_starModulation.w, 0.0, 1.0));",
            ],
          },
        ],
      },
    ],
  },
]);

// The broad convention scan intentionally sees non-celestial `.enabled`
// aliases and convention-only flags outside the literal-leaf boundary. Keep
// every current hit classified by path, identifier and cardinality so a new
// hit cannot hide behind an existing generic name.
const CONVENTION_SCAN_CLASSIFICATION = Object.freeze([
  {
    relativePath:
      "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts",
    identifier: "enabled",
    count: 1,
    scope: "non-celestial-alias",
    reason: "fog.enabled",
  },
  {
    relativePath:
      "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts",
    identifier: "enabled",
    count: 1,
    scope: "non-celestial-alias",
    reason: "fog.enabled",
  },
  {
    relativePath:
      "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileUB.ts",
    identifier: "enableNightLights",
    count: 1,
    scope: "delegated-getter",
    reason:
      "AtmosphericConditions delegates this Globe flag outside the literal leaves",
  },
  {
    relativePath:
      "packages/engine/Source/Renderer/WebGPU/WebGPUPostProcessStageCollection.ts",
    identifier: "enabled",
    count: 1,
    scope: "non-celestial-alias",
    reason: "post-process stage enabled state",
  },
  {
    relativePath:
      "packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js",
    identifier: "enableDualLightAtmosphere",
    count: 2,
    scope: "audit-gate",
    gate: "enableDualLightAtmosphere",
  },
  {
    relativePath: "packages/engine/Source/Scene/EclipseGlobeShadow.js",
    identifier: "enableEclipse",
    count: 1,
    scope: "audit-gate",
    gate: "enableEclipse",
  },
  {
    relativePath: "packages/engine/Source/Scene/EclipseGlobeShadow.js",
    identifier: "enableEclipseGlobeShadow",
    count: 1,
    scope: "audit-gate",
    gate: "enableEclipseGlobeShadow",
  },
  {
    relativePath: "packages/engine/Source/Scene/EclipseState.js",
    identifier: "enabled",
    count: 1,
    scope: "audit-gate-alias",
    gate: "enableEclipse",
    reason: "options.enabled carries Scene's enableEclipse result",
  },
  {
    relativePath: "packages/engine/Source/Scene/Scene.js",
    identifier: "enableEclipse",
    count: 1,
    scope: "audit-gate",
    gate: "enableEclipse",
  },
  {
    relativePath: "packages/engine/Source/Scene/Scene.js",
    identifier: "enableEclipseHorizonTwilight",
    count: 1,
    scope: "audit-gate",
    gate: "enableEclipseHorizonTwilight",
  },
  {
    relativePath: "packages/engine/Source/Scene/SunDiscAppearance.js",
    identifier: "enableSolarLimbDarkening",
    count: 1,
    scope: "audit-gate",
    gate: "enableSolarLimbDarkening",
  },
  {
    relativePath: "packages/engine/Source/Scene/SunDiscAppearance.js",
    identifier: "enableSolarGlareFalloff",
    count: 1,
    scope: "audit-gate",
    gate: "enableSolarGlareFalloff",
  },
  {
    relativePath: "packages/engine/Source/Scene/SunHaloAppearance.js",
    identifier: "enableTrueSolarDiscSize",
    count: 1,
    scope: "audit-gate",
    gate: "enableTrueSolarDiscSize",
  },
  {
    relativePath: "packages/engine/Source/Scene/SunHaloAppearance.js",
    identifier: "enableScreenSpaceSunHalo",
    count: 1,
    scope: "audit-gate",
    gate: "enableScreenSpaceSunHalo",
  },
  {
    relativePath: "packages/engine/Source/Scene/SunHaloAppearance.js",
    identifier: "enableTrueSolarRadiance",
    count: 1,
    scope: "convention-only-flag",
    reason:
      "not a boolean literal in buildLighting; effectively on by undefined !== false",
  },
]);

const sourceCache = new Map();
const maskedSourceCache = new Map();

function readSource(relativePath) {
  let source = sourceCache.get(relativePath);
  if (source === undefined) {
    source = fs
      .readFileSync(path.join(root, relativePath), "utf8")
      .replace(/\r\n/g, "\n");
    sourceCache.set(relativePath, source);
  }
  return source;
}

function maskCommentsAndStrings(source) {
  const chars = [...source];
  let state = "code";
  let quote = "";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const n = chars[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") {
        chars[i] = chars[i + 1] = " ";
        i++;
        state = "line-comment";
      } else if (c === "/" && n === "*") {
        chars[i] = chars[i + 1] = " ";
        i++;
        state = "block-comment";
      } else if (c === '"' || c === "'" || c === "`") {
        quote = c;
        chars[i] = " ";
        state = "string";
      }
    } else if (state === "line-comment") {
      if (c === "\n") {
        state = "code";
      } else {
        chars[i] = " ";
      }
    } else if (state === "block-comment") {
      if (c === "*" && n === "/") {
        chars[i] = chars[i + 1] = " ";
        i++;
        state = "code";
      } else if (c !== "\n") {
        chars[i] = " ";
      }
    } else if (state === "string") {
      if (c === "\\") {
        chars[i] = " ";
        if (i + 1 < chars.length && chars[i + 1] !== "\n") {
          chars[++i] = " ";
        }
      } else if (c === quote) {
        chars[i] = " ";
        state = "code";
      } else if (c !== "\n") {
        chars[i] = " ";
      }
    }
  }
  assert.equal(state, "code", "unterminated comment or string in source");
  return chars.join("");
}

function matchingDelimiter(masked, openAt, open, close) {
  assert.equal(masked[openAt], open, `expected ${open} at ${openAt}`);
  let depth = 0;
  for (let i = openAt; i < masked.length; i++) {
    if (masked[i] === open) {
      depth++;
    } else if (masked[i] === close && --depth === 0) {
      return i;
    }
  }
  assert.fail(`unterminated ${open}${close} block at ${openAt}`);
}

function splitTopLevelEntries(maskedBody, sourceBody) {
  const entries = [];
  let braces = 0;
  let brackets = 0;
  let parens = 0;
  let start = 0;
  for (let i = 0; i <= maskedBody.length; i++) {
    const c = maskedBody[i];
    if (c === "{") braces++;
    else if (c === "}") braces--;
    else if (c === "[") brackets++;
    else if (c === "]") brackets--;
    else if (c === "(") parens++;
    else if (c === ")") parens--;
    if (
      (c === "," || i === maskedBody.length) &&
      braces === 0 &&
      brackets === 0 &&
      parens === 0
    ) {
      const maskedEntry = maskedBody.slice(start, i).trim();
      if (maskedEntry.length > 0) {
        const leading = maskedBody.slice(start, i).search(/\S/);
        entries.push({
          masked: maskedEntry,
          source: sourceBody.slice(start, i).trim(),
          offset: start + Math.max(leading, 0),
        });
      }
      start = i + 1;
    }
  }
  assert.equal(braces, 0, "unbalanced nested object in leaf literal");
  assert.equal(brackets, 0, "unbalanced array in leaf literal");
  assert.equal(parens, 0, "unbalanced call in leaf literal");
  return entries;
}

function parseLeafBooleans(source, functionName, leafName) {
  const masked = maskCommentsAndStrings(source);
  const declaration = `function ${functionName}(`;
  const functionAt = masked.indexOf(declaration);
  assert.ok(functionAt >= 0, `${declaration} not found`);
  assert.equal(
    masked.indexOf(declaration, functionAt + declaration.length),
    -1,
    `${declaration} must be unique`,
  );
  const functionOpen = masked.indexOf("{", functionAt);
  const functionClose = matchingDelimiter(masked, functionOpen, "{", "}");
  const functionMasked = masked.slice(functionOpen + 1, functionClose);
  const functionSource = source.slice(functionOpen + 1, functionClose);
  const leafMatch = /\bconst\s+leaf\s*=\s*\{/.exec(functionMasked);
  assert.ok(leafMatch, `${functionName} const leaf object not found`);
  assert.equal(
    (functionMasked.match(/\bconst\s+leaf\s*=\s*\{/g) ?? []).length,
    1,
    `${functionName} must have exactly one const leaf object`,
  );
  const objectOpen = functionMasked.indexOf("{", leafMatch.index);
  const objectClose = matchingDelimiter(functionMasked, objectOpen, "{", "}");
  const maskedBody = functionMasked.slice(objectOpen + 1, objectClose);
  const sourceBody = functionSource.slice(objectOpen + 1, objectClose);
  const bodyAbsoluteAt = functionOpen + 1 + objectOpen + 1;

  const booleans = [];
  for (const entry of splitTopLevelEntries(maskedBody, sourceBody)) {
    const match = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*([\s\S]+)$/.exec(
      entry.masked,
    );
    assert.ok(
      match,
      `${functionName} has an unparsed leaf entry: ${entry.source}`,
    );
    const [, name, valueText] = match;
    const value = valueText.trim();
    if (name.startsWith("enable")) {
      assert.match(
        value,
        /^(?:true|false)$/,
        `${functionName}.${name} must use a discoverable boolean literal`,
      );
    }
    if (value === "true" || value === "false") {
      const absoluteAt = bodyAbsoluteAt + entry.offset;
      booleans.push({
        key: `${leafName}.${name}`,
        leaf: leafName,
        flag: name,
        defaultOn: value === "true",
        line: source.slice(0, absoluteAt).split("\n").length,
      });
    }
  }
  return booleans;
}

function discoverDefaultTrueCelestialFlags() {
  const source = readSource(ATMOSPHERIC_CONDITIONS);
  return [
    ...parseLeafBooleans(source, "buildLighting", "lighting"),
    ...parseLeafBooleans(source, "buildSkyAtmosphere", "skyAtmosphere"),
  ].filter((entry) => entry.defaultOn);
}

function assertEvidenceItem(item) {
  const source = readSource(item.relativePath);
  for (const needle of item.needles) {
    assert.ok(
      source.includes(needle),
      `${item.relativePath} no longer establishes ${JSON.stringify(needle)}`,
    );
  }
}

const trackedSourceFilesByScope = new Map();

function listTrackedSourceFiles(scope) {
  let files = trackedSourceFilesByScope.get(scope);
  if (files !== undefined) return files;
  const result = spawnSync("git", ["ls-files", "-z", "--", scope], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `git ls-files failed for ${scope}: ${result.stderr.trim()}`,
  );
  files = result.stdout
    .split("\0")
    .filter(
      (relativePath) =>
        relativePath.length > 0 &&
        /\.(?:js|mjs|ts|wgsl|glsl)$/.test(relativePath),
    )
    .map((relativePath) => path.resolve(root, relativePath))
    .sort();
  trackedSourceFilesByScope.set(scope, files);
  return files;
}

function readMaskedSource(relativePath) {
  let masked = maskedSourceCache.get(relativePath);
  if (masked === undefined) {
    masked = maskCommentsAndStrings(readSource(relativePath));
    maskedSourceCache.set(relativePath, masked);
  }
  return masked;
}

let consumerCensusFiles;

function listConsumerCensusFiles() {
  if (consumerCensusFiles !== undefined) return consumerCensusFiles;
  const scopes = [
    "packages/engine/Source",
    "packages/engine/Specs",
    "packages/widgets/Source",
    "packages/widgets/Specs",
    "Apps",
    "Specs",
  ];
  consumerCensusFiles = [
    ...new Set(scopes.flatMap((scope) => listTrackedSourceFiles(scope))),
  ].sort();
  return consumerCensusFiles;
}

function codeReferencesOutside(relativeExcludedPath, identifier) {
  const excluded = path.resolve(root, relativeExcludedPath);
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}\\b`, "g");
  const references = [];
  for (const absolute of listConsumerCensusFiles()) {
    if (path.resolve(absolute) === excluded) continue;
    const relativePath = path.relative(root, absolute).replaceAll("\\", "/");
    const source = readSource(relativePath);
    if (!source.includes(identifier)) continue;
    const masked = readMaskedSource(relativePath);
    for (const match of masked.matchAll(pattern)) {
      references.push({
        relativePath,
        line: source.slice(0, match.index).split("\n").length,
      });
    }
  }
  return references;
}

function discoverConventionUses() {
  const pattern = /\b(enable\w+)\s*!==\s*false/g;
  const uses = [];
  for (const absolute of listTrackedSourceFiles("packages/engine/Source")) {
    const relativePath = path.relative(root, absolute).replaceAll("\\", "/");
    const source = readSource(relativePath);
    const masked = readMaskedSource(relativePath);
    for (const match of masked.matchAll(pattern)) {
      uses.push({
        relativePath,
        identifier: match[1],
        line: source.slice(0, match.index).split("\n").length,
      });
    }
  }
  return uses;
}

function conventionClassificationKey(item) {
  return `${item.relativePath}\0${item.identifier}`;
}

function groupConventionUses(uses) {
  const grouped = new Map();
  for (const use of uses) {
    const key = conventionClassificationKey(use);
    const group = grouped.get(key) ?? {
      relativePath: use.relativePath,
      identifier: use.identifier,
      count: 0,
      lines: [],
    };
    group.count++;
    group.lines.push(use.line);
    grouped.set(key, group);
  }
  return [...grouped.values()].sort((a, b) =>
    conventionClassificationKey(a).localeCompare(
      conventionClassificationKey(b),
    ),
  );
}

function defaultForGate(gate, discoveredByKey) {
  if (gate.discoveryKey !== undefined) {
    const discovered = discoveredByKey.get(gate.discoveryKey);
    assert.ok(discovered, `${gate.discoveryKey} was not discovered`);
    return { on: discovered.defaultOn, description: "ON (discovered literal)" };
  }
  return gate.shippedDefault;
}

function evaluateGate(gate, discoveredByKey) {
  const shippedDefault = defaultForGate(gate, discoveredByKey);
  const missingGlsl = gate.chains.filter(
    (chain) =>
      shippedDefault.on &&
      chain.wgslConsumers.length > 0 &&
      chain.glslConsumers.length === 0,
  );
  if (missingGlsl.length > 0) {
    if (gate.maintainerRoute !== undefined) {
      return {
        flag: gate.flag,
        defaultOn: shippedDefault.on,
        verdict: "ROUTED",
        auditPass: true,
        reason: `recorded maintainer route ${gate.maintainerRoute}: missing GLSL for ${missingGlsl.map((c) => c.name).join(", ")}`,
      };
    }
    const contribution = missingGlsl.every(
      (chain) => chain.contribution === "additive",
    )
      ? "additive contribution"
      : "quantity";
    return {
      flag: gate.flag,
      defaultOn: shippedDefault.on,
      verdict: "AWAITING-RULING",
      auditPass: false,
      reason:
        `${gate.flag} is a default-ON WGSL-only ${contribution} awaiting a maintainer ruling ` +
        "(options: default-to-parity-OFF keeping the toggle, or an explicit routed acceptance)" +
        `; missing GLSL for ${missingGlsl.map((c) => c.name).join(", ")}`,
    };
  }
  const wgslCount = gate.chains.reduce(
    (count, chain) => count + chain.wgslConsumers.length,
    0,
  );
  return {
    flag: gate.flag,
    defaultOn: shippedDefault.on,
    verdict: "PASS",
    auditPass: true,
    reason: (() => {
      if (wgslCount > 0) {
        return shippedDefault.on
          ? "every resolved WGSL quantity has a GLSL consumer"
          : "implication antecedent false: effective shipped default is OFF; GLSL consumer also exists";
      }
      if (gate.kind === "UNWIRED") {
        return "implication antecedent false: unwired; the expanded consumer census is empty";
      }
      if (gate.kind === "NO-WGSL-CONSUMER") {
        return "implication antecedent false: WebGPU consumes this quantity in the CPU-side sun bake, not WGSL";
      }
      if (gate.kind === "DORMANT-WGSL-SCAFFOLD") {
        return "implication antecedent false: the WGSL scaffold is unreachable because ENABLE_SKY_INSCATTER_LUT is shipped false";
      }
      return "implication antecedent false: no live WGSL consumer exists";
    })(),
  };
}

function buildAuditState() {
  const discovered = discoverDefaultTrueCelestialFlags();
  const discoveredByKey = new Map(
    discovered.map((entry) => [entry.key, entry]),
  );
  assert.equal(
    discoveredByKey.size,
    discovered.length,
    "discovery returned duplicate leaf-qualified flags",
  );
  const results = AUDIT_GATES.map((gate) =>
    evaluateGate(gate, discoveredByKey),
  );
  const conventionUses = discoverConventionUses();
  return { discovered, discoveredByKey, results, conventionUses };
}

function formatConsumers(consumers) {
  return consumers.length === 0
    ? "none"
    : consumers
        .map(
          (consumer) =>
            `${consumer.relativePath} (${consumer.description ?? "bound source needles"})`,
        )
        .join("; ");
}

function printAuditReport(state) {
  console.log("CELESTIAL DEFAULT-TRUE DISCOVERY");
  for (const item of state.discovered) {
    const classification = CELESTIAL_FLAG_CLASSIFICATION[item.key];
    console.log(
      `  ${item.key} @ ${ATMOSPHERIC_CONDITIONS}:${item.line} -> ${classification.scope}${classification.gate ? ` (${classification.gate})` : ""}`,
    );
  }
  console.log("MASKED !== FALSE CONVENTION DISCOVERY");
  for (const use of state.conventionUses) {
    console.log(
      `  ${use.relativePath}:${use.line} ${use.identifier} !== false`,
    );
  }
  console.log("CELESTIAL 21-GATE TABLE");
  for (const gate of AUDIT_GATES.filter(
    (candidate) => candidate.discoveryKey !== undefined,
  )) {
    const result = state.results.find(
      (candidate) => candidate.flag === gate.flag,
    );
    console.log(
      `  ${gate.flag} | ${gate.kind} | default=${result.defaultOn ? "ON" : "OFF"} | verdict=${result.verdict}`,
    );
    for (const chain of gate.chains) {
      console.log(`    quantity: ${chain.resolvedQuantity}`);
      console.log(`    chain: ${chain.chain}`);
      console.log(`    WGSL: ${formatConsumers(chain.wgslConsumers)}`);
      console.log(`    GLSL: ${formatConsumers(chain.glslConsumers)}`);
      if ((chain.cpuConsumers ?? []).length > 0) {
        console.log(`    CPU: ${formatConsumers(chain.cpuConsumers)}`);
      }
      if ((chain.dormantWgslConsumers ?? []).length > 0) {
        console.log(
          `    dormant WGSL: ${formatConsumers(chain.dormantWgslConsumers)}`,
        );
      }
    }
    if (gate.chains.length === 0) {
      console.log("    quantity: unresolved / unwired");
      console.log("    WGSL: none");
      console.log("    GLSL: none");
    }
    console.log(`    reason: ${result.reason}`);
  }
  console.log("ROUTED VIOLATION COMPARATOR");
  for (const gate of AUDIT_GATES.filter(
    (candidate) => candidate.maintainerRoute !== undefined,
  )) {
    const result = state.results.find(
      (candidate) => candidate.flag === gate.flag,
    );
    console.log(
      `  ${gate.flag} | default=${result.defaultOn ? "ON" : "OFF"} | verdict=${result.verdict} | route=ROUTED:${gate.maintainerRoute}`,
    );
  }
}

test("discovery classifies every default-true celestial flag in both leaves", () => {
  const state = buildAuditState();
  assert.equal(state.discovered.length, 21, "the literal census must stay 21");
  assert.ok(
    state.discovered.some((entry) => entry.leaf === "lighting"),
    "buildLighting discovery must not be empty",
  );
  assert.ok(
    state.discovered.some((entry) => entry.leaf === "skyAtmosphere"),
    "buildSkyAtmosphere discovery must not be empty",
  );
  const discoveredKeys = [...state.discoveredByKey.keys()].sort();
  const classifiedKeys = Object.keys(CELESTIAL_FLAG_CLASSIFICATION).sort();
  assert.deepEqual(
    discoveredKeys,
    classifiedKeys,
    `classification drift; discovered-only=${discoveredKeys.filter((key) => !classifiedKeys.includes(key))}; classification-only=${classifiedKeys.filter((key) => !discoveredKeys.includes(key))}`,
  );
  const auditedClassifications = new Set(
    Object.values(CELESTIAL_FLAG_CLASSIFICATION)
      .filter((entry) => entry.scope === "audit-gate")
      .map((entry) => entry.gate),
  );
  const discoveredGates = AUDIT_GATES.filter(
    (gate) => gate.discoveryKey !== undefined,
  );
  assert.equal(discoveredGates.length, 21, "all 21 flags need gate rows");
  assert.deepEqual(
    [...auditedClassifications].sort(),
    discoveredGates.map((gate) => gate.flag).sort(),
    "the discovered classifications and the consumer audit table must agree",
  );
  for (const [discoveryKey, classification] of Object.entries(
    CELESTIAL_FLAG_CLASSIFICATION,
  )) {
    const gate = discoveredGates.find(
      (candidate) => candidate.flag === classification.gate,
    );
    assert.equal(
      gate?.discoveryKey,
      discoveryKey,
      `${classification.gate} must bind back to ${discoveryKey}`,
    );
  }
});

test("the masked !== false discovery has no unclassified leak", () => {
  const state = buildAuditState();
  const actual = groupConventionUses(state.conventionUses).map(
    ({ relativePath, identifier, count }) => ({
      relativePath,
      identifier,
      count,
    }),
  );
  const expected = CONVENTION_SCAN_CLASSIFICATION.map(
    ({ relativePath, identifier, count }) => ({
      relativePath,
      identifier,
      count,
    }),
  ).sort((a, b) =>
    conventionClassificationKey(a).localeCompare(
      conventionClassificationKey(b),
    ),
  );
  assert.deepEqual(actual, expected, "classify every masked convention hit");
  for (const classification of CONVENTION_SCAN_CLASSIFICATION) {
    if (classification.gate === undefined) continue;
    assert.ok(
      AUDIT_GATES.some((gate) => gate.flag === classification.gate),
      `${classification.relativePath} classifies ${classification.identifier} to missing gate ${classification.gate}`,
    );
  }
  assert.ok(
    state.conventionUses.some(
      (use) =>
        use.relativePath ===
          "packages/engine/Source/Renderer/WebGPU/WebGPUSkyAtmosphereRenderer.js" &&
        use.identifier === "enableDualLightAtmosphere" &&
        use.line === 413,
    ),
    "the prescribed discovery must catch WebGPUSkyAtmosphereRenderer.js:413",
  );
  assert.doesNotMatch(
    maskCommentsAndStrings("const embedded = `enableTemplateOnly !== false`;"),
    /\benable\w+\s*!==\s*false/,
    "JavaScript template-string contents are the documented scan exemption",
  );
});

test("consumer maps are anchored on resolved quantities and real transports", () => {
  const state = buildAuditState();
  for (const gate of AUDIT_GATES) {
    for (const item of gate.evidence ?? []) assertEvidenceItem(item);
    for (const item of gate.shippedDefault?.evidence ?? []) {
      assertEvidenceItem(item);
    }
    for (const chain of gate.chains) {
      assert.ok(
        chain.resolvedQuantity.length > 0,
        `${gate.flag} quantity missing`,
      );
      for (const item of chain.plumbing) assertEvidenceItem(item);
      for (const item of chain.cpuConsumers ?? []) assertEvidenceItem(item);
      for (const item of chain.wgslConsumers) assertEvidenceItem(item);
      for (const item of chain.glslConsumers) assertEvidenceItem(item);
      for (const item of chain.dormantWgslConsumers ?? []) {
        assertEvidenceItem(item);
      }
      for (const item of chain.counterpartEvidence ?? []) {
        assertEvidenceItem(item);
      }
    }
    if (gate.noConsumerCensus) {
      assert.deepEqual(
        codeReferencesOutside(ATMOSPHERIC_CONDITIONS, gate.flag),
        [],
        `${gate.flag} gained a consumer in packages/*/Source, Apps or Specs; classify its resolved chain`,
      );
    }
  }
  assert.equal(
    state.discoveredByKey.get("lighting.enableMoonPhase").defaultOn,
    true,
  );
});

test("default-on WGSL quantities imply a GLSL consumer", () => {
  const state = buildAuditState();
  assert.deepEqual(
    state.results.filter((result) => !result.auditPass),
    [],
    `celestial gate failures: ${JSON.stringify(state.results)}`,
  );
});

test("the implication distinguishes AWAITING-RULING from ROUTED", () => {
  const state = buildAuditState();
  const star = AUDIT_GATES.find(
    (gate) => gate.flag === "enableStarBrightnessModulation",
  );
  const starMutant = {
    ...star,
    chains: star.chains.map((chain) => ({ ...chain, glslConsumers: [] })),
  };
  assert.equal(
    evaluateGate(starMutant, state.discoveredByKey).verdict,
    "AWAITING-RULING",
    "a default-on WGSL-only quantity without a route must await a ruling",
  );
  assert.equal(
    evaluateGate(starMutant, state.discoveredByKey).auditPass,
    false,
    "AWAITING-RULING must fail the audit run",
  );

  const dual = AUDIT_GATES.find(
    (gate) => gate.flag === "enableDualLightAtmosphere",
  );
  const liveDualMutant = {
    ...dual,
    chains: dual.chains.map((chain) => ({
      ...chain,
      contribution: "additive",
      wgslConsumers: chain.dormantWgslConsumers,
    })),
  };
  const awaiting = evaluateGate(liveDualMutant, state.discoveredByKey);
  assert.equal(awaiting.verdict, "AWAITING-RULING");
  assert.match(awaiting.reason, /default-ON WGSL-only additive contribution/);
  assert.match(awaiting.reason, /default-to-parity-OFF keeping the toggle/);
  assert.match(awaiting.reason, /explicit routed acceptance/);

  const cloud = AUDIT_GATES.find(
    (gate) => gate.flag === "cloud-cover occlusion",
  );
  const cloudMutant = {
    ...cloud,
    shippedDefault: { ...cloud.shippedDefault, on: true },
    chains: cloud.chains.map((chain) => ({ ...chain, glslConsumers: [] })),
  };
  const routed = evaluateGate(cloudMutant, state.discoveredByKey);
  assert.equal(routed.verdict, "ROUTED");
  assert.equal(
    routed.auditPass,
    true,
    "the cloud finding must not fail this audit",
  );
});

test("prints the discovered flags and resolved consumer chains", () => {
  printAuditReport(buildAuditState());
});
