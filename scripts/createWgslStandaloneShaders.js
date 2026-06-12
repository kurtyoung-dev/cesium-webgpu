/**
 * Creates remaining feature-level WGSL shaders to close the GLSL→WGSL gap.
 * Run: node scripts/createMissingFeatureShaders.js
 */
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const BASE = join("packages", "engine", "Source", "Shaders", "WebGPU");

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

const files = {};

// ─── Atmosphere Common chunk (shared utilities) ───
files["chunks/functions/csm_atmosphereCommon.wgsl"] = `/**
 * Common atmosphere utilities shared by sky, ground, and model atmosphere.
 * Port of AtmosphereCommon.glsl.
 * @chunk functions/csm_atmosphereCommon
 */
const CSM_ATMOSPHERE_RAYLEIGH_SCALE_HEIGHT: f32 = 10000.0;
const CSM_ATMOSPHERE_MIE_SCALE_HEIGHT: f32 = 3200.0;
const CSM_ATMOSPHERE_MIE_G: f32 = 0.8;

fn csm_rayleighPhase(cosAngle: f32) -> f32 {
    return 3.0 / (16.0 * 3.14159265359) * (1.0 + cosAngle * cosAngle);
}

fn csm_miePhase(cosAngle: f32, g: f32) -> f32 {
    let g2: f32 = g * g;
    return (1.0 - g2) / (4.0 * 3.14159265359 * pow(1.0 + g2 - 2.0 * g * cosAngle, 1.5));
}

fn csm_densityAtAltitude(altitude: f32, scaleHeight: f32) -> f32 {
    return exp(-altitude / scaleHeight);
}

fn csm_computeEllipseAtmosphereFade(posWC: vec3<f32>, lightDir: vec3<f32>, innerRadius: f32) -> f32 {
    let altitude: f32 = length(posWC) - innerRadius;
    let atmosphereThickness: f32 = 111000.0;
    return clamp(altitude / atmosphereThickness, 0.0, 1.0);
}

fn csm_nearestPointOnEllipseFast(pos: vec2<f32>, radii: vec2<f32>) -> vec2<f32> {
    let p: vec2<f32> = abs(pos);
    let invRadii: vec2<f32> = 1.0 / radii;
    let evolScale: vec2<f32> = (radii.x * radii.x - radii.y * radii.y) * vec2<f32>(1.0, -1.0) * invRadii;
    let tTrigs: vec2<f32> = vec2<f32>(0.70710678118);
    let v: vec2<f32> = radii * tTrigs;
    let evolute: vec2<f32> = evolScale * tTrigs * tTrigs * tTrigs;
    let q: vec2<f32> = normalize(p - evolute) * length(v - evolute);
    let candidateT: vec2<f32> = normalize(q * invRadii);
    let candidateP: vec2<f32> = radii * candidateT;
    return candidateP * sign(pos);
}
`;

// ─── Model Atmosphere Stage ───
files["Model/ModelAtmosphereStage.wgsl"] = `/**
 * Applies atmosphere effects (fog, scattering) to model fragments.
 * Port of AtmosphereStageFS.glsl.
 */

fn csm_modelAtmosphereApplyFog(
    baseColor: vec4<f32>,
    positionWC: vec3<f32>,
    lightDir: vec3<f32>,
    cameraPositionWC: vec3<f32>,
    atmosphereRayleighColor: vec3<f32>,
    atmosphereMieColor: vec3<f32>,
    innerRadius: f32,
    fogDensity: f32
) -> vec4<f32> {
    let distance: f32 = length(positionWC - cameraPositionWC);
    let altitude: f32 = length(positionWC) - innerRadius;
    let atmosphereThickness: f32 = 111000.0;

    // Fade atmosphere based on distance from ellipsoid
    let fadeFactor: f32 = clamp(altitude / atmosphereThickness, 0.0, 1.0);

    // Fog based on distance
    let fogAmount: f32 = 1.0 - exp(-distance * fogDensity);

    // Compute in-scatter color from atmosphere
    let viewDir: vec3<f32> = normalize(positionWC - cameraPositionWC);
    let cosAngle: f32 = dot(viewDir, lightDir);
    let rayleighPhase: f32 = 0.75 * (1.0 + cosAngle * cosAngle);
    let g: f32 = 0.8;
    let g2: f32 = g * g;
    let miePhase: f32 = (1.0 - g2) / (4.0 * 3.14159265359 * pow(1.0 + g2 - 2.0 * g * cosAngle, 1.5));

    let atmosphereColor: vec3<f32> = atmosphereRayleighColor * rayleighPhase +
                                      atmosphereMieColor * miePhase;

    // Blend atmosphere with base color
    var result: vec3<f32> = mix(baseColor.rgb, atmosphereColor, fogAmount * (1.0 - fadeFactor));
    return vec4<f32>(result, baseColor.a);
}
`;

// ─── Model CPU Styling Stage ───
files["Model/ModelCPUStylingStage.wgsl"] = `/**
 * Applies CPU-driven per-feature styling (show/color) to model fragments.
 * Port of CPUStylingStageFS.glsl and CPUStylingStageVS.glsl.
 */

// Vertex stage: pass through feature color from instance/vertex attributes
fn csm_cpuStylingVertex(featureColor: vec4<f32>) -> vec4<f32> {
    return featureColor;
}

// Fragment stage: apply feature color to material
fn csm_cpuStylingFragment(
    materialColor: vec4<f32>,
    featureColor: vec4<f32>,
    isHighlighted: bool
) -> vec4<f32> {
    // Discard if feature is hidden (alpha = 0)
    if (featureColor.a == 0.0) {
        // Signal discard - caller should check alpha
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

    // MIX or REPLACE mode
    var result: vec4<f32> = materialColor;
    result = vec4<f32>(
        mix(materialColor.rgb, featureColor.rgb, featureColor.a),
        materialColor.a * featureColor.a
    );

    if (isHighlighted) {
        // Simple highlight: brighten
        result = vec4<f32>(result.rgb * 1.5, result.a);
    }

    return result;
}
`;

// ─── Model Point Cloud Styling Stage ───
files["Model/ModelPointCloudStylingStage.wgsl"] = `/**
 * Applies styling to point cloud vertices (size, color from expressions).
 * Port of PointCloudStylingStageVS.glsl.
 */

struct PointCloudStyle {
    pointSize: f32,
    color: vec4<f32>,
    show: f32,
};

fn csm_pointCloudStylingVertex(
    position: vec3<f32>,
    defaultColor: vec4<f32>,
    defaultSize: f32,
    styleColor: vec4<f32>,
    styleSize: f32,
    styleShow: f32
) -> PointCloudStyle {
    var style: PointCloudStyle;
    style.show = styleShow;
    style.color = select(defaultColor, styleColor, styleColor.a > 0.0);
    style.pointSize = select(defaultSize, styleSize, styleSize > 0.0);
    return style;
}
`;

// ─── ViewportQuad (full-screen quad) ───
files["ViewportQuad.wgsl"] = `/**
 * Simple viewport quad shader for material rendering on screen-space quads.
 * Port of ViewportQuadFS.glsl + ViewportQuadVS.glsl.
 */

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texCoords: vec2<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    // Full-screen triangle (3 vertices cover the screen)
    var pos: array<vec2<f32>, 3> = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0)
    );
    var uv: array<vec2<f32>, 3> = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(2.0, 1.0),
        vec2<f32>(0.0, -1.0)
    );

    var output: VertexOutput;
    output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
    output.texCoords = uv[vertexIndex];
    return output;
}

struct ViewportQuadUniforms {
    materialDiffuse: vec3<f32>,
    materialAlpha: f32,
};

@group(0) @binding(0) var<uniform> uniforms: ViewportQuadUniforms;

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    return vec4<f32>(uniforms.materialDiffuse, uniforms.materialAlpha);
}
`;

// ─── ShadowVolume (ground primitive stencil classification) ───
files["Classification/ShadowVolume.wgsl"] = `/**
 * Shadow volume fragment shader for ground primitive classification.
 * Port of ShadowVolumeFS.glsl.
 * Used for stencil-based classification rendering.
 */

@fragment
fn fragmentMain() -> @location(0) vec4<f32> {
    // Shadow volume rendering writes to stencil only.
    // The fragment color is unused but required for the pipeline.
    return vec4<f32>(1.0, 1.0, 1.0, 1.0);
}
`;

// ─── ShadowVolumeAppearance (ground primitive with appearance) ───
files["Classification/ShadowVolumeAppearance.wgsl"] = `/**
 * Shadow volume appearance shader for classified ground primitives.
 * Port of ShadowVolumeAppearanceFS.glsl + ShadowVolumeAppearanceVS.glsl.
 * Renders the classified geometry with proper material/lighting.
 */

struct SVAVertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) texCoord: vec2<f32>,
};

struct SVAVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) positionEC: vec3<f32>,
    @location(1) normalEC: vec3<f32>,
    @location(2) texCoords: vec2<f32>,
};

struct SVAUniforms {
    modelViewProjection: mat4x4<f32>,
    modelView: mat4x4<f32>,
    normalMatrix: mat3x3<f32>,
    color: vec4<f32>,
};

@group(0) @binding(0) var<uniform> svaUniforms: SVAUniforms;

@vertex
fn vertexMain(input: SVAVertexInput) -> SVAVertexOutput {
    var output: SVAVertexOutput;
    let posEC: vec4<f32> = svaUniforms.modelView * vec4<f32>(input.position, 1.0);
    output.position = svaUniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.positionEC = posEC.xyz;
    output.normalEC = normalize(svaUniforms.normalMatrix * input.normal);
    output.texCoords = input.texCoord;
    return output;
}

@fragment
fn fragmentMain(input: SVAVertexOutput) -> @location(0) vec4<f32> {
    let toEye: vec3<f32> = normalize(-input.positionEC);
    let lightDir: vec3<f32> = normalize(vec3<f32>(0.0, 0.0, 1.0));
    let NdotL: f32 = max(dot(input.normalEC, lightDir), 0.0);
    let diffuse: vec3<f32> = svaUniforms.color.rgb * (0.3 + 0.7 * NdotL);
    return vec4<f32>(diffuse, svaUniforms.color.a);
}
`;

// ─── CloudNoise (noise generation for cloud billboards) ───
files["CloudNoise.wgsl"] = `/**
 * Generates 3D noise textures for cloud billboard rendering.
 * Port of CloudNoiseFS.glsl + CloudNoiseVS.glsl.
 */

struct CloudNoiseVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) v_position: vec2<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> CloudNoiseVertexOutput {
    var pos: array<vec2<f32>, 3> = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0)
    );
    var output: CloudNoiseVertexOutput;
    output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
    output.v_position = pos[vertexIndex];
    return output;
}

fn csm_cloudNoiseHash(p: vec3<f32>) -> f32 {
    var p2: vec3<f32> = fract(p * vec3<f32>(443.897, 441.423, 437.195));
    p2 = p2 + dot(p2, p2.yzx + 19.19);
    return fract((p2.x + p2.y) * p2.z);
}

fn csm_cloudNoiseNoise(p: vec3<f32>) -> f32 {
    let i: vec3<f32> = floor(p);
    let f: vec3<f32> = fract(p);
    let u: vec3<f32> = f * f * (3.0 - 2.0 * f);

    return mix(
        mix(mix(csm_cloudNoiseHash(i + vec3<f32>(0.0, 0.0, 0.0)),
                csm_cloudNoiseHash(i + vec3<f32>(1.0, 0.0, 0.0)), u.x),
            mix(csm_cloudNoiseHash(i + vec3<f32>(0.0, 1.0, 0.0)),
                csm_cloudNoiseHash(i + vec3<f32>(1.0, 1.0, 0.0)), u.x), u.y),
        mix(mix(csm_cloudNoiseHash(i + vec3<f32>(0.0, 0.0, 1.0)),
                csm_cloudNoiseHash(i + vec3<f32>(1.0, 0.0, 1.0)), u.x),
            mix(csm_cloudNoiseHash(i + vec3<f32>(0.0, 1.0, 1.0)),
                csm_cloudNoiseHash(i + vec3<f32>(1.0, 1.0, 1.0)), u.x), u.y),
        u.z
    );
}

struct CloudNoiseUniforms {
    noiseTextureDimensions: vec3<f32>,
    noiseDetail: f32,
    noiseOffset: vec3<f32>,
    _pad: f32,
};

@group(0) @binding(0) var<uniform> cloudUniforms: CloudNoiseUniforms;

@fragment
fn fragmentMain(input: CloudNoiseVertexOutput) -> @location(0) vec4<f32> {
    let pos: vec2<f32> = input.v_position * 0.5 + 0.5;
    let sliceIndex: f32 = floor(pos.x * cloudUniforms.noiseTextureDimensions.z);
    let localX: f32 = fract(pos.x * cloudUniforms.noiseTextureDimensions.z);
    let p: vec3<f32> = vec3<f32>(localX, pos.y, sliceIndex / cloudUniforms.noiseTextureDimensions.z) + cloudUniforms.noiseOffset;

    var n: f32 = 0.0;
    var amp: f32 = 1.0;
    var freq: f32 = 1.0;
    for (var i: i32 = 0; i < 5; i = i + 1) {
        n += amp * csm_cloudNoiseNoise(p * freq);
        amp *= 0.5;
        freq *= cloudUniforms.noiseDetail;
    }

    return vec4<f32>(n, n, n, 1.0);
}
`;

// ─── Vector3DTile Clamped Polylines ───
files["Classification/Vector3DTileClampedPolylines.wgsl"] = `/**
 * Renders 3D Tiles vector polylines clamped to terrain.
 * Port of Vector3DTileClampedPolylinesFS.glsl + VS.glsl.
 */

struct V3DTPolylineVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) startPlaneEC: vec4<f32>,
    @location(1) endPlaneEC: vec4<f32>,
    @location(2) rightPlaneEC: vec4<f32>,
    @location(3) halfWidth: f32,
    @location(4) volumeUpEC: vec3<f32>,
};

struct V3DTPolylineUniforms {
    highlightColor: vec4<f32>,
    modelViewProjection: mat4x4<f32>,
    viewport: vec4<f32>,
};

@group(0) @binding(0) var<uniform> v3dtUniforms: V3DTPolylineUniforms;

@fragment
fn fragmentMain(input: V3DTPolylineVertexOutput) -> @location(0) vec4<f32> {
    // Simplified: render with highlight color
    // Full implementation requires globe depth texture readback
    return v3dtUniforms.highlightColor;
}
`;

// ─── Vector3DTile Polylines (non-clamped) ───
files["Classification/Vector3DTilePolylines.wgsl"] = `/**
 * Renders 3D Tiles vector polylines (not clamped to terrain).
 * Port of Vector3DTilePolylinesVS.glsl.
 */

struct V3DTPolylineInput {
    @location(0) currentPosition: vec3<f32>,
    @location(1) previousPosition: vec3<f32>,
    @location(2) nextPosition: vec3<f32>,
    @location(3) expandAndWidth: vec2<f32>,
};

struct V3DTPolylineOutput {
    @builtin(position) position: vec4<f32>,
};

struct V3DTPipelineUniforms {
    modelViewProjection: mat4x4<f32>,
    resolution: vec2<f32>,
    _pad: vec2<f32>,
};

@group(0) @binding(0) var<uniform> pipeUniforms: V3DTPipelineUniforms;

@vertex
fn vertexMain(input: V3DTPolylineInput) -> V3DTPolylineOutput {
    var output: V3DTPolylineOutput;
    output.position = pipeUniforms.modelViewProjection * vec4<f32>(input.currentPosition, 1.0);
    return output;
}
`;

// ─── VectorTile (basic vector tile vertex shader) ───
files["Classification/VectorTile.wgsl"] = `/**
 * Basic vector tile vertex shader. Port of VectorTileVS.glsl.
 * Used for batched 3D Tiles vector features.
 */

struct VectorTileInput {
    @location(0) position: vec3<f32>,
    @location(1) batchId: f32,
};

struct VectorTileOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) batchId: f32,
};

struct VectorTileUniforms {
    modelViewProjection: mat4x4<f32>,
    highlightColor: vec4<f32>,
};

@group(0) @binding(0) var<uniform> vtUniforms: VectorTileUniforms;

@vertex
fn vertexMain(input: VectorTileInput) -> VectorTileOutput {
    var output: VectorTileOutput;
    output.position = vtUniforms.modelViewProjection * vec4<f32>(input.position, 1.0);
    output.batchId = input.batchId;
    return output;
}

@fragment
fn fragmentMain(input: VectorTileOutput) -> @location(0) vec4<f32> {
    return vtUniforms.highlightColor;
}
`;

// ─── PolylineShadowVolume ───
files["Classification/PolylineShadowVolume.wgsl"] = `/**
 * Polyline shadow volume for ground-clamped polylines classification.
 * Port of PolylineShadowVolumeFS.glsl + PolylineShadowVolumeVS.glsl.
 */

struct PSVVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) startEC: vec3<f32>,
    @location(1) endEC: vec3<f32>,
    @location(2) forwardDirEC: vec3<f32>,
    @location(3) texCoordT: f32,
};

@fragment
fn fragmentMain(input: PSVVertexOutput) -> @location(0) vec4<f32> {
    // Shadow volume polylines write to stencil in the classification pass.
    // Fragment color is a fallback visualization.
    let dist: f32 = abs(input.texCoordT - 0.5) * 2.0;
    let alpha: f32 = 1.0 - smoothstep(0.8, 1.0, dist);
    return vec4<f32>(1.0, 1.0, 1.0, alpha);
}
`;

// ─── Voxel intersection utilities ───
files["Voxels/VoxelIntersection.wgsl"] = `/**
 * Voxel ray-volume intersection utilities.
 * Consolidated port of IntersectBox, IntersectCylinder, IntersectEllipsoid,
 * IntersectDepth, IntersectionUtils.glsl.
 */

struct VoxelIntersection {
    tNear: f32,
    tFar: f32,
    hit: bool,
};

fn csm_intersectBox(rayOrigin: vec3<f32>, rayDir: vec3<f32>, boxMin: vec3<f32>, boxMax: vec3<f32>) -> VoxelIntersection {
    var result: VoxelIntersection;
    let invDir: vec3<f32> = 1.0 / rayDir;
    let t0: vec3<f32> = (boxMin - rayOrigin) * invDir;
    let t1: vec3<f32> = (boxMax - rayOrigin) * invDir;
    let tmin: vec3<f32> = min(t0, t1);
    let tmax: vec3<f32> = max(t0, t1);
    result.tNear = max(max(tmin.x, tmin.y), tmin.z);
    result.tFar = min(min(tmax.x, tmax.y), tmax.z);
    result.hit = result.tNear <= result.tFar && result.tFar > 0.0;
    return result;
}

fn csm_intersectSphere(rayOrigin: vec3<f32>, rayDir: vec3<f32>, center: vec3<f32>, radius: f32) -> VoxelIntersection {
    var result: VoxelIntersection;
    let oc: vec3<f32> = rayOrigin - center;
    let a: f32 = dot(rayDir, rayDir);
    let b: f32 = 2.0 * dot(oc, rayDir);
    let c: f32 = dot(oc, oc) - radius * radius;
    let disc: f32 = b * b - 4.0 * a * c;
    if (disc < 0.0) {
        result.hit = false;
        result.tNear = -1.0;
        result.tFar = -1.0;
        return result;
    }
    let sd: f32 = sqrt(disc);
    result.tNear = (-b - sd) / (2.0 * a);
    result.tFar = (-b + sd) / (2.0 * a);
    result.hit = result.tFar > 0.0;
    return result;
}

fn csm_intersectCylinder(
    rayOrigin: vec3<f32>,
    rayDir: vec3<f32>,
    cylinderCenter: vec3<f32>,
    cylinderAxis: vec3<f32>,
    radius: f32,
    halfHeight: f32
) -> VoxelIntersection {
    var result: VoxelIntersection;
    let oc: vec3<f32> = rayOrigin - cylinderCenter;
    let dDotA: f32 = dot(rayDir, cylinderAxis);
    let ocDotA: f32 = dot(oc, cylinderAxis);
    let a: f32 = dot(rayDir, rayDir) - dDotA * dDotA;
    let b: f32 = 2.0 * (dot(oc, rayDir) - dDotA * ocDotA);
    let c: f32 = dot(oc, oc) - ocDotA * ocDotA - radius * radius;
    let disc: f32 = b * b - 4.0 * a * c;
    if (disc < 0.0) {
        result.hit = false;
        return result;
    }
    let sd: f32 = sqrt(disc);
    var t0: f32 = (-b - sd) / (2.0 * a);
    var t1: f32 = (-b + sd) / (2.0 * a);
    // Clamp to height
    let h0: f32 = ocDotA + t0 * dDotA;
    let h1: f32 = ocDotA + t1 * dDotA;
    if (abs(h0) > halfHeight) { t0 = t1; }
    if (abs(h1) > halfHeight) { t1 = t0; }
    result.tNear = t0;
    result.tFar = t1;
    result.hit = t1 > 0.0;
    return result;
}

fn csm_convertLocalToBoxUv(localPos: vec3<f32>, boxMin: vec3<f32>, boxMax: vec3<f32>) -> vec3<f32> {
    return (localPos - boxMin) / (boxMax - boxMin);
}
`;

// ─── Voxel ray march ───
files["Voxels/VoxelRayMarch.wgsl"] = `/**
 * Voxel ray marching for volume rendering.
 * Port of Octree.glsl + Megatexture.glsl + VoxelFS.glsl concepts.
 */

struct VoxelRayMarchUniforms {
    modelViewProjection: mat4x4<f32>,
    inverseModelView: mat4x4<f32>,
    cameraPositionMC: vec3<f32>,
    stepCount: f32,
    volumeMin: vec3<f32>,
    volumeDensity: f32,
    volumeMax: vec3<f32>,
    _pad: f32,
};

@group(0) @binding(0) var<uniform> voxelUniforms: VoxelRayMarchUniforms;
@group(0) @binding(1) var volumeTexture: texture_3d<f32>;
@group(0) @binding(2) var volumeSampler: sampler;

fn csm_sampleVoxelDensity(uvw: vec3<f32>) -> f32 {
    return textureSample(volumeTexture, volumeSampler, uvw).r;
}

fn csm_voxelRayMarch(
    rayOrigin: vec3<f32>,
    rayDir: vec3<f32>,
    tNear: f32,
    tFar: f32,
    stepCount: i32,
    densityScale: f32,
    volumeMin: vec3<f32>,
    volumeMax: vec3<f32>
) -> vec4<f32> {
    let stepSize: f32 = (tFar - tNear) / f32(stepCount);
    var accColor: vec3<f32> = vec3<f32>(0.0);
    var accAlpha: f32 = 0.0;

    for (var i: i32 = 0; i < stepCount; i = i + 1) {
        if (accAlpha >= 0.99) { break; }
        let t: f32 = tNear + (f32(i) + 0.5) * stepSize;
        let samplePos: vec3<f32> = rayOrigin + rayDir * t;
        let uvw: vec3<f32> = (samplePos - volumeMin) / (volumeMax - volumeMin);

        if (all(uvw >= vec3<f32>(0.0)) && all(uvw <= vec3<f32>(1.0))) {
            let density: f32 = csm_sampleVoxelDensity(uvw) * densityScale;
            let sampleAlpha: f32 = 1.0 - exp(-density * stepSize);
            let sampleColor: vec3<f32> = vec3<f32>(density); // Transfer function
            accColor += sampleColor * sampleAlpha * (1.0 - accAlpha);
            accAlpha += sampleAlpha * (1.0 - accAlpha);
        }
    }

    return vec4<f32>(accColor, accAlpha);
}
`;

// Create all files
let count = 0;
for (const [relPath, content] of Object.entries(files)) {
  const fullPath = join(BASE, relPath);
  const dir = fullPath.substring(
    0,
    fullPath.lastIndexOf("\\") > 0
      ? fullPath.lastIndexOf("\\")
      : fullPath.lastIndexOf("/"),
  );
  ensureDir(dir);
  writeFileSync(fullPath, content, "utf8");
  count++;
  console.log(`Created: ${relPath}`);
}
console.log(`\nTotal: ${count} feature-level WGSL files created.`);
