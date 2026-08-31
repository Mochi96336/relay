import process from 'node:process';

import type { loadRelayConfig } from './config.js';
import { startRelayServer } from './server.js';

export type RelayConfig = ReturnType<typeof loadRelayConfig>;

/**
 * Composition boundary for the current Relay process.
 *
 * Deployment parsing, server construction, and process-signal ownership now
 * meet at this boundary. `server.ts` receives normalized RelayConfig directly;
 * it no longer depends on environment mutation or import-time activation.
 */
export async function startRelayRuntime(config: RelayConfig) {
  const relayServer = await startRelayServer(config);

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      // Process lifecycle belongs at the composition boundary. Keep both
      // handlers installed while the server's idempotent shutdown transaction
      // is active so repeated signals join the same durability barrier.
      void relayServer.gracefulShutdown(signal).finally(() => {
        process.exit(process.exitCode ?? 0);
      });
    });
  }
}
