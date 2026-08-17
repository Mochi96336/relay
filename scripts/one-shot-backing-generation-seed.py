from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: {label}: expected one match, found {count}')
    target.write_text(text.replace(old, new, 1))


replace_once(
    'chrome-tab-audio-probe/offscreen.js',
    """let captureGeneration = 0;\nlet captureSampleCursor = 0;\n""",
    """// The offscreen document is disposable: Chrome may tear it down and later\n// recreate it while Relay still retains the previous backing timeline. A\n// module-local zero would therefore reuse generation 1 with sample cursor 0,\n// making the new capture look like late data from the old incarnation. Seed\n// each offscreen document independently so recreation is a fresh capture.\nlet captureGeneration = crypto.getRandomValues(new Uint32Array(1))[0];\nlet captureSampleCursor = 0;\n""",
    'seed backing capture generation per offscreen incarnation',
)
replace_once(
    'chrome-tab-audio-probe/offscreen.js',
    """  captureGeneration += 1;\n  captureSampleCursor = 0;\n""",
    """  captureGeneration = (captureGeneration + 1) >>> 0;\n  captureSampleCursor = 0;\n""",
    'keep backing generation in wire uint32 domain',
)

Path('test/backing-generation-recreation.test.ts').write_text("""import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AudioSession } from '../src/audio-session.js';

const offscreen = readFileSync(
  new URL('../chrome-tab-audio-probe/offscreen.js', import.meta.url),
  'utf8',
);

function pcm(value: number, samples = 960) {
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) buffer.writeInt16LE(value, index * 2);
  return buffer;
}

test('Chrome offscreen capture does not restart every document at generation 1', () => {
  assert.match(
    offscreen,
    /let captureGeneration = crypto\.getRandomValues\(new Uint32Array\(1\)\)\[0\]/,
    'offscreen recreation must establish a fresh backing capture incarnation',
  );
  assert.match(offscreen, /captureGeneration = \(captureGeneration \+ 1\) >>> 0/);
  assert.doesNotMatch(offscreen, /let captureGeneration = 0/);
});

test('reusing a backing generation with cursor zero is dropped, while a new generation re-anchors', () => {
  const session = new AudioSession({
    sampleRate: 48_000,
    frameMs: 20,
    prebufferMs: 0,
    backingGain: 0.65,
    retentionMs: 3_000,
  });
  session.start(0);

  const first = session.ingestBacking({
    pcm: pcm(1000),
    generation: 7,
    firstSampleIndex: 0,
  }, 48_000, 100);
  assert.equal(first.samples.length, 960);

  const second = session.ingestBacking({
    pcm: pcm(1000),
    generation: 7,
    firstSampleIndex: 960,
  }, 48_000, 120);
  assert.equal(second.samples.length, 960);

  const collidedReload = session.ingestBacking({
    pcm: pcm(2000),
    generation: 7,
    firstSampleIndex: 0,
  }, 48_000, 500);
  assert.equal(
    collidedReload.samples.length,
    0,
    'same generation + reset cursor is indistinguishable from fully late old PCM',
  );

  const freshReload = session.ingestBacking({
    pcm: pcm(2000),
    generation: 8,
    firstSampleIndex: 0,
  }, 48_000, 500);
  assert.equal(freshReload.samples.length, 960);
  assert.equal(session.backingGeneration, 8);
});
""")
