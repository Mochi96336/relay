// Worker entrypoints do not pass through the parent's TypeScript hook. Start
// from JavaScript, then use tsx's scoped import API for the runtime module.
import { tsImport } from 'tsx/esm/api';

await tsImport('./timing-calibration-worker.ts', import.meta.url);
