// Model Splitter Stage — WGSL equivalent of ModelSplitterStageFS.glsl
// Implements scene split for before/after comparison.
// Don't split when rendering shadow maps.

fn modelSplitterStageFS(
    fragCoordX: f32,
    splitDirection: f32,
    splitPosition: f32,
    isShadowMap: bool
) -> bool {
    if (isShadowMap) {
        return false; // Don't discard in shadow map
    }
    if (splitDirection < 0.0 && fragCoordX > splitPosition) {
        return true; // discard
    }
    if (splitDirection > 0.0 && fragCoordX < splitPosition) {
        return true; // discard
    }
    return false;
}
