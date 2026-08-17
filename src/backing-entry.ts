import process from 'node:process';

import { loadBackingConfig } from './config.js';

// Normalize the bridge's deployment settings before its existing transport
// code starts. The bridge can keep its local invariants while config.ts owns
// the externally configurable values and defaults.
const config = loadBackingConfig();
Object.assign(process.env, {
  RELAY_URL: config.relayUrl,
  RELAY_BACKING_SAMPLE_RATE: String(config.sampleRate),
  RELAY_BACKING_FRAME_MS: String(config.frameMs),
  RELAY_BACKING_RECONNECT_MS: String(config.reconnectMs),
  RELAY_BACKING_MAX_BUFFERED_BYTES: String(config.maxBufferedBytes),
  RELAY_BACKING_STARTUP_FLUSH_MS: String(config.startupFlushMs),
  RELAY_BACKING_ROBOT: config.robot ? '1' : '0',
});

await import('./backing-stdin.js');
