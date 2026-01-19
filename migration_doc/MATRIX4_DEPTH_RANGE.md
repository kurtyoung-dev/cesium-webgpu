# Matrix4 Renderer-Aware Depth Range Adaptation

## Overview

CesiumJS's `Matrix4` class now includes renderer-aware depth range support to handle the fundamental difference between WebGL and WebGPU projection matrices.

## The Problem

**WebGL/OpenGL** and **WebGPU** use different depth ranges in Normalized Device Coordinates (NDC):

| Renderer | NDC Depth Range | Description |
|----------|----------------|-------------|
| **WebGL/OpenGL** | **-1 to +1** | Traditional graphics API convention |
| **WebGPU/Metal/DirectX** | **0 to 1** | Modern graphics API convention |

This difference affects **all projection matrices** (perspective and orthographic).

## The Solution: Renderer-Aware Matrix4

Instead of creating separate matrix classes or functions for WebGL and WebGPU, we made the existing `Matrix4` class renderer-aware using a global state flag.

### Implementation

```javascript
// In Matrix4.js

/**
 * The current depth range type used for projection matrices.
 * @private
 * @type {string}
 * @default 'webgl'
 */
Matrix4._depthRangeType = 'webgl';

/**
 * Sets the depth range type for projection matrix calculations.
 * @param {string} type - Either 'webgl' or 'webgpu'
 * @private
 */
Matrix4.setDepthRangeType = function(type) {
  Matrix4._depthRangeType = type;
};
```

### Affected Functions

The following `Matrix4` functions now adapt based on `_depthRangeType`:

1. **`Matrix4.computePerspectiveFieldOfView()`**
2. **`Matrix4.computePerspectiveOffCenter()`**
3. **`Matrix4.computeOrthographicOffCenter()`**
4. **`Matrix4.computeInfinitePerspectiveOffCenter()`**

### Projection Formula Differences

#### Perspective Projection

**WebGL (depth: -1 to 1):**
```javascript
column2Row2 = (far + near) / (near - far);
column3Row2 = (2.0 * far * near) / (near - far);
```

**WebGPU (depth: 0 to 1):**
```javascript
column2Row2 = far / (near - far);
column3Row2 = (near * far) / (near - far);
```

#### Orthographic Projection

**WebGL (depth: -1 to 1):**
```javascript
c = 1.0 / (far - near);
tz = -(far + near) * c;
c *= -2.0;  // Scale coefficient
```

**WebGPU (depth: 0 to 1):**
```javascript
c = 1.0 / (far - near);
tz = -near * c;
c *= -1.0;  // Scale coefficient (simpler)
```

## Usage

### For Renderer Implementations

When initializing a renderer, set the appropriate depth range type:

```javascript
// In WebGPUContext constructor/initialization
import Matrix4 from '../Core/Matrix4.js';

class WebGPUContext {
  constructor() {
    // ... WebGPU initialization ...
    
    // Set Matrix4 to use WebGPU depth range
    Matrix4.setDepthRangeType('webgpu');
  }
}
```

```javascript
// In WebGL Context (if needed to explicitly set)
Matrix4.setDepthRangeType('webgl');  // This is the default
```

### For Application Code

**No changes required!** Existing code continues to work transparently:

```javascript
// This code works for BOTH WebGL and WebGPU
const projectionMatrix = new Cesium.Matrix4();
Cesium.Matrix4.computePerspectiveFieldOfView(
  Cesium.Math.toRadians(45),
  canvas.width / canvas.height,
  0.1,
  100.0,
  projectionMatrix
);
```

The projection matrix will automatically use the correct formulas based on which renderer is active.

## Benefits

1. **Zero Breaking Changes**: Existing CesiumJS code works without modification
2. **Transparent Adaptation**: Renderer choice automatically determines correct math
3. **Single Source of Truth**: No duplicate matrix implementations
4. **Maintainable**: Changes to matrix functions apply to both renderers
5. **Testable**: Can easily switch modes for testing

## Testing

A standalone test is available at:
```
Apps/WebGPUTest/matrix-depth-range-standalone.html
```

This test verifies:
- ✅ WebGL formulas produce correct -1 to 1 depth range matrices
- ✅ WebGPU formulas produce correct 0 to 1 depth range matrices
- ✅ XY scaling is identical (independent of depth range)
- ✅ Z coefficients are different (as required)
- ✅ Switching between modes works correctly

## Implementation Details

### Why Global State?

We chose global state (`Matrix4._depthRangeType`) over alternatives because:

1. **Simplicity**: One renderer is active at a time per application instance
2. **Performance**: No parameter passing overhead in hot code paths
3. **Compatibility**: Zero API changes to existing Matrix4 functions
4. **Clarity**: Explicit renderer initialization makes intent clear

### Alternative Approaches Considered

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Global State** (chosen) | Zero API changes, performant, simple | Global state | ✅ **Selected** - Best balance |
| **Optional Parameter** | Explicit, no globals | API changes, parameter passing | ❌ Rejected - Breaking changes |
| **Separate WebGPUMatrix Class** | Clear separation | Code duplication, maintenance burden | ❌ Rejected - Violates DRY |
| **Context-based** | Object-oriented | Requires context threading | ❌ Rejected - Too invasive |

## Future Considerations

### When Scene Initialization Occurs

When the WebGPU renderer is integrated into `Scene`, the initialization sequence will be:

```javascript
// In Scene.js or equivalent
if (options.renderer === 'webgpu') {
  Matrix4.setDepthRangeType('webgpu');
  this._context = new WebGPUContext(canvas, options);
} else {
  Matrix4.setDepthRangeType('webgl');  // Explicit, though it's the default
  this._context = new WebGLContext(canvas, options);
}
```

### Thread Safety

Since JavaScript is single-threaded and only one renderer can be active per application instance, there are no threading concerns with the global state approach.

### Testing Strategy

- Unit tests should test both depth range modes
- Integration tests should verify correct mode is set during initialization
- Existing tests should continue to pass (WebGL mode is default)

## Related Files

- **Core Implementation**: `packages/engine/Source/Core/Matrix4.js`
- **WebGPU Context**: `packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts` (to be updated)
- **Test Files**: 
  - `Apps/WebGPUTest/matrix-depth-range-standalone.html`
  - `Apps/WebGPUTest/matrix4-depth-test.html` (requires build)

## References

- **WebGPU Spec**: https://www.w3.org/TR/webgpu/#coordinate-systems
- **OpenGL Spec**: Uses -1 to 1 depth range historically
- **wgpu-matrix Library**: Reference implementation we validated against

---

**Status**: ✅ Implemented
**Phase**: 4.4 - Camera & View Integration
**Date**: December 2025
