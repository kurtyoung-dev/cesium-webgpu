# WebGL to WebGPU API Mapping Analysis

**Created:** 2025-12-13  
**Purpose:** Document WebGL→WebGPU API equivalents and implementation status

---

## Overview

This document analyzes the WebGL compatibility stubs in `WebGPUContext.ts` to determine:
1. Whether WebGPU has true equivalents
2. What functionality we need to implement for parity
3. Current implementation status

**Key Principle:** The `_gl` stub object logs WebGL calls but doesn't execute them. We need **separate WebGPU APIs** that accomplish the same goals.

---

## 🎨 Texture Operations

### 1. activeTexture() - ❌ Not Needed in WebGPU

**WebGL:**
```javascript
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, texture);
```

**WebGPU Equivalent:**
```javascript
// No equivalent - WebGPU uses bind groups
// Textures are bound via bind group entries
const bindGroup = device.createBindGroup({
  layout: bindGroupLayout,
  entries: [{
    binding: 0,  // Replaces texture unit
    resource: textureView
  }]
});
```

**Status:** ✅ **Correct as-is** - WebGPU fundamentally doesn't use texture units
**Implementation:** Use bind groups (already implemented)

---

### 2. bindTexture() - ❌ Not Needed in WebGPU

**WebGL:**
```javascript
gl.bindTexture(gl.TEXTURE_2D, texture);
```

**WebGPU Equivalent:**
```javascript
// No binding - set in bind group instead
renderPass.setBindGroup(0, bindGroup);
```

**Status:** ✅ **Correct as-is** - WebGPU uses immutable bind groups
**Implementation:** Bind groups set in render pass (already implemented)

---

### 3. createTexture() - ✅ HAS WebGPU Equivalent

**WebGL:**
```javascript
const texture = gl.createTexture();
```

**WebGPU Equivalent:**
```javascript
const texture = device.createTexture({
  size: { width, height },
  format: 'rgba8unorm',
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
});
```

**Our Implementation:**
```javascript
WebGPUTexture.create2D(device, width, height, format, mipLevels);
WebGPUTexture.createCubeMap(device, size, format, mipLevels);
```

**Status:** ✅ **Already Implemented** in `WebGPUTexture.ts`
**Action Required:** ✅ None - working correctly

---

### 4. deleteTexture() - ✅ HAS WebGPU Equivalent

**WebGL:**
```javascript
gl.deleteTexture(texture);
```

**WebGPU Equivalent:**
```javascript
texture.destroy();
```

**Our Implementation:**
```javascript
webgpuTexture.destroy(); // Already implemented in WebGPUTexture
```

**Status:** ✅ **Already Implemented**
**Action Required:** ✅ None - working correctly

---

### 5. pixelStorei() - ⚠️ Partially Different

**WebGL:**
```javascript
gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
```

**WebGPU Equivalent:**
```javascript
// No global state - parameters passed to writeTexture
queue.writeTexture(
  { texture, origin, mipLevel },
  data,
  { 
    bytesPerRow: bytesPerRow,  // Replaces alignment
    rowsPerImage: height       // For 3D textures
  },
  { width, height }
);

// Flip Y and premultiply alpha must be done in data preparation
// OR use copyExternalImageToTexture with flipY option
queue.copyExternalImageToTexture(
  { source: imageBitmap, flipY: true },  // ✅ Has flipY option
  { texture },
  { width, height }
);
```

**Status:** ⚠️ **Needs Enhancement** - Need helper methods
**Action Required:** 
- ✅ Basic implementation exists (writeTexture)
- ⚠️ Add convenience methods for flip Y, premultiply alpha
- ⚠️ Document differences in texture upload workflow

---

### 6. texParameteri() - ✅ HAS WebGPU Equivalent (Different Design)

**WebGL:**
```javascript
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
```

**WebGPU Equivalent:**
```javascript
// Samplers are separate objects, not texture state
const sampler = device.createSampler({
  minFilter: 'linear',
  magFilter: 'linear',
  addressModeU: 'clamp-to-edge',
  addressModeV: 'clamp-to-edge'
});

// Bind sampler AND texture in bind group
const bindGroup = device.createBindGroup({
  layout: bindGroupLayout,
  entries: [
    { binding: 0, resource: textureView },  // Texture
    { binding: 1, resource: sampler }       // Sampler (separate!)
  ]
});
```

**Our Implementation:**
```javascript
context.getOrCreateSampler({
  minFilter: 'linear',
  magFilter: 'linear',
  addressModeU: 'clamp-to-edge',
  addressModeV: 'clamp-to-edge'
});
```

**Status:** ✅ **Already Implemented** - sampler cache exists
**Action Required:** ✅ None - architecture correct

**Key Difference:** WebGPU separates samplers from textures (better design)

---

### 7. texImage2D() - ✅ HAS WebGPU Equivalent

**WebGL:**
```javascript
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
```

**WebGPU Equivalent:**
```javascript
// Option 1: For typed array data
queue.writeTexture(
  { texture, mipLevel: 0 },
  data,  // Uint8Array, etc.
  { bytesPerRow: width * 4 },
  { width, height }
);

// Option 2: For image elements
queue.copyExternalImageToTexture(
  { source: imageElement },
  { texture },
  { width, height }
);
```

**Our Implementation:**
```javascript
webgpuTexture.write(data, width, height, face, mipLevel);
```

**Status:** ✅ **Already Implemented** in `WebGPUTexture.ts`
**Action Required:** ✅ None - working correctly

---

### 8. texSubImage2D() - ✅ HAS WebGPU Equivalent

**WebGL:**
```javascript
gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
```

**WebGPU Equivalent:**
```javascript
queue.writeTexture(
  { 
    texture, 
    mipLevel: 0,
    origin: { x, y, z: 0 }  // ✅ Has offset support
  },
  data,
  { bytesPerRow: width * 4 },
  { width, height }
);
```

**Our Implementation:**
```javascript
// Can be done with existing write() method by using origin parameter
queue.writeTexture({ texture, origin: {x, y} }, ...);
```

**Status:** ⚠️ **Needs Enhancement** - Add convenience method
**Action Required:**
- ✅ Capability exists (writeTexture supports origin)
- ⚠️ Add `webgpuTexture.writeRegion(data, x, y, width, height)` helper

---

### 9. compressedTexImage2D() - ✅ HAS WebGPU Equivalent

**WebGL:**
```javascript
gl.compressedTexImage2D(gl.TEXTURE_2D, 0, gl.COMPRESSED_RGBA_S3TC_DXT1_EXT, width, height, 0, data);
```

**WebGPU Equivalent:**
```javascript
// Create texture with compressed format
const texture = device.createTexture({
  size: { width, height },
  format: 'bc1-rgba-unorm',  // DXT1 equivalent
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
});

// Write compressed data
queue.writeTexture(
  { texture },
  compressedData,
  { 
    bytesPerRow: Math.ceil(width / 4) * 8,  // Block size dependent
    rowsPerImage: height 
  },
  { width, height }
);
```

**Our Implementation:**
```javascript
// Basic support exists, but need compression format helpers
WebGPUTexture.create2D(device, width, height, 'bc1-rgba-unorm', mipLevels);
```

**Status:** ⚠️ **Needs Enhancement**
**Action Required:**
- ✅ Basic compressed texture creation works
- ⚠️ Add format detection (S3TC → bc1, etc.)
- ⚠️ Add block size calculation helpers
- ⚠️ Document WebGPU compression format support

---

### 10. copyTexImage2D() - ✅ HAS WebGPU Equivalent

**WebGL:**
```javascript
gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, x, y, width, height, 0);
```

**WebGPU Equivalent:**
```javascript
// Copy from current render target to texture
commandEncoder.copyTextureToTexture(
  {
    texture: sourceTexture,
    origin: { x, y, z: 0 }
  },
  {
    texture: destTexture
  },
  { width, height }
);
```

**Our Implementation:**
```javascript
// Need to implement helper method
context.copyTexture(sourceTexture, destTexture, srcOrigin, destOrigin, size);
```

**Status:** ⚠️ **Missing** - Need to implement
**Action Required:**
- ❌ Create `WebGPUContext.copyTexture()` method
- ❌ Create `WebGPUContext.copyTextureRegion()` for partial copies

---

### 11. generateMipmap() - ❌ Different in WebGPU (By Design)

**WebGL:**
```javascript
gl.generateMipmap(gl.TEXTURE_2D);  // Automatic generation
```

**WebGPU Equivalent:**
```javascript
// WebGPU does NOT auto-generate mipmaps
// Must either:

// Option 1: Write each mip level manually
for (let mip = 0; mip < mipLevelCount; mip++) {
  const mipData = generateMipLevel(data, mip);
  queue.writeTexture({ texture, mipLevel: mip }, mipData, ...);
}

// Option 2: Use compute shader to generate (more efficient)
// ... implement custom mipmap generation pass

// Option 3: Use library (e.g., webgpu-utils generateMips)
```

**Our Implementation:**
```javascript
// Currently: Manual mip writing
// Future: Compute shader mipmap generation
```

**Status:** ⚠️ **Needs Implementation**
**Action Required:**
- ❌ Create `WebGPUTexture.generateMipmaps()` method
- ❌ Implement compute shader approach for performance
- ❌ Add CPU fallback for simple cases
- 📝 Document this significant API difference

**Note:** This is a **major difference** - WebGPU requires explicit mipmap management

---

## 🖼️ Framebuffer Operations

### 12. createFramebuffer() - ❌ Not Needed (Different Design)

**WebGL:**
```javascript
const fbo = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
```

**WebGPU Equivalent:**
```javascript
// No framebuffer objects - use render pass descriptors directly
const renderPassDescriptor = {
  colorAttachments: [{
    view: textureView,  // Directly specify texture
    loadOp: 'clear',
    storeOp: 'store'
  }]
};

const renderPass = encoder.beginRenderPass(renderPassDescriptor);
```

**Our Implementation:**
```javascript
// For off-screen rendering, use WebGPURenderTarget
const renderTarget = new WebGPURenderTarget(device, width, height, format);
const renderPass = encoder.beginRenderPass(renderTarget.getRenderPassDescriptor());
```

**Status:** ✅ **Already Implemented** - `WebGPURenderTarget.ts`
**Action Required:** ✅ None - WebGPU uses different (better) design

---

### 13. bindFramebuffer() - ❌ Not Needed (Different Design)

**WebGL:**
```javascript
gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
```

**WebGPU Equivalent:**
```javascript
// No binding - specify in render pass
const renderPass = encoder.beginRenderPass({
  colorAttachments: [{ view: textureView, ... }]
});
```

**Status:** ✅ **Correct as-is** - WebGPU uses render pass attachments
**Implementation:** Already handled in `beginFrame()` / render pass creation

---

### 14. framebufferTexture2D() - ❌ Not Needed (Different Design)

**WebGL:**
```javascript
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
```

**WebGPU Equivalent:**
```javascript
// Specify directly in render pass descriptor
const renderPassDescriptor = {
  colorAttachments: [{
    view: texture.createView(),  // Directly attach
    ...
  }]
};
```

**Status:** ✅ **Already Implemented** via `WebGPURenderTarget`
**Action Required:** ✅ None

---

### 15. checkFramebufferStatus() - ❌ Not Needed (Different Design)

**WebGL:**
```javascript
if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
  console.error('Framebuffer incomplete!');
}
```

**WebGPU Equivalent:**
```javascript
// WebGPU validates at pipeline creation time
// No runtime framebuffer status checking needed
// Errors are thrown immediately if configuration invalid
```

**Status:** ✅ **Correct as-is** - WebGPU validates differently
**Implementation:** Validation happens at pipeline/render pass creation

---

## 📋 Summary: Implementation Status

### ✅ Fully Implemented (7)
1. ✅ `activeTexture` - Not needed, use bind groups
2. ✅ `bindTexture` - Not needed, use bind groups
3. ✅ `createTexture` - `WebGPUTexture.create2D/createCubeMap`
4. ✅ `deleteTexture` - `texture.destroy()`
5. ✅ `texParameteri` - Separate samplers via `getOrCreateSampler()`
6. ✅ `texImage2D` - `webgpuTexture.write()`
7. ✅ `createFramebuffer/bindFramebuffer` - `WebGPURenderTarget`

### ⚠️ Needs Enhancement (3)
8. ⚠️ `pixelStorei` - Add flip Y / premultiply alpha helpers
9. ⚠️ `texSubImage2D` - Add `writeRegion()` convenience method
10. ⚠️ `compressedTexImage2D` - Add format detection & block size helpers

### ❌ Missing Implementation (2)
11. ❌ `copyTexImage2D` - Create `copyTexture()` method
12. ❌ `generateMipmap` - Create mipmap generation (compute shader)

---

## 🎯 Action Items

### Priority 1: Critical for Texture Support (2-3 hours)

#### 1.1 Implement Texture Copy Operations
```typescript
// Add to WebGPUContext.ts
copyTexture(
  source: GPUTexture,
  destination: GPUTexture,
  sourceOrigin?: GPUOrigin3D,
  destinationOrigin?: GPUOrigin3D,
  size?: GPUExtent3D
): void {
  if (!this._currentCommandEncoder) {
    throw new Error('No active command encoder');
  }
  
  this._currentCommandEncoder.copyTextureToTexture(
    { texture: source, origin: sourceOrigin },
    { texture: destination, origin: destinationOrigin },
    size ?? { width: source.width, height: source.height }
  );
}
```

#### 1.2 Implement Mipmap Generation
```typescript
// Add to WebGPUTexture.ts
generateMipmaps(): void {
  // Implement compute shader-based mipmap generation
  // OR CPU-based downsampling for initial implementation
}
```

### Priority 2: Convenience Methods (1-2 hours)

#### 2.1 Add Texture Region Update
```typescript
// Add to WebGPUTexture.ts
writeRegion(
  data: BufferSource,
  x: number, y: number,
  width: number, height: number,
  mipLevel: number = 0
): void {
  this._device.queue.writeTexture(
    { texture: this._texture, mipLevel, origin: { x, y } },
    data,
    { bytesPerRow: width * this._bytesPerPixel },
    { width, height }
  );
}
```

#### 2.2 Add Pixel Store Helpers
```typescript
// Add to WebGPUTexture.ts or utility module
static flipYData(data: Uint8Array, width: number, height: number, bytesPerPixel: number): Uint8Array {
  const flipped = new Uint8Array(data.length);
  const bytesPerRow = width * bytesPerPixel;
  
  for (let y = 0; y < height; y++) {
    const srcRow = y * bytesPerRow;
    const dstRow = (height - 1 - y) * bytesPerRow;
    flipped.set(data.subarray(srcRow, srcRow + bytesPerRow), dstRow);
  }
  
  return flipped;
}

static premultiplyAlpha(data: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    result[i] = data[i] * a;
    result[i + 1] = data[i + 1] * a;
    result[i + 2] = data[i + 2] * a;
    result[i + 3] = data[i + 3];
  }
  return result;
}
```

### Priority 3: Compressed Texture Support (2-3 hours)

#### 3.1 Format Detection Helper
```typescript
// Add to WebGPUTexture.ts
static getWebGPUCompressionFormat(webglFormat: number): GPUTextureFormat | null {
  const formatMap = {
    // S3TC / DXT
    0x83F1: 'bc1-rgba-unorm',  // COMPRESSED_RGBA_S3TC_DXT1_EXT
    0x83F2: 'bc2-rgba-unorm',  // COMPRESSED_RGBA_S3TC_DXT3_EXT
    0x83F3: 'bc3-rgba-unorm',  // COMPRESSED_RGBA_S3TC_DXT5_EXT
    // BC7
    0x8E8C: 'bc7-rgba-unorm',  // COMPRESSED_RGBA_BPTC_UNORM
    // Add more as needed
  };
  return formatMap[webglFormat] || null;
}

static getBlockSize(format: GPUTextureFormat): number {
  // Return bytes per block for compressed formats
  const blockSizes = {
    'bc1-rgba-unorm': 8,
    'bc2-rgba-unorm': 16,
    'bc3-rgba-unorm': 16,
    'bc7-rgba-unorm': 16,
  };
  return blockSizes[format] ?? 0;
}
```

---

## 📊 Compatibility Matrix

| WebGL Function | WebGPU Equivalent | Status | Notes |
|---|---|---|---|
| `activeTexture` | Bind groups | ✅ | Fundamental API difference |
| `bindTexture` | Bind groups | ✅ | Fundamental API difference |
| `createTexture` | `device.createTexture` | ✅ | Implemented |
| `deleteTexture` | `texture.destroy` | ✅ | Implemented |
| `pixelStorei` | writeTexture params | ⚠️ | Need helpers |
| `texParameteri` | Separate samplers | ✅ | Different design |
| `texImage2D` | `queue.writeTexture` | ✅ | Implemented |
| `texSubImage2D` | writeTexture + origin | ⚠️ | Need helper |
| `compressedTexImage2D` | writeTexture | ⚠️ | Need format helpers |
| `copyTexImage2D` | `copyTextureToTexture` | ❌ | Missing |
| `generateMipmap` | Manual / compute | ❌ | Missing |
| `createFramebuffer` | Render pass | ✅ | Different design |
| `bindFramebuffer` | Render pass | ✅ | Different design |
| `framebufferTexture2D` | Attachment | ✅ | Different design |

---

## 🎓 Key Insights

### 1. Many "No Equivalents" Are Actually Better Designs
WebGPU eliminates problematic WebGL patterns:
- **No texture binding** → Immutable bind groups (better performance)
- **No framebuffer objects** → Direct render pass attachments (simpler)
- **Separate samplers** → Reusable sampler objects (more efficient)

### 2. Some Operations Require More Explicit Code
WebGPU requires explicit handling of:
- **Mipmap generation** (no auto-generation)
- **Pixel store operations** (no global state)
- **Compressed texture block sizes** (manual calculation)

### 3. Our Current Implementation is ~80% Complete
- ✅ Core texture operations work
- ✅ Framebuffer equivalent (WebGPURenderTarget) exists
- ⚠️ Missing convenience methods
- ❌ Missing mipmap generation

---

## 🚀 Recommendation

### Answer to User's Question:
**"Is there really no WebGPU equivalent?"**

**Answer:** There ARE WebGPU equivalents, but they work differently:

1. **7 operations** are correctly stubbed - WebGPU uses different (better) patterns
2. **3 operations** need enhancement - add convenience methods
3. **2 operations** are missing - need implementation (copy, mipmaps)

### The stubs are CORRECT for their purpose:
- ✅ Prevent crashes when legacy WebGL code runs
- ✅ Log what's being called for debugging
- ✅ Point developers to WebGPU alternatives

### But we DO need actual WebGPU implementations:
- ✅ **Already have:** WebGPUTexture class with create/write/destroy
- ⚠️ **Need to add:** Convenience methods for common operations
- ❌ **Missing:** Texture copying and mipmap generation

---

## 📝 Next Steps

### Immediate Action (if needed):
1. Implement `WebGPUContext.copyTexture()` - **30 minutes**
2. Implement `WebGPUTexture.generateMipmaps()` - **2-3 hours**
3. Add convenience methods (writeRegion, flipY, etc.) - **1 hour**

### Or Continue with Primitives:
The missing operations are **not blockers** for basic primitive rendering:
- Texture copying is for advanced effects
- Mipmap generation is for quality (can defer)
- Convenience methods are nice-to-have

**Recommendation:** Continue with Phase 4.8 (primitives), then circle back to complete texture operations when needed.

---

## ✅ Conclusion

**Yes, we DO need WebGPU equivalents for parity.**

**But:** The current stubs are **correct** for their purpose. They:
1. Prevent crashes from legacy code
2. Guide developers to WebGPU patterns
3. Log usage for debugging

**Action:** Implement the 2 missing operations (copy, mipmaps) when needed for primitives/materials.

**Current Priority:** Phase 4.8 (primitive rendering) is more critical. Texture operations can be enhanced incrementally as features require them.
