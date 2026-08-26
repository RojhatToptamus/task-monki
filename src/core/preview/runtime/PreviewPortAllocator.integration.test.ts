import { describe, expect, it } from 'vitest';
import { PreviewPortAllocator } from './PreviewPortAllocator';

describe('PreviewPortAllocator', () => {
  it('reserves distinct loopback ports for concurrent previews', async () => {
    const allocator = new PreviewPortAllocator();
    const ports = await Promise.all([allocator.allocate(), allocator.allocate(), allocator.allocate()]);
    expect(new Set(ports).size).toBe(3);
    expect(ports.every((port) => port > 0 && port <= 65_535)).toBe(true);
    ports.forEach((port) => allocator.release(port));
  });
});
