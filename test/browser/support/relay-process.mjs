import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const STARTUP_TIMEOUT_MS = 20_000;

/**
 * Runs the real Relay (src/server-entry.ts) on an OS-assigned port for a
 * browser proof. Calibration and its validation stay off, and the ping sweep
 * is slow enough never to matter. The room key and any WebTransport
 * deployment settings in the caller's environment are dropped, so a proof
 * only gets the ones it passes in `env`. The same goes for the take directory:
 * unless `env` names one, Takes go to a temporary directory that is removed
 * when the server exits, never to the deployment's `takes` library.
 */
export function startRelay(env = {}) {
  const childEnv = { ...process.env };
  for (const name of Object.keys(childEnv)) {
    if (name === 'RELAY_KEY' || name.startsWith('RELAY_WEBTRANSPORT_')) delete childEnv[name];
  }
  Object.assign(childEnv, {
    PORT: '0',
    RELAY_AUTO_CALIBRATE: '0',
    RELAY_CALIBRATION_VALIDATION: '0',
    RELAY_CALIBRATION_PROBE: '0',
    RELAY_HEARTBEAT_MS: '60000',
    ...env,
  });
  const ownTakeDirectory = env.RELAY_TAKE_DIR === undefined
    ? mkdtempSync(path.join(os.tmpdir(), 'relay-test-takes-'))
    : null;
  if (ownTakeDirectory) childEnv.RELAY_TAKE_DIR = ownTakeDirectory;

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(root, 'src', 'server-entry.ts')],
    { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  if (ownTakeDirectory) {
    child.once('exit', () => rmSync(ownTakeDirectory, { recursive: true, force: true }));
  }

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const stop = () => new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      done();
      return;
    }
    child.once('exit', () => done());
    child.kill();
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Relay did not start within ${STARTUP_TIMEOUT_MS} ms.\n${stdout}\n${stderr}`));
    }, STARTUP_TIMEOUT_MS);

    const onEarlyExit = (code) => {
      clearTimeout(timer);
      reject(new Error(`Relay exited early with code ${code}.\n${stdout}\n${stderr}`));
    };
    child.once('exit', onEarlyExit);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/listening on http:\/\/localhost:(\d+)/i);
      if (!match) return;

      clearTimeout(timer);
      child.off('exit', onEarlyExit);
      const port = Number(match[1]);
      resolve({
        port,
        httpUrl: (pathname = '/') => `http://127.0.0.1:${port}${pathname}`,
        wsUrl: (query = '') => `ws://127.0.0.1:${port}/ws${query}`,
        logs: () => `${stdout}\n${stderr}`,
        stop,
      });
    });
  });
}
