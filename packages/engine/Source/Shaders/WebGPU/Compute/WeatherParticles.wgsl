// GPU Weather Particle System — WebGPU Compute
//
// Simulates weather effects (rain, snow, fog droplets) entirely on the GPU.
// Particles are emitted, updated, and compacted in compute shaders.
// A separate vertex/fragment pass renders them as camera-facing quads.
//
// Architecture:
//   Pass 1: Update — advance positions, apply gravity/wind, check lifetime
//   Pass 2: Emit — fill dead particle slots with new particles
//   Pass 3 (optional): Compact — remove dead particles (prefix sum)
//   Render: Instanced quads from particle buffer
//
// RTE precision contract — particle.position is CAMERA-RELATIVE.
// Storing world-space ECEF positions would lose ~0.6 m/unit to FP32
// rounding at Earth radius (6.4e6 m), which is larger than a raindrop
// moves in one frame — rain would appear frozen. Instead we keep
// particles in a small local frame anchored at the camera:
//   - Emit: p.position = small offset (never involves the big ECEF add)
//   - Update: subtract the frame-to-frame camera delta so particles
//     stay fixed in world-space while the camera moves through them.
//     The delta is computed FP64 on the CPU (`WebGPUWeatherRenderer`)
//     and passed in as a small vec3.
//   - Cull: `length(p.position) > fadeDistance` — no subtraction.
// The render pass projects with `mvpRelativeToEye` so the camera-
// relative position goes to clip space without ever materializing
// a world-space absolute position on the GPU.
//
// Particle layout (32 bytes per particle):
//   position: vec3<f32>  (CAMERA-RELATIVE — see note above)
//   lifetime: f32        (seconds remaining, <=0 = dead)
//   velocity: vec3<f32>  (meters/sec, world orientation)
//   size: f32            (screen-space size factor)
//
// Weather types:
//   0 = Rain:  fast fall, streaks, splash on ground
//   1 = Snow:  slow fall, drift, tumble
//   2 = Fog:   slow drift, large particles, fade
//   3 = Hail:  fast fall, bounce, larger than rain

struct Particle {
  position: vec3<f32>,
  lifetime: f32,
  velocity: vec3<f32>,
  size: f32,
};

struct WeatherParams {
  // Camera delta since the previous frame (currentCam - prevCam),
  // computed FP64 on the CPU and passed in as a small vec3. Used to
  // drift particles against camera motion so they stay stationary in
  // world-space while stored in a camera-relative frame.
  cameraDelta: vec3<f32>,
  deltaTime: f32,
  // Wind direction and strength: xyz=direction, w=speed (m/s)
  wind: vec4<f32>,
  // Gravity: xyz=direction (typically 0,-1,0), w=magnitude (m/s²)
  gravity: vec4<f32>,
  // Spawn volume: xyz=half-extents, w=maxParticles
  spawnVolume: vec4<f32>,
  // Type params: x=weatherType (0-3), y=intensity (0-1), z=particleLifetime, w=particleSize
  typeParams: vec4<f32>,
  // Ground params: x=relativeGroundAltitude (camera-relative Y of ground
  // plane; computed CPU-side as `worldGroundAlt - cameraPosition.y`),
  // y=turbulence, z=fadeDistance, w=time
  groundParams: vec4<f32>,
};

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> params: WeatherParams;
@group(0) @binding(2) var<storage, read_write> counters: array<atomic<u32>>;
// counters[0] = aliveCount
// counters[1] = emitCount (particles to emit this frame)
// counters[2] = nextDeadSlot (for emission)

// ─── Pseudo-random number generator (PCG hash) ───
fn pcgHash(input: u32) -> u32 {
  var state = input * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn randomFloat(seed: u32) -> f32 {
  return f32(pcgHash(seed)) / 4294967295.0;
}

fn randomFloat2(seed: u32) -> vec2<f32> {
  return vec2<f32>(
    randomFloat(seed),
    randomFloat(seed + 1u)
  );
}

fn randomFloat3(seed: u32) -> vec3<f32> {
  return vec3<f32>(
    randomFloat(seed),
    randomFloat(seed + 1u),
    randomFloat(seed + 2u)
  );
}

// ─── Simplex-like noise for turbulence ───
fn turbulenceNoise(pos: vec3<f32>, time: f32) -> vec3<f32> {
  let t = time * 0.5;
  let s = sin(pos * 0.01 + t) * cos(pos.zxy * 0.013 + t * 1.3);
  return s * params.groundParams.y; // turbulence strength
}

// ═══════════════════════════════════════════════════════════════════════
// Pass 1: Update existing particles
// ═══════════════════════════════════════════════════════════════════════
@compute @workgroup_size(256)
fn updateParticles(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  let maxParticles = u32(params.spawnVolume.w);
  if (idx >= maxParticles) { return; }

  var p = particles[idx];

  // Skip dead particles
  if (p.lifetime <= 0.0) { return; }

  // RTE: shift particle against camera motion so its world-space
  // position remains fixed while stored in a camera-relative frame.
  // `cameraDelta` is computed FP64 on the CPU and is always a small
  // vec3 regardless of absolute camera position.
  p.position -= params.cameraDelta;

  let dt = params.deltaTime;
  let weatherType = u32(params.typeParams.x);

  // Apply gravity
  p.velocity += params.gravity.xyz * params.gravity.w * dt;

  // Apply wind
  p.velocity += params.wind.xyz * params.wind.w * dt * 0.1;

  // Type-specific behavior
  switch (weatherType) {
    case 0u: {
      // Rain: fast fall, slight random lateral movement
      let noise = turbulenceNoise(p.position, params.groundParams.w);
      p.velocity += noise * 0.5 * dt;
    }
    case 1u: {
      // Snow: strong turbulence, slow drift, tumble
      let noise = turbulenceNoise(p.position, params.groundParams.w);
      p.velocity += noise * 3.0 * dt;
      // Damping for snow (air resistance)
      p.velocity *= (1.0 - 2.0 * dt);
    }
    case 2u: {
      // Fog: very slow drift, mostly horizontal
      let noise = turbulenceNoise(p.position, params.groundParams.w);
      p.velocity = noise * 0.5;
      p.velocity.y *= 0.1; // minimal vertical movement
    }
    case 3u: {
      // Hail: fast fall, slight turbulence
      let noise = turbulenceNoise(p.position, params.groundParams.w);
      p.velocity += noise * 0.3 * dt;
    }
    default: {}
  }

  // Update position
  p.position += p.velocity * dt;

  // Decrease lifetime
  p.lifetime -= dt;

  // Ground collision: kill particle at (camera-relative) ground altitude.
  // `groundParams.x` is now `worldGroundAlt - cameraPosition.y`, already
  // in the same camera-relative Y frame as `p.position.y`.
  let relativeGroundAlt = params.groundParams.x;
  if (p.position.y < relativeGroundAlt) {
    p.lifetime = 0.0;
  }

  // Fade distance: kill particles too far from camera. With camera-
  // relative positions, the distance from camera is just the length
  // of the position vector — no big-number subtraction needed.
  let distFromCamera = length(p.position);
  let fadeDistance = params.groundParams.z;
  if (distFromCamera > fadeDistance) {
    p.lifetime = 0.0;
  }

  particles[idx] = p;

  // Count alive particles
  if (p.lifetime > 0.0) {
    atomicAdd(&counters[0], 1u);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Pass 2: Emit new particles into dead slots
// ═══════════════════════════════════════════════════════════════════════
@compute @workgroup_size(256)
fn emitParticles(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  let maxParticles = u32(params.spawnVolume.w);
  if (idx >= maxParticles) { return; }

  var p = particles[idx];

  // Only emit into dead slots
  if (p.lifetime > 0.0) { return; }

  // Check if we should emit (based on intensity)
  let emitProbability = params.typeParams.y * params.deltaTime * 10.0;
  let rng = randomFloat(idx * 7u + u32(params.groundParams.w * 1000.0));
  if (rng > emitProbability) { return; }

  // Random position within spawn volume. Camera-relative frame: the
  // spawn volume is already centered on (0,0,0) because that's where
  // the camera sits in this frame. No big-number add needed.
  let halfExtents = params.spawnVolume.xyz;
  let rndPos = randomFloat3(idx * 13u + u32(params.groundParams.w * 1000.0));
  let offset = (rndPos * 2.0 - 1.0) * halfExtents;

  p.position = offset;

  // Move spawn above camera for falling particles. Since the camera is
  // at (0,0,0) in this frame, "above" is just `+halfExtents.y`.
  let weatherType = u32(params.typeParams.x);
  if (weatherType != 2u) { // Not fog
    p.position.y = halfExtents.y;
  }

  // Initial velocity based on weather type
  let baseSpeed = randomFloat(idx * 17u + u32(params.groundParams.w * 500.0));
  switch (weatherType) {
    case 0u: {
      // Rain: fast downward
      p.velocity = vec3<f32>(
        (baseSpeed - 0.5) * 2.0,
        -8.0 - baseSpeed * 12.0,
        (randomFloat(idx * 19u) - 0.5) * 2.0
      );
      p.size = params.typeParams.w * (0.8 + baseSpeed * 0.4);
    }
    case 1u: {
      // Snow: slow, random lateral drift
      p.velocity = vec3<f32>(
        (baseSpeed - 0.5) * 3.0,
        -0.5 - baseSpeed * 1.5,
        (randomFloat(idx * 19u) - 0.5) * 3.0
      );
      p.size = params.typeParams.w * (0.5 + baseSpeed * 1.0);
    }
    case 2u: {
      // Fog: very slow drift
      p.velocity = vec3<f32>(
        (baseSpeed - 0.5) * 0.5,
        (randomFloat(idx * 19u) - 0.5) * 0.1,
        (randomFloat(idx * 23u) - 0.5) * 0.5
      );
      p.size = params.typeParams.w * (2.0 + baseSpeed * 4.0);
    }
    case 3u: {
      // Hail: fast downward, larger
      p.velocity = vec3<f32>(
        (baseSpeed - 0.5) * 1.5,
        -10.0 - baseSpeed * 15.0,
        (randomFloat(idx * 19u) - 0.5) * 1.5
      );
      p.size = params.typeParams.w * (1.2 + baseSpeed * 0.8);
    }
    default: {}
  }

  // Set lifetime with some variation
  let lifetimeBase = params.typeParams.z;
  p.lifetime = lifetimeBase * (0.5 + baseSpeed);

  particles[idx] = p;
}

// ═══════════════════════════════════════════════════════════════════════
// Counter reset (run before update pass each frame)
// ═══════════════════════════════════════════════════════════════════════
@compute @workgroup_size(1)
fn resetCounters() {
  atomicStore(&counters[0], 0u);
  atomicStore(&counters[1], 0u);
  atomicStore(&counters[2], 0u);
}
