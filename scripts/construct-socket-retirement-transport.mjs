import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

const serverPath = 'src/server.ts';
const workflowPath = '.github/workflows/construct-socket-retirement-transport.yml';
const scriptPath = 'scripts/construct-socket-retirement-transport.mjs';
let source = readFileSync(serverPath, 'utf8');

function replaceOnce(label, before, after) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);
  if (first < 0 || first !== last) {
    throw new Error(`${label}: expected exactly one replacement anchor`);
  }
  source = source.slice(0, first) + after + source.slice(first + before.length);
}

replaceOnce(
  'socket transport destructure',
  `const {\n  sendJson,\n  broadcastJson,\n  canClaimSocketRole,\n  commitSocketRole,\n} = createRelaySocketTransport(wss);`,
  `const {\n  sendJson,\n  broadcastJson,\n  retire: retireSocket,\n  canClaimSocketRole,\n  commitSocketRole,\n} = createRelaySocketTransport(wss);`,
);

replaceOnce(
  'generic replacement retirement',
  `function replacePrevious(previous: RelaySocket | null, next: RelaySocket, message: string) {\n  if (!previous || previous === next) return;\n  previous.replaced = true;\n  sendJson(previous, { type: 'error', message });\n  try {\n    previous.close();\n  } catch {}\n  setTimeout(() => {\n    if (previous.readyState !== WebSocket.CLOSED) previous.terminate();\n  }, 1_000).unref();\n}`,
  `function replacePrevious(previous: RelaySocket | null, next: RelaySocket, message: string) {\n  if (!previous || previous === next) return;\n  retireSocket(previous, { type: 'error', message });\n}`,
);

replaceOnce(
  'publisher retirement',
  `function retirePublisherTransport(\n  previous: RelaySocket | null,\n  type: 'mic-revoked' | 'publisher-superseded',\n  message: string,\n) {\n  if (!previous) return false;\n  previous.replaced = true;\n  sendJson(previous, { type, message });\n  try {\n    previous.close();\n  } catch {}\n  setTimeout(() => {\n    if (previous.readyState !== WebSocket.CLOSED) previous.terminate();\n  }, 1_000).unref();\n  return true;\n}`,
  `function retirePublisherTransport(\n  previous: RelaySocket | null,\n  type: 'mic-revoked' | 'publisher-superseded',\n  message: string,\n) {\n  if (!previous) return false;\n  retireSocket(previous, { type, message });\n  return true;\n}`,
);

writeFileSync(serverPath, source);
unlinkSync(workflowPath);
unlinkSync(scriptPath);
