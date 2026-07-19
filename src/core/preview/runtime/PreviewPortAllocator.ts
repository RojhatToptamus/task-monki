import net from 'node:net';

export class PreviewPortAllocator {
  private readonly reserved = new Set<number>();

  async allocate(): Promise<number> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const port = await findAvailableLoopbackPort();
      if (!this.reserved.has(port)) {
        this.reserved.add(port);
        return port;
      }
    }
    throw new Error('Unable to reserve a distinct loopback port for the preview.');
  }

  release(port: number): void {
    this.reserved.delete(port);
  }
}

async function findAvailableLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
    server.close();
    throw new Error('Port allocator did not bind IPv4 loopback.');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return port;
}
