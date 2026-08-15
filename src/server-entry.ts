import { loadRelayConfig } from './config.js';

// Validate the whole deployment contract before server.ts reads any individual
// setting. Invalid production configuration must fail closed rather than turn
// into NaN or silently fall back to a different timing model.
loadRelayConfig();
await import('./server.js');
