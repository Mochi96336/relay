import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import {
  classMethodCode,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

function makeSession() {
  return new AudioSession({
    sampleRate: 48_000,
    frameMs: 20,
    prebufferMs: 400,
    backingGain: 0.65,
    retentionMs: 3_000,
    backingRetentionMs: 6_000,
  });
}

test('AudioSession is the single source of truth for the applied Mic gain', () => {
  const session = makeSession();
  assert.equal(session.micGainDb, 24);

  session.setMicGainDb(12.5);
  assert.equal(session.micGainDb, 12.5);
});

test('server owns Mic gain command policy while AudioSession owns the applied value', () => {
  const server = parseTypeScriptSource(
    new URL('../src/server.ts', import.meta.url),
    readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
  );
  const audio = parseTypeScriptSource(
    new URL('../src/audio-session.ts', import.meta.url),
    readFileSync(new URL('../src/audio-session.ts', import.meta.url), 'utf8'),
  );
  const serverCode = sourceCode(server);
  const audioCode = sourceCode(audio);

  assert.doesNotMatch(serverCode, /let\s+micGainDb\s*=/);
  assert.doesNotMatch(serverCode, /session\.setMicGainDb\(micGainDb\)/);
  assert.equal((serverCode.match(/micGainDb:\s*session\.micGainDb/g) ?? []).length, 2);

  const commands = variableInitializerCode(server, 'commandProtocol');
  const setMix = commands.indexOf('setMix: (socket, payload) => {');
  const authority = commands.indexOf("requireMicOwnerCommand(socket, 'set-mix')", setMix);
  const parseGain = commands.indexOf('const nextGain = Number(payload.micGainDb);', authority);
  const applyGain = commands.indexOf(
    'session.setMicGainDb(Math.max(0, Math.min(MAX_MIC_GAIN_DB, nextGain)))',
    parseGain,
  );
  const publishMix = commands.indexOf('broadcastJson(mixSettingsPayload())', applyGain);
  assert.ok(setMix >= 0, 'set-mix command handler must exist');
  assert.ok(authority > setMix, 'Mic ownership must authorize gain mutation before parsing/applying it');
  assert.ok(parseGain > authority, 'gain parsing must remain behind command authority');
  assert.ok(applyGain > parseGain, 'server command policy must clamp before storing the DSP value');
  assert.ok(publishMix > applyGain, 'accepted gain mutation must publish the resulting mix settings');

  assert.ok(audioCode.includes('private micGainDbValue = 24;'));
  const getter = classMethodCode(audio, 'AudioSession', 'micGainDb');
  assert.ok(getter.includes('return this.micGainDbValue;'));

  const setter = classMethodCode(audio, 'AudioSession', 'setMicGainDb');
  assert.ok(setter.includes('this.micGainDbValue = value;'));
  assert.doesNotMatch(
    setter,
    /Math\.min|Math\.max|MAX_MIC_GAIN_DB|requireMicOwnerCommand/,
    'AudioSession must store the DSP value, not absorb command authorization or clamping policy',
  );
});
