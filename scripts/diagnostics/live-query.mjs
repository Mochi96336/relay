import WebSocket from 'ws';
const url = new URL(process.env.RELAY_DIAGNOSTICS_URL || 'ws://127.0.0.1:3100/ws');
if (process.env.RELAY_KEY) url.searchParams.set('key', process.env.RELAY_KEY);
const ws = new WebSocket(url);
const timeout = setTimeout(() => { console.error('live query timeout'); ws.terminate(); process.exitCode = 1; }, 8000);
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'take-status-request' }));
  ws.send(JSON.stringify({ type: 'timing-calibration-status-request' }));
});
let count = 0;
ws.on('message', data => {
  const m = JSON.parse(data.toString());
  if (m.type === 'take-status') { console.log(JSON.stringify({ type: m.type, lifecycle: m.lifecycle, takeId: m.take?.takeId ?? null })); count++; }
  if (m.type === 'timing-calibration-status') { console.log(JSON.stringify({ type: m.type, sampleSongFallback: m.sampleSongFallback, timingMode: m.timingMode })); count++; }
  if (count >= 2) { clearTimeout(timeout); ws.close(); }
});

ws.on('error', () => {
  clearTimeout(timeout);
  console.error('Live query connection failed');
  process.exitCode = 1;
});
ws.on('close', () => clearTimeout(timeout));
