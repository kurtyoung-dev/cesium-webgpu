/**
 * Normal map sampling and TBN matrix construction
 * Requires tangent and bitangent vectors from the vertex shader
 * 
 * @chunk functions/csm_getNormalFromMap
 */

fn csm_getNormalFromMap(
    normalSample: vec3<f32>,
    normalScale: f32,
    vertexNormal: vec3<f32>,
    vertexTangent: vec3<f32>,
    vertexBitangent: vec3<f32>,
) -> vec3<f32> {
    // Convert from [0,1] to [-1,1] and apply scale
    let tangentNormal = normalSample * 2.0 - 1.0;
    let scaledNormal = vec3<f32>(tangentNormal.xy * normalScale, tangentNormal.z);

    // Build TBN matrix
    let N = normalize(vertexNormal);
    let T = normalize(vertexTangent);
    let B = normalize(vertexBitangent);
    let TBN = mat3x3<f32>(T, B, N);

    // Transform to world space
    return normalize(TBN * scaledNormal);
}

// Simplified version that constructs TBN from normal and tangent (with handedness)
fn csm_getNormalFromMapSimple(
    normalSample: vec3<f32>,
    normalScale: f32,
    vertexNormal: vec3<f32>,
    vertexTangent: vec4<f32>,  // w component is handedness
) -> vec3<f32> {
    let tangentNormal = normalSample * 2.0 - 1.0;
    let scaledNormal = vec3<f32>(tangentNormal.xy * normalScale, tangentNormal.z);

    let N = normalize(vertexNormal);
    let T = normalize(vertexTangent.xyz);
    let B = cross(N, T) * vertexTangent.w;
    let TBN = mat3x3<f32>(T, B, N);

    return normalize(TBN * scaledNormal);
}
