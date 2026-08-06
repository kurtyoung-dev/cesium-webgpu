uniform highp sampler2D u_vectorSegmentTexture;
uniform highp sampler2D u_vectorWidthTexture;
uniform highp sampler2D u_vectorColorTexture;
uniform highp sampler2D u_vectorSegmentPrimitiveIndicesTexture;
uniform highp sampler2D u_vectorGridCellIndicesTexture;

// UV-space offset from the closest point on the segment to p.
vec2 vectorOffsetToLine(vec2 p, vec4 line)
{
    vec2 a = line.xy;
    vec2 b = line.zw;
    vec2 ab = b - a;
    float abLengthSquared = dot(ab, ab);
    if (abLengthSquared < 1.0e-8)
    {
        return p - a;
    }
    float t = clamp(dot(p - a, ab) / abLengthSquared, 0.0, 1.0);
    return p - (a + t * ab);
}

ivec2 vectorIndexToUv(int index, ivec2 size)
{
    int v = index / size.x;
    int u = index - v * size.x;
    return ivec2(u, v);
}

// Drape clamped vector polylines onto the terrain surface. The fragment's
// tile UV picks a grid cell, then only that cell's line segments (packed in
// tile-local UV space) are tested for proximity. Within the line width, the
// vector color is alpha-composited over the terrain (no discard).
vec4 vectorPolylineRender(vec2 vectorUv, vec4 baseColor)
{
    // Inverse UV-per-pixel Jacobian: measures line distance in screen pixels so
    // width stays constant under anisotropic (oblique) foreshortening.
    //
    // A SINGULAR Jacobian has no inverse, so there is no pixel-space distance
    // and no line can be in range. Terrain SKIRT quads are exactly that case on
    // every tile: `HeightmapTessellator` derives a skirt vertex's u/v from the
    // UNMOVED edge longitude/latitude, so a north/south skirt carries a
    // bit-identical `v` at all four corners of every quad and the determinant
    // is exactly zero. `inverse()` is UNDEFINED there — it happens to divide by
    // zero and produce Inf/NaN, which makes the comparison below false and
    // drapes nothing, but that is the driver's choice, not this shader's. Say
    // it explicitly so the two backends agree by construction: the WGSL twin
    // has no `inverse()` builtin, and its hand-rolled substitute returning a
    // zero matrix for this case painted the whole skirt ring
    // (NEW-WEBGPU-VECTOR-DRAPING-HORIZONTAL-STREAKS).
    mat2 uvJacobian = mat2(dFdx(vectorUv), dFdy(vectorUv));
    float uvJacobianDet = uvJacobian[0].x * uvJacobian[1].y - uvJacobian[1].x * uvJacobian[0].y;
    if (abs(uvJacobianDet) < 1.0e-20)
    {
        return baseColor;
    }
    mat2 screenFromUv = inverse(uvJacobian);
    int gridWidth = int(texelFetch(u_vectorGridCellIndicesTexture, ivec2(0, 0), 0).r);
    int gridHeight = int(texelFetch(u_vectorGridCellIndicesTexture, ivec2(1, 0), 0).r);
    int cellX = clamp(int(vectorUv.x * float(gridWidth)), 0, gridWidth - 1);
    int cellY = clamp(int(vectorUv.y * float(gridHeight)), 0, gridHeight - 1);
    int cellIndex = cellX + cellY * gridWidth;

    int indexEnd = int(texelFetch(u_vectorGridCellIndicesTexture, ivec2(cellIndex + 2, 0), 0).r);
    int indexStart = cellIndex == 0
        ? 0
        : int(texelFetch(u_vectorGridCellIndicesTexture, ivec2(cellIndex + 1, 0), 0).r);

    ivec2 segmentTextureSize = textureSize(u_vectorSegmentTexture, 0);
    ivec2 primitiveTextureSize = textureSize(u_vectorWidthTexture, 0);

    for (int i = indexStart; i < indexEnd; i++)
    {
        ivec2 segmentUv = vectorIndexToUv(i, segmentTextureSize);
        vec4 segment = texelFetch(u_vectorSegmentTexture, segmentUv, 0);

        int primitiveIndex = int(texelFetch(u_vectorSegmentPrimitiveIndicesTexture, segmentUv, 0).r);
        ivec2 primitiveUv = vectorIndexToUv(primitiveIndex, primitiveTextureSize);

        float lineWidth = texelFetch(u_vectorWidthTexture, primitiveUv, 0).r * 255.0;

        vec2 offsetUv = vectorOffsetToLine(vectorUv, segment);
        if (length(screenFromUv * offsetUv) < lineWidth)
        {
            // Alpha-composite vector over terrain.
            vec4 vectorColor = texelFetch(u_vectorColorTexture, primitiveUv, 0);
            baseColor = vectorColor * vec4(vectorColor.aaa, 1.0) + baseColor * (1.0 - vectorColor.a);
            break;
        }
    }

    return baseColor;
}
