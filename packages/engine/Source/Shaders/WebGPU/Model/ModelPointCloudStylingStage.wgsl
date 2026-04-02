/**
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
