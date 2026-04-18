/**
 * GPU-side decode helpers for `GeometryPipeline.compressVertices` input.
 *
 * When a Primitive's geometry has `compressVertices: true` (the default),
 * the CPU pipeline replaces the original `normal` / `st` / `tangent` /
 * `bitangent` float attributes with a single `compressedAttributes` slot
 * carrying oct-packed normals + bit-packed UVs. See
 * `Core/AttributeCompression.js` for the JS mirror of these routines.
 *
 * Per-vertex layout (from `Core/GeometryPipeline.js:1558-1615`):
 *
 *   slot[0] — compressTextureCoordinates(st)    when hasSt
 *   slot[1] — octPack(normal, tangent, bitangent)  when all-three present
 *             OR octEncodeFloat(normal)          when only normal present
 *             OR octEncodeFloat(tangent)         when only tangent present
 *             OR octEncodeFloat(bitangent)       when only bitangent present
 *
 * The number of occupied slots (1..3) is baked into the material shader's
 * vertex input layout via the `@location(N) compressedAttributes: vecN<f32>`
 * declaration; the vertex stage calls the helpers below to pull normals /
 * UVs / tangent / bitangent out of those slots, substituting fall-throughs
 * when a component isn't present.
 *
 * CPU and GPU decodes MUST produce byte-identical results — the CPU
 * path in `WebGPUPrimitiveCommands.ensureUncompressedAttributes` is the
 * reference. If you change these functions, re-run the visual regression
 * harness with at least one compressed primitive.
 *
 * @chunk functions/csm_decodeCompressedVertex
 */

// ─── Oct-encoded unit vector → vec3<f32> (single-slot variant) ───
// Mirror of AttributeCompression.octDecodeFloat (Cigolle et al.).
//
// Input: a single f32 in [0, 65535] where the high byte encodes the X
// snorm [0,255] and the low byte encodes the Y snorm [0,255].
fn csm_octDecodeFloat_single(value: f32) -> vec3<f32> {
    let temp = value / 256.0;
    let x = floor(temp);
    let y = (temp - x) * 256.0;
    let e = vec2<f32>(x, y) / 255.0 * 2.0 - 1.0;
    var v = vec3<f32>(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
    if (v.z < 0.0) {
        let s = vec2<f32>(
            select(-1.0, 1.0, v.x >= 0.0),
            select(-1.0, 1.0, v.y >= 0.0),
        );
        v = vec3<f32>((1.0 - abs(v.yx)) * s, v.z);
    }
    return normalize(v);
}

// ─── Oct-packed triple → (normal, tangent, bitangent) ───
// Mirror of AttributeCompression.octUnpack.
//
// Input: a vec2<f32> where each lane stores:
//   packed.x = 65536 * snormX + octEncodeFloat(v1)
//   packed.y = 65536 * snormY + octEncodeFloat(v2)
// (v1 = normal, v2 = tangent, v3 = bitangent — recovered from the
// high 16 bits across the two lanes.)
struct CompressedTriple {
    normal: vec3<f32>,
    tangent: vec3<f32>,
    bitangent: vec3<f32>,
}

fn csm_octUnpack(packed: vec2<f32>) -> CompressedTriple {
    var tempX = packed.x / 65536.0;
    let xHigh = floor(tempX);
    let encoded1 = (tempX - xHigh) * 65536.0;

    var tempY = packed.y / 65536.0;
    let yHigh = floor(tempY);
    let encoded2 = (tempY - yHigh) * 65536.0;

    // Normal / tangent come from the low 16 bits of each lane.
    let n = csm_octDecodeFloat_single(encoded1);
    let t = csm_octDecodeFloat_single(encoded2);

    // Bitangent comes from the high 16 bits recomposed as a single oct
    // pair (xHigh = snormX in [0,255], yHigh = snormY in [0,255]).
    let e = vec2<f32>(xHigh, yHigh) / 255.0 * 2.0 - 1.0;
    var b = vec3<f32>(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
    if (b.z < 0.0) {
        let s = vec2<f32>(
            select(-1.0, 1.0, b.x >= 0.0),
            select(-1.0, 1.0, b.y >= 0.0),
        );
        b = vec3<f32>((1.0 - abs(b.yx)) * s, b.z);
    }
    let bn = normalize(b);

    var out: CompressedTriple;
    out.normal = n;
    out.tangent = t;
    out.bitangent = bn;
    return out;
}

// ─── 12-bit × 2 packed UVs → vec2<f32> in [0,1] ───
// Mirror of AttributeCompression.decompressTextureCoordinates.
//
// Input: a single f32 storing `4096 * xIntQ12 + yIntQ12`.
fn csm_decompressTextureCoordinates(compressed: f32) -> vec2<f32> {
    let temp = compressed / 4096.0;
    let xInt = floor(temp);
    let x = xInt / 4095.0;
    let y = (compressed - xInt * 4096.0) / 4095.0;
    return vec2<f32>(x, y);
}
