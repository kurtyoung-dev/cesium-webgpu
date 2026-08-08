uniform highp sampler2D u_vectorSegmentTexture;
uniform highp sampler2D u_vectorWidthTexture;
uniform highp sampler2D u_vectorColorTexture;
uniform highp sampler2D u_vectorSegmentPrimitiveIndicesTexture;
uniform highp sampler2D u_vectorGridCellIndicesTexture;
uniform highp sampler2D u_vectorPolygonEdgeTexture;
uniform highp sampler2D u_vectorPolygonEdgePrimitiveIndicesTexture;
uniform highp sampler2D u_vectorPolygonGridCellIndicesTexture;

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

// Largest UV-Jacobian condition number (ratio of singular values) this shader
// will still invert. Above it the matrix carries no usable pixel metric and the
// fragment is abandoned. See `vectorPolylineRender` for why an exactly-zero
// determinant is not a sufficient test. Must match
// `GlobeTerrain.wgsl::VECTOR_UV_JACOBIAN_MAX_CONDITION`.
const float VECTOR_UV_JACOBIAN_MAX_CONDITION = 1.0e3;

// Drape clamped vector polylines onto the terrain surface. The fragment's
// tile UV picks a grid cell, then only that cell's line segments (packed in
// tile-local UV space) are tested for proximity. Within the line width, the
// vector color is alpha-composited over the terrain (no discard).
vec4 vectorPolylineRender(vec2 vectorUv, vec4 baseColor)
{
    // A tile without polylines binds a 1x1 placeholder; a real grid header
    // [gridWidth, gridHeight, ...] is at least 3 texels.
    ivec2 headerSize = textureSize(u_vectorGridCellIndicesTexture, 0);
    if (headerSize.x * headerSize.y < 3)
    {
        return baseColor;
    }

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
    //
    // An exactly-zero determinant is NOT a sufficient test, which is what
    // NEW-WEBGL-VECTOR-DRAPING-RESIDUAL-EXTENT turned out to be. The shader
    // never sees the skirt's exact algebra; it sees `dFdx`/`dFdy` of a
    // PERSPECTIVE-INTERPOLATED varying. Interpolating a bit-identical attribute
    // still divides by the interpolated 1/w, so the recovered `v` lands within
    // an ulp or so of the edge value rather than on it, and on a skirt seen
    // edge-on (nadir) the quad's screen footprint collapses, which amplifies
    // that residue AND inflates the `u` derivatives. The determinant is then
    // small-but-nonzero, the guard above lets it through, and the inverted
    // matrix reports a pixel distance far shorter than the true one — the
    // fragment gets painted with a segment tens or hundreds of pixels away.
    //
    // So reject on the CONDITION NUMBER instead, which is what "this matrix
    // carries no usable pixel metric" actually means. For a 2x2,
    // ‖M‖_F² = σmax² + σmin² and |det| = σmax·σmin, so ‖M‖_F² / |det| is
    // exactly κ + 1/κ — a scale-invariant, sqrt-free read of the conditioning
    // that no tile size, zoom level or line width can shift. A skirt lands in
    // the 1e4..1e6 band because its small singular value is pure interpolation
    // residue; legitimate grazing foreshortening on a drawn tile stays under
    // ~100 (past ~1e3 the tile is thinner than a pixel and has nothing to
    // drape). The first term still catches the exactly-singular case, including
    // the all-zero matrix that the ratio test cannot see.
    mat2 uvJacobian = mat2(dFdx(vectorUv), dFdy(vectorUv));
    float uvJacobianDet = uvJacobian[0].x * uvJacobian[1].y - uvJacobian[1].x * uvJacobian[0].y;
    float uvJacobianNormSquared = dot(uvJacobian[0], uvJacobian[0]) + dot(uvJacobian[1], uvJacobian[1]);
    if (abs(uvJacobianDet) < 1.0e-20 ||
        uvJacobianNormSquared > VECTOR_UV_JACOBIAN_MAX_CONDITION * abs(uvJacobianDet))
    {
        return baseColor;
    }
    mat2 screenFromUv = inverse(uvJacobian);
    int gridWidth = int(texelFetch(u_vectorGridCellIndicesTexture, vectorIndexToUv(0, headerSize), 0).r);
    int gridHeight = int(texelFetch(u_vectorGridCellIndicesTexture, vectorIndexToUv(1, headerSize), 0).r);
    int cellX = clamp(int(vectorUv.x * float(gridWidth)), 0, gridWidth - 1);
    int cellY = clamp(int(vectorUv.y * float(gridHeight)), 0, gridHeight - 1);
    int cellIndex = cellX + cellY * gridWidth;

    // Cell end offsets follow the two gridWidth/gridHeight texels, so cell
    // N's end is at texel N + 2. A cell's start is the previous cell's end
    // (texel N + 1); cell 0's start is implicitly 0.
    int indexEnd = int(texelFetch(u_vectorGridCellIndicesTexture, vectorIndexToUv(cellIndex + 2, headerSize), 0).r);
    int indexStart = cellIndex == 0
        ? 0
        : int(texelFetch(u_vectorGridCellIndicesTexture, vectorIndexToUv(cellIndex + 1, headerSize), 0).r);

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

// Composites a polygon's fill over baseColor when the pixel is inside it. A
// negative index (empty cell or first iteration) or an outside pixel is a
// no-op.
vec4 vectorCompositePolygonFill(vec4 baseColor, int primitiveIndex, bool inside, ivec2 primitiveTextureSize)
{
    if (!inside || primitiveIndex < 0)
    {
        return baseColor;
    }

    ivec2 primitiveUv = vectorIndexToUv(primitiveIndex, primitiveTextureSize);
    vec4 fillColor = texelFetch(u_vectorColorTexture, primitiveUv, 0);
    return fillColor * vec4(fillColor.aaa, 1.0) + baseColor * (1.0 - fillColor.a);
}

// True if a horizontal +x ray from p crosses the edge. The half-open interval
// (> vs <=) counts a ray through a shared vertex exactly once.
bool vectorEdgeCrossesRay(vec4 edge, vec2 p)
{
    if ((edge.y > p.y) == (edge.w > p.y))
    {
        return false;
    }

    float t = (p.y - edge.y) / (edge.w - edge.y);
    float xIntersect = edge.x + t * (edge.z - edge.x);
    return p.x < xIntersect;
}

// Drape clamped vector polygon fills onto the terrain surface. The fragment's
// tile UV picks a grid cell whose edges were clipped to the cell on the CPU,
// forming closed loops, so an even-odd horizontal ray cast within the cell
// decides coverage. Edges arrive grouped by primitive; each covering
// primitive's fill color is alpha-composited in primitive order (no discard).
vec4 vectorPolygonRender(vec2 vectorUv, vec4 baseColor)
{
    // A tile without polygons binds a 1x1 placeholder; a real grid header
    // [gridWidth, gridHeight, ...] is at least 3 texels.
    ivec2 headerSize = textureSize(u_vectorPolygonGridCellIndicesTexture, 0);
    if (headerSize.x * headerSize.y < 3)
    {
        return baseColor;
    }

    int gridWidth = int(texelFetch(u_vectorPolygonGridCellIndicesTexture, vectorIndexToUv(0, headerSize), 0).r);
    int gridHeight = int(texelFetch(u_vectorPolygonGridCellIndicesTexture, vectorIndexToUv(1, headerSize), 0).r);
    int cellX = clamp(int(vectorUv.x * float(gridWidth)), 0, gridWidth - 1);
    int cellY = clamp(int(vectorUv.y * float(gridHeight)), 0, gridHeight - 1);
    int cellIndex = cellX + cellY * gridWidth;

    // Cell end offsets follow the two gridWidth/gridHeight texels, so cell
    // N's end is at texel N + 2. A cell's start is the previous cell's end
    // (texel N + 1); cell 0's start is implicitly 0.
    int indexEnd = int(texelFetch(u_vectorPolygonGridCellIndicesTexture, vectorIndexToUv(cellIndex + 2, headerSize), 0).r);
    int indexStart = cellIndex == 0
        ? 0
        : int(texelFetch(u_vectorPolygonGridCellIndicesTexture, vectorIndexToUv(cellIndex + 1, headerSize), 0).r);

    ivec2 edgeTextureSize = textureSize(u_vectorPolygonEdgeTexture, 0);
    ivec2 primitiveTextureSize = textureSize(u_vectorColorTexture, 0);

    int currentPrimitive = -1;
    bool inside = false;

    for (int i = indexStart; i < indexEnd; i++)
    {
        ivec2 edgeUv = vectorIndexToUv(i, edgeTextureSize);
        vec4 edge = texelFetch(u_vectorPolygonEdgeTexture, edgeUv, 0);
        int primitiveIndex = int(texelFetch(u_vectorPolygonEdgePrimitiveIndicesTexture, edgeUv, 0).r);

        // A new primitive means the previous group is complete: composite it,
        // then start counting the new one fresh.
        if (primitiveIndex != currentPrimitive)
        {
            baseColor = vectorCompositePolygonFill(baseColor, currentPrimitive, inside, primitiveTextureSize);
            currentPrimitive = primitiveIndex;
            inside = false;
        }

        if (vectorEdgeCrossesRay(edge, vectorUv))
        {
            inside = !inside;
        }
    }

    // The last primitive group has no trailing edge to trigger its composite.
    baseColor = vectorCompositePolygonFill(baseColor, currentPrimitive, inside, primitiveTextureSize);

    return baseColor;
}
