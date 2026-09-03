import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

const serverPath = 'src/server.ts';
const workflowPath = '.github/workflows/construct-boot-probe-promotion.yml';
const scriptPath = 'scripts/construct-boot-probe-promotion.mjs';
let source = readFileSync(serverPath, 'utf8');

function replaceOnce(label, before, after) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);
  if (first < 0 || first !== last) {
    throw new Error(`${label}: expected exactly one replacement anchor`);
  }
  source = source.slice(0, first) + after + source.slice(first + before.length);
}

const finishAnchor = '\nfunction maybeFinishProbeAnalysis(nowMs: number) {';
replaceOnce(
  'insert promotion helper',
  finishAnchor,
  `\nfunction promoteBootProbeCalibration(\n  mutateProbe: () => void,\n  result: () => { micLagMs: number; confidence: number },\n) {\n  mutateProbe();\n  timingRuntime.markBootProbeAuthority();\n  calibration.applyExternalResult(result());\n}\n${finishAnchor}`,
);

replaceOnce(
  'fresh probe promotion',
  `  bootProbeRuntime.recordCalibration(bootProbeContext(), result);\n  timingRuntime.markBootProbeAuthority();\n  calibration.applyExternalResult({\n    micLagMs: result.advanceMs,\n    confidence: Math.max(0, Math.min(1, result.confidence)),\n  });`,
  `  promoteBootProbeCalibration(\n    () => bootProbeRuntime.recordCalibration(bootProbeContext(), result),\n    () => ({\n      micLagMs: result.advanceMs,\n      confidence: Math.max(0, Math.min(1, result.confidence)),\n    }),\n  );`,
);

replaceOnce(
  'delta reapply promotion',
  `  bootProbeRuntime.reapplyCalibration(advanceMs, currentDeltaMs(nowMs));\n  timingRuntime.markBootProbeAuthority();\n  calibration.applyExternalResult({ micLagMs: advanceMs, confidence: bootProbeRuntime.confidence ?? 0 });`,
  `  promoteBootProbeCalibration(\n    () => bootProbeRuntime.reapplyCalibration(advanceMs, currentDeltaMs(nowMs)),\n    () => ({ micLagMs: advanceMs, confidence: bootProbeRuntime.confidence ?? 0 }),\n  );`,
);

writeFileSync(serverPath, source);
unlinkSync(workflowPath);
unlinkSync(scriptPath);
