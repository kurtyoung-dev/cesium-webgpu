export interface SynopticCloudLayerSample {
  coverage: number;
  cloudType: number;
  baseMeters: number;
  topMeters: number;
  densityBias: number;
}

interface CloudRegimes extends SynopticCloudLayerSample {
  front: number;
  head: number;
  tropical: number;
  suppression: number;
  regional: number;
  cellular: number;
  latitude: number;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export function sampleSynopticCloudLayers(
  value: CloudRegimes,
): SynopticCloudLayerSample[] {
  const { front, head, tropical, suppression, regional, cellular } = value;
  const dry = 1 - clamp01(suppression);
  const middleBase = 4000 + regional * 1000;
  const highBase = 8500 + Math.cos(value.latitude) ** 2 * 2500;
  return [
    {
      coverage: clamp01(
        value.coverage * (0.7 + cellular * 0.3 + tropical * 0.2),
      ),
      cloudType: value.cloudType,
      baseMeters: value.baseMeters,
      // A low-based storm may cross several altitude bands. Its top belongs
      // to this population and is never clipped to a fixed low-cloud ceiling.
      topMeters: value.topMeters,
      densityBias: value.densityBias,
    },
    {
      coverage: clamp01(
        (front * 0.75 + head * 0.55 + regional * 0.18) * (0.2 + dry * 0.8),
      ),
      cloudType: 5 - clamp01(front + head * 0.4),
      baseMeters: middleBase,
      topMeters: middleBase + 750 + front * 2000 + head * 1000,
      densityBias: clamp01(0.35 + front * 0.22 + head * 0.1),
    },
    {
      coverage: clamp01(
        (front * 0.6 + tropical * 0.6 + head * 0.25 + regional * 0.12) *
          (0.55 + regional * 0.45) *
          (0.5 + dry * 0.5),
      ),
      cloudType: 1 + clamp01(front),
      baseMeters: highBase,
      topMeters: highBase + 500 + regional * 1000 + tropical * 1200,
      densityBias: clamp01(0.15 + front * 0.18 + tropical * 0.15),
    },
  ];
}
