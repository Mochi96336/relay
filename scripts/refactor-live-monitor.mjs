import { readFileSync, writeFileSync } from 'node:fs';

function replaceOnce(text, from, to, label) {
  const count = text.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 exact match, found ${count}`);
  return text.replace(from, to);
}

function replaceRegexOnce(text, pattern, to, label) {
  const matches = [...text.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))];
  if (matches.length !== 1) throw new Error(`${label}: expected 1 regex match, found ${matches.length}`);
  return text.replace(pattern, to);
}

let app = readFileSync('public/app.js', 'utf8');

for (const [line, label] of [
  ["const monitorButton = document.querySelector('#start-monitor');\n", 'monitor button binding'],
  ["const stopButton = document.querySelector('#stop');\n", 'legacy stop binding'],
  ["const monitorGain = document.querySelector('#monitor-gain');\n", 'legacy monitor gain binding'],
  ["const monitorGainValue = document.querySelector('#monitor-gain-value');\n", 'legacy monitor gain value binding'],
  ['const MIX_SAMPLE_RATE = 48000;\n', 'legacy mix sample rate'],
  ['const MONITOR_PREBUFFER_MS = 250;\n', 'legacy monitor prebuffer'],
  ['const MONITOR_MAX_QUEUE_MS = 800;\n', 'legacy monitor queue'],
  ['let playbackNode = null;\n', 'legacy playback node'],
  ['let monitorGainNode = null;\n', 'legacy gain node'],
  ['let sourceSampleRate = null;\n', 'legacy monitor source rate'],
  ['let rawMonitorGainDb = 30;\n', 'legacy raw monitor gain'],
  ['let monitorHealth = null;\n', 'legacy monitor health'],
]) {
  app = replaceOnce(app, line, '', label);
}

app = replaceRegexOnce(
  app,
  /\/\*\*\n \* Whether what arrives on this socket[\s\S]*?function serverMixActive\(\) \{[\s\S]*?\n\}\n\n/,
  '',
  'serverMixActive compatibility helper',
);

app = replaceRegexOnce(app, /function dbToGain\(db\) \{[\s\S]*?\n\}\n\n/, '', 'legacy monitor gain conversion');
app = replaceRegexOnce(app, /function updateMonitorGain\(\) \{[\s\S]*?\n\}\n\n/, '', 'legacy monitor gain updater');
app = replaceRegexOnce(
  app,
  /function linearResample\(input, sourceRate, targetRate\) \{[\s\S]*?function int16ToFloat32\(buffer\) \{[\s\S]*?\n\}\n\n(?=\/\/ Must match src\/calibration-probe\.ts)/,
  '',
  'legacy monitor PCM conversion',
);
app = replaceRegexOnce(
  app,
  /function describeMonitorHealth\(\) \{[\s\S]*?\n\}\n\n(?=function dispatchRelayEvent)/,
  '',
  'legacy monitor health formatter',
);

app = replaceRegexOnce(
  app,
  /  if \(message\.type === 'publisher-status'\) \{[\s\S]*?\n  \}\n\n(?=  if \(message\.type === 'source-status'\))/,
  '',
  'publisher-status monitor branch',
);

app = replaceRegexOnce(
  app,
  /  if \(message\.type === 'source-status'\) \{[\s\S]*?\n  \}\n\n(?=  if \(message\.type === 'mix-settings'\))/,
  `  if (message.type === 'source-status') {\n    liveMixActive = Boolean(message.active);\n    updateCalibrateButton();\n    return;\n  }\n\n`,
  'source-status monitor coupling',
);

app = replaceRegexOnce(
  app,
  /  if \(message\.type === 'mix-health'\) \{[\s\S]*?\n  \}\n\n(?=  if \(message\.type === 'test-status'\))/,
  `  if (message.type === 'mix-health') {\n    latestMixHealth = message;\n    renderGainAdvice();\n    return;\n  }\n\n`,
  'mix-health monitor coupling',
);

app = replaceRegexOnce(
  app,
  /  if \(message\.type === 'test-status'\) \{[\s\S]*?\n  \}\n(?=\}\n\nfunction canKeepPublishing)/,
  `  if (message.type === 'test-status') {\n    testActive = Boolean(message.active);\n    if (!testActive && activeRole === 'publisher') stopLocalClickTrack();\n    updateTestButtons();\n  }\n`,
  'test-status monitor coupling',
);

app = replaceRegexOnce(
  app,
  /function canKeepMonitoring\(\) \{[\s\S]*?\n\}\n\n/,
  '',
  'legacy monitor keepalive predicate',
);
app = replaceRegexOnce(
  app,
  /function scheduleMonitorReconnect\(\) \{[\s\S]*?\n\}\n\n(?=function adoptSocket)/,
  '',
  'legacy monitor reconnect loop',
);
app = replaceRegexOnce(
  app,
  /async function connectMonitorSocket\(\) \{[\s\S]*?\n\}\n\n(?=async function stop)/,
  '',
  'legacy monitor socket',
);
app = replaceRegexOnce(
  app,
  /async function startMonitor\(\) \{[\s\S]*?\n\}\n\n(?=async function requestPublisherStart)/,
  '',
  'legacy monitor audio graph',
);

for (const [from, to, label] of [
  ["  playbackNode = null;\n  monitorGainNode = null;\n", '', 'legacy monitor stop nodes'],
  ["  sourceSampleRate = null;\n", '', 'legacy monitor stop sample rate'],
  ["  monitorHealth = null;\n", '', 'legacy monitor stop health'],
  ["  monitorButton.disabled = false;\n  stopButton.disabled = true;\n", '', 'legacy monitor stop controls'],
  ["  monitorButton.disabled = true;\n  stopButton.disabled = false;\n", '', 'legacy monitor publisher controls'],
  ["monitorButton.addEventListener('click', () => {\n  startMonitor().catch(async (error) => {\n    console.error(error);\n    setStatus('Could not start monitor', error instanceof Error ? error.message : String(error));\n    await stop(false, { releaseMic: false });\n  });\n});\n\n", '', 'legacy monitor button listener'],
  ["stopButton.addEventListener('click', () => {\n  stop().catch(console.error);\n});\n\n", '', 'legacy stop listener'],
  ["monitorGain.addEventListener('input', updateMonitorGain);\n\n", '', 'legacy monitor gain listener'],
  ["updateMonitorGain();\n", '', 'legacy monitor init'],
  ["  if (setIdle) setStatus('Idle', 'Choose one role on each device.');", "  if (setIdle) setStatus('Idle', 'Take the mic when you are ready.');", 'idle role copy'],
  ["setStatus('Idle', 'On the phone choose Microphone; on the computer choose Monitor.');", "setStatus('Idle', 'Take the mic when you are ready.');", 'startup role copy'],
]) {
  app = replaceOnce(app, from, to, label);
}

const forbiddenApp = [
  'startMonitor', 'connectMonitorSocket', 'scheduleMonitorReconnect', 'canKeepMonitoring',
  'monitorButton', 'monitorGain', 'monitorGainNode', 'playbackNode', 'monitorHealth',
  'rawMonitorGainDb', 'sourceSampleRate', 'MONITOR_PREBUFFER_MS', 'MONITOR_MAX_QUEUE_MS',
  'linearResample', 'int16ToFloat32', 'serverMixActive', 'dbToGain',
];
for (const token of forbiddenApp) {
  if (app.includes(token)) throw new Error(`app.js still contains retired monitor token: ${token}`);
}
if (!app.includes("setActiveRole('publisher')")) throw new Error('publisher capture path was accidentally removed');
if (!app.includes("role: 'publisher'")) throw new Error('publisher registration was accidentally removed');
if (!app.includes('framePcm(event.data, captureGeneration, firstSampleIndex)')) throw new Error('framed PCM uplink was accidentally removed');
writeFileSync('public/app.js', app);

let html = readFileSync('public/index.html', 'utf8');
html = replaceRegexOnce(
  html,
  /\n\s*<label class="mix-row legacy-monitor" for="monitor-gain">[\s\S]*?<\/label>/,
  '',
  'legacy monitor gain UI',
);
html = replaceRegexOnce(
  html,
  /\n\s*<div class="legacy-transport-controls" aria-hidden="true">[\s\S]*?<\/div>/,
  '',
  'legacy hidden monitor transport UI',
);
for (const token of ['id="start-monitor"', 'id="monitor-gain"', 'id="stop"', 'legacy-transport-controls']) {
  if (html.includes(token)) throw new Error(`index.html still contains retired monitor UI: ${token}`);
}
writeFileSync('public/index.html', html);

let style = readFileSync('public/style.css', 'utf8');
style = replaceOnce(style, '.legacy-monitor { padding: 12px 0; }\n.legacy-transport-controls { display: none !important; }\n', '', 'legacy monitor CSS');
writeFileSync('public/style.css', style);

let liveContract = readFileSync('test/live-ui-contract.test.ts', 'utf8');
liveContract = replaceOnce(
  liveContract,
  `test('legacy monitor transport stays hidden during the migration', () => {\n  const legacy = position('class="legacy-transport-controls"');\n  const technical = position('class="diagnostics-body"');\n  assert.ok(technical < legacy);\n});`,
  `test('formal Listen is the only monitor transport shipped by the Live page', () => {\n  assert.doesNotMatch(html, /id="start-monitor"|id="monitor-gain"|legacy-transport-controls/);\n  assert.match(listen, /role:\\s*'monitor'/);\n});`,
  'Live monitor migration contract',
);
writeFileSync('test/live-ui-contract.test.ts', liveContract);

let systemContract = readFileSync('test/system-details-contract.test.ts', 'utf8');
systemContract = replaceOnce(
  systemContract,
  `test('legacy engineering controls remain below Technical details and Development tools', () => {\n  const technical = position('id="diagnostics-panel"');\n  const development = position('class="legacy-tools"');\n  const source = position('Open source');\n  const clickTest = position('id="start-sync-test"');\n  const legacyMonitor = position('id="monitor-gain"');\n\n  assert.ok(technical < development);\n  assert.ok(development < source);\n  assert.ok(development < clickTest);\n  assert.ok(development < legacyMonitor);\n});`,
  `test('remaining engineering controls stay below Technical details and Development tools', () => {\n  const technical = position('id="diagnostics-panel"');\n  const development = position('class="legacy-tools"');\n  const source = position('Open source');\n  const clickTest = position('id="start-sync-test"');\n\n  assert.ok(technical < development);\n  assert.ok(development < source);\n  assert.ok(development < clickTest);\n  assert.doesNotMatch(html, /id="monitor-gain"|id="start-monitor"|legacy-transport-controls/);\n});`,
  'System legacy monitor contract',
);
writeFileSync('test/system-details-contract.test.ts', systemContract);

writeFileSync('test/legacy-monitor-retirement.test.ts', `import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nimport test from 'node:test';\n\nconst app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');\nconst listen = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');\nconst html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');\n\ntest('app.js owns Mic capture but no longer contains a second monitor runtime', () => {\n  assert.match(app, /role:\\s*'publisher'/);\n  assert.match(app, /framePcm\\(event\\.data, captureGeneration, firstSampleIndex\\)/);\n  assert.doesNotMatch(app, /startMonitor|connectMonitorSocket|monitorGainNode|playbackNode|linearResample|int16ToFloat32/);\n});\n\ntest('formal Listen is the only browser monitor implementation', () => {\n  assert.match(listen, /role:\\s*'monitor'/);\n  assert.match(listen, /playback-processor/);\n  assert.doesNotMatch(html, /id="start-monitor"|id="monitor-gain"|legacy-transport-controls/);\n});\n`);

console.log('legacy monitor runtime retired; Mic capture path retained');
