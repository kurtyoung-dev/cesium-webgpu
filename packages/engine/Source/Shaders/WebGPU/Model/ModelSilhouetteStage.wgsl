// Model Silhouette Stage — WGSL equivalent of ModelSilhouetteStageFS/VS.glsl
// Implements silhouette/outline effect for entity highlighting.

// Fragment: Applies silhouette color
fn modelSilhouetteStageFS(
    silhouetteColor: vec4<f32>,
    silhouetteSize: f32,
    isBackground: bool
) -> vec4<f32> {
    if (isBackground) {
        return silhouetteColor;
    }
    // Not a background pixel — discard in the silhouette pass
    return vec4<f32>(0.0);
}

// Vertex: Expands vertices along normals for outline pass
fn modelSilhouetteStageVS(
    positionClip: vec4<f32>,
    normalMC: vec3<f32>,
    normalMatrix: mat3x3<f32>,
    projection: mat4x4<f32>,
    silhouetteSize: f32,
    pixelRatio: f32,
    viewportWidth: f32,
    isSilhouettePass: bool,
    hasNormals: bool
) -> vec4<f32> {
    if (!isSilhouettePass || !hasNormals) {
        return positionClip;
    }

    var result = positionClip;
    let normal = normalize(normalMatrix * normalMC);
    let expandX = normal.x * projection[0][0];
    let expandY = normal.y * projection[1][1];
    result.x += expandX * result.w * silhouetteSize * pixelRatio / viewportWidth;
    result.y += expandY * result.w * silhouetteSize * pixelRatio / viewportWidth;
    return result;
}
