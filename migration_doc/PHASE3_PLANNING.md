# Phase 3: Scene & Rendering Pipeline - Planning Document

## 🎯 Challenge

**The Core Problem:**
- Scene constructor is **synchronous** (for backward compatibility)
- WebGPU initialization is **async** (requires await for device/adapter)
- ContextFactory.createContext() is **async**
- We CANNOT break existing synchronous Scene API

## 📋 Current Initialization Flow

```javascript
// CesiumWidget.js (synchronous)
const scene = new Scene({
  canvas: canvas,
  contextOptions: options.contextOptions,
  // ... other options
});

// Scene.js (synchronous)
function Scene(options) {
  const contextOptions = clone(options.contextOptions);
  this._context = new Context(canvas, contextOptions);  // SYNCHRONOUS
  // ... rest of initialization
}
```

## 🔧 Solution Options

### Option 1: Hybrid Initialization (RECOMMENDED)
**Keep Scene synchronous, initialize WebGPU in background**

```javascript
// Scene.js
function Scene(options) {
  // Start with WebGL synchronously (backward compatible)
  this._context = new Context(canvas, contextOptions);
  
  // If WebGPU requested, upgrade async in background
  if (contextOptions.renderer === 'webgpu') {
    this._upgradeToWebGPU(canvas, contextOptions);
  }
}

Scene.prototype._upgradeToWebGPU = async function(canvas, options) {
  try {
    const webgpuContext = await ContextFactory.createContext(canvas, {
      ...options,
      renderer: 'webgpu'
    });
    
    // Swap contexts (this needs careful state migration)
    this._migrateToNewContext(webgpuContext);
  } catch (error) {
    console.warn('WebGPU upgrade failed, continuing with WebGL:', error);
    // Continue with WebGL - already working
  }
};
```

**Pros:**
- ✅ 100% backward compatible
- ✅ Scene starts immediately with WebGL
- ✅ Upgrades to WebGPU when ready
- ✅ No breaking changes

**Cons:**
- ⚠️ Complex state migration
- ⚠️ User sees WebGL briefly before WebGPU
- ⚠️ Need to handle ongoing renders during upgrade

### Option 2: Async Scene Factory (BREAKING CHANGE)
**Create Scene.createAsync() for WebGPU**

```javascript
// New async factory method
Scene.createAsync = async function(options) {
  const context = await ContextFactory.createContext(
    options.canvas,
    options.contextOptions
  );
  
  return new Scene({
    ...options,
    _preInitializedContext: context
  });
};

// Usage (BREAKS EXISTING CODE):
const scene = await Scene.createAsync(options);
```

**Pros:**
- ✅ Clean async initialization
- ✅ WebGPU ready before first render

**Cons:**
- ❌ BREAKS BACKWARD COMPATIBILITY
- ❌ Violates .clinerules
- ❌ Requires all users to update code

### Option 3: Lazy Context Creation
**Defer context creation until first render**

```javascript
function Scene(options) {
  this._contextOptions = contextOptions;
  this._canvas = canvas;
  this._context = null;  // Create on demand
  this._contextPromise = null;
}

Scene.prototype._ensureContext = async function() {
  if (this._context) return this._context;
  
  if (!this._contextPromise) {
    this._contextPromise = ContextFactory.createContext(
      this._canvas,
      this._contextOptions
    );
  }
  
  this._context = await this._contextPromise;
  return this._context;
};
```

**Pros:**
- ✅ Backward compatible constructor
- ✅ Proper async handling

**Cons:**
- ⚠️ All render methods become async
- ⚠️ Complex refactoring
- ⚠️ Potential timing issues

## 🎯 SELECTED APPROACH: Modified Option 2 (Pure WebGPU with Loading State)

### Why This Approach?
- ✅ **Pure WebGPU** - No WebGL code mixing in WebGPU renderer (per .clinerules)
- ✅ **Clean separation** - Each renderer is completely independent
- ✅ **Better architecture** - No complex context swapping
- ✅ **User experience** - Clear loading state during async initialization
- ✅ **Backward compatible** - Synchronous Scene() still works for WebGL

### Implementation Design

#### Option 2A: Scene.createAsync() + Loading State
```javascript
/**
 * Creates a Scene asynchronously with WebGPU support.
 * 
 * @param {Object} options - Scene creation options
 * @param {Function} [onProgress] - Optional callback for loading progress
 * @returns {Promise<Scene>} Promise that resolves to initialized Scene
 * 
 * @example
 * // With loading state
 * const loadingDiv = document.getElementById('loading');
 * const scene = await Scene.createAsync(options, (progress) => {
 *   loadingDiv.textContent = `Initializing WebGPU: ${progress}%`;
 * });
 * loadingDiv.style.display = 'none';
 */
Scene.createAsync = async function(options, onProgress) {
  // Report progress: Initializing context
  if (onProgress) onProgress(10);
  
  const context = await ContextFactory.createContext(
    options.canvas,
    options.contextOptions
  );
  
  if (onProgress) onProgress(50);
  
  // Create scene with pre-initialized context
  const scene = new Scene({
    ...options,
    _preInitializedContext: context  // Private internal option
  });
  
  if (onProgress) onProgress(100);
  
  return scene;
};

// Scene constructor handles pre-initialized context
function Scene(options) {
  if (defined(options._preInitializedContext)) {
    // WebGPU path - context already created
    this._context = options._preInitializedContext;
  } else {
    // WebGL path - synchronous (backward compatible)
    this._context = new Context(canvas, contextOptions);
  }
  // ... rest of initialization
}
```

#### Option 2B: Viewer with Built-in Loading State
```javascript
// Viewer handles async initialization transparently
async function Viewer(container, options) {
  const element = setupViewerDOM(container);
  
  // Check if WebGPU requested
  const useWebGPU = options.contextOptions?.renderer === 'webgpu';
  
  if (useWebGPU) {
    // Show loading overlay
    const loadingOverlay = createLoadingOverlay(element);
    
    // Create scene asynchronously
    const scene = await Scene.createAsync({
      canvas: canvas,
      contextOptions: options.contextOptions
    }, (progress) => {
      updateLoadingProgress(loadingOverlay, progress);
    });
    
    // Hide loading overlay
    removeLoadingOverlay(loadingOverlay);
    
    this._scene = scene;
  } else {
    // WebGL - synchronous (existing path)
    const scene = new Scene({
      canvas: canvas,
      contextOptions: options.contextOptions
    });
    
    this._scene = scene;
  }
}
```

---

## 🎯 ORIGINAL Option 1 (Rejected - Hybrid approach violates pure WebGPU rule)

### Implementation Strategy

#### Step 1: Maintain Synchronous Default
```javascript
function Scene(options) {
  const shouldUseWebGPU = options.contextOptions?.renderer === 'webgpu';
  
  if (shouldUseWebGPU) {
    // Start with WebGL, upgrade async
    this._context = new Context(canvas, {
      ...contextOptions,
      renderer: 'webgl' // Force WebGL initially
    });
    this._pendingWebGPUUpgrade = true;
    this._scheduleWebGPUUpgrade(canvas, contextOptions);
  } else {
    // Normal WebGL path
    this._context = new Context(canvas, contextOptions);
    this._pendingWebGPUUpgrade = false;
  }
}
```

#### Step 2: Async Upgrade Method
```javascript
Scene.prototype._scheduleWebGPUUpgrade = async function(canvas, options) {
  // Wait a frame to ensure Scene is fully initialized
  await new Promise(resolve => requestAnimationFrame(resolve));
  
  try {
    const webgpuContext = await ContextFactory.createContext(canvas, {
      ...options,
      renderer: 'webgpu'
    });
    
    // Swap context
    this._replaceContext(webgpuContext);
    this._pendingWebGPUUpgrade = false;
    
    console.log('Scene upgraded to WebGPU successfully');
  } catch (error) {
    console.warn('WebGPU upgrade failed, using WebGL:', error);
    this._pendingWebGPUUpgrade = false;
  }
};
```

#### Step 3: Context Migration
```javascript
Scene.prototype._replaceContext = function(newContext) {
  const oldContext = this._context;
  
  // Destroy old context resources
  // (Carefully transfer any needed state)
  
  this._context = newContext;
  
  // Recreate framebuffers, etc. with new context
  this._recreateResources();
  
  // Request a render to show WebGPU is ready
  this.requestRender();
};
```

## 📝 Implementation Phases (Pure WebGPU Approach)

### Phase 3.1: Scene.createAsync()
- [ ] Add Scene.createAsync() static method
- [ ] Accept _preInitializedContext in Scene constructor
- [ ] Add progress callback support
- [ ] Test with WebGL context (verify no breakage)

### Phase 3.2: Loading State Component
- [ ] Create LoadingOverlay.js component
- [ ] Add CSS styling for loading state
- [ ] Progress bar visualization
- [ ] Error state handling

### Phase 3.3: Viewer Async Integration
- [ ] Update Viewer to handle async Scene creation
- [ ] Add loading overlay for WebGPU
- [ ] Maintain synchronous path for WebGL
- [ ] Test both paths independently

### Phase 3.4: WebGPU DrawCommand
- [ ] Create WebGPUDrawCommand.ts
- [ ] Abstract rendering interface
- [ ] Command encoding
- [ ] Buffer binding

### Phase 3.5: Basic Rendering
- [ ] Implement simple triangle rendering
- [ ] Test clear color + geometry
- [ ] Verify pure WebGPU pipeline
- [ ] Performance baseline

## ⚠️ Critical Requirements

Following `.clinerules` (UPDATED):

1. **NEVER** break existing Scene constructor
2. Maintain synchronous API for WebGL
3. WebGL must work immediately (unchanged)
4. WebGPU must be PURE WebGPU (no WebGL code)
5. Show loading state during WebGPU initialization
6. Fallback to WebGL must be seamless

## 🧪 Testing Strategy

### Test Cases
1. **Pure WebGL** - `renderer: 'webgl'` works as before
2. **Pure WebGPU** - `renderer: 'webgpu'` upgrades smoothly
3. **Auto mode** - Detects and upgrades correctly
4. **Fallback** - WebGPU failure doesn't break app
5. **Rapid creation** - Multiple Scenes created quickly

### Validation
- All existing tests pass
- No visual glitches during upgrade
- Performance is not degraded
- Memory leaks tested

## 🔜 Next Steps

1. ✅ Update .clinerules - Pure WebGPU requirement added
2. Implement Scene.createAsync() with progress callback
3. Create LoadingOverlay component for WebGPU initialization
4. Update Viewer to handle async Scene creation
5. Create WebGPU DrawCommand abstraction
6. Implement basic triangle rendering

## 📚 Related Code

Files to create/update:
- `Scene.js` - Add Scene.createAsync() static method
- `Viewer.js` - Handle async Scene creation for WebGPU
- `Widget/LoadingOverlay.js` - NEW loading UI component
- `WebGPU/WebGPUDrawCommand.ts` - NEW draw command for WebGPU
- `DrawCommand.js` - May need interface abstraction

## 🎓 User Experience

### WebGL (Unchanged):
```javascript
const viewer = new Cesium.Viewer('container'); // Instant, synchronous
```

### WebGPU (With Loading):
```javascript
const viewer = new Cesium.Viewer('container', {
  contextOptions: {
    renderer: 'webgpu'
  }
});
// User sees: "Initializing WebGPU..." overlay
// Then: Overlay fades out, WebGPU rendering begins
```

### Pure WebGPU Rendering Path:
```
User selects WebGPU
    ↓
Viewer shows loading overlay
    ↓
Scene.createAsync() called
    ↓
ContextFactory creates WebGPUContext
    ↓
Scene initialized with PURE WebGPU
    ↓
Loading overlay removed
    ↓
WebGPU rendering begins
```

---

**Phase 3 Status:** 📋 **PLANNED - READY TO IMPLEMENT**
**Approach:** Pure WebGPU with Loading State (Modified Option 2)
**Priority:** Maintain backward compatibility + Pure WebGPU renderer
**Updated:** 2025-12-12
