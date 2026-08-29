import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { AudioSession } from '../src/audio-session.js';

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
  const root = process.cwd();
  const server = fs.readFileSync(path.join(root, 'src/server.ts'), 'utf8');
  const audio = fs.readFileSync(path.join(root, 'src/audio-session.ts'), 'utf8');

  assert.doesNotMatch(server, /let\s+micGainDb\s*=/);
  assert.doesNotMatch(server, /session\.setMicGainDb\(micGainDb\)/);
  assert.equal((server.match(/micGainDb:\s*session\.micGainDb/g) ?? []).length, 2);
  assert.match(
    server,
    /if \(payload\.type === 'set-mix'\)[\s\S]*requireMicOwnerCommand\(socket, 'set-mix'\)[\s\S]*session\.setMicGainDb\(Math\.max\(0, Math\.min\(MAX_MIC_GAIN_DB, nextGain\)\)\)/,
  );

  assert.match(audio, /private micGainDbValue = 24;/);
  assert.match(audio, /get micGainDb\(\) \{\s*return this\.micGainDbValue;\s*\}/);
  assert.match(audio, /setMicGainDb\(value: number\) \{\s*this\.micGainDbValue = value;\s*\}/);
  assert.doesNotMatch(
    audio,
    /setMicGainDb\(value: number\) \{[\s\S]{0,200}(Math\.min|Math\.max|MAX_MIC_GAIN_DB|requireMicOwnerCommand)/,
    'AudioSession must store the DSP value, not absorb command authorization or clamping policy',
  );
});
