import { loadRelayConfig } from './config.js';
import { startRelayRuntime } from './relay-runtime.js';

await startRelayRuntime(loadRelayConfig());
