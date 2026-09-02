// Creates a minimal GPUDevice test double that records buffer creations and
// queue writes. Consumers that need additional GPU behavior should provide it
// explicitly so an unexpected interaction fails instead of being ignored.
export function createRecordingWebGPUBufferDevice() {
  const created = [];
  const descriptors = [];
  const writes = [];
  const device = {
    createBuffer(descriptor) {
      const buffer = {
        size: descriptor.size,
        usage: descriptor.usage,
        label: descriptor.label,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      descriptors.push(descriptor);
      created.push(buffer);
      return buffer;
    },
    queue: {
      writeBuffer(buffer, offset, source, srcOffset, byteLength) {
        writes.push({ buffer, offset, source, srcOffset, byteLength });
      },
    },
  };

  return { device, created, descriptors, writes };
}
