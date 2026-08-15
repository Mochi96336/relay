import { loadBackingConfig } from './config.js';

// backing-stdin historically validated only some knobs locally. Keep that
// implementation focused on transport and make the process boundary reject a
// malformed URL/range before capture begins.
loadBackingConfig();
await import('./backing-stdin.js');
