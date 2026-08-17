from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str):
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: {label}: expected one match, found {count}')
    target.write_text(text.replace(old, new, 1))


replace_once(
    'src/audio-session.ts',
    """ * The clamp further down stays as a backstop regardless: the limiter only holds
 * down the voice, and the voice plus the song can still overflow.
 */
export const LIMITER_THRESHOLD_DBFS = -1;
const LIMITER_THRESHOLD = 10 ** (LIMITER_THRESHOLD_DBFS / 20);
const LIMITER_ATTACK_MS = 1.5;
const LIMITER_RELEASE_MS = 150;
const LIMITER_LOOKAHEAD_MS = 3;
""",
    """ * The final two-source sum also reserves fixed headroom. That keeps ordinary
 * voice + song peaks out of the hard clamp without adding a second dynamic
 * limiter that would pump the whole mix and change the singer/song balance.
 */
export const LIMITER_THRESHOLD_DBFS = -1;
const LIMITER_THRESHOLD = 10 ** (LIMITER_THRESHOLD_DBFS / 20);
const LIMITER_ATTACK_MS = 1.5;
const LIMITER_RELEASE_MS = 150;
const LIMITER_LOOKAHEAD_MS = 3;

/**
 * Worst-case linear sum after the microphone limiter plus the configured song
 * gain. A fixed attenuation preserves their relative balance and introduces no
 * attack/release artefacts. Voice-only rooms deliberately stay at unity.
 */
function sumHeadroomGain(backingGain: number) {
  const maximumLinearSum = LIMITER_THRESHOLD + Math.abs(backingGain);
  return maximumLinearSum > 1 ? 1 / maximumLinearSum : 1;
}
""",
    'document and define mix headroom',
)

replace_once(
    'src/audio-session.ts',
    """  private readonly backingGain: number;
  private readonly retentionSamples: number;
""",
    """  private readonly backingGain: number;
  private readonly backingSumHeadroomGain: number;
  private readonly retentionSamples: number;
""",
    'add headroom field',
)

replace_once(
    'src/audio-session.ts',
    """    this.prebufferMs = options.prebufferMs;
    this.backingGain = options.backingGain;
    this.retentionMs = options.retentionMs;
""",
    """    this.prebufferMs = options.prebufferMs;
    this.backingGain = options.backingGain;
    this.backingSumHeadroomGain = sumHeadroomGain(options.backingGain);
    this.retentionMs = options.retentionMs;
""",
    'compute headroom gain',
)

replace_once(
    'src/audio-session.ts',
    """    const mic = this.readRange(this.mic, micReadStart, this.frameSamples + lookahead);
    const song = this.readRange(this.backing, startSample, this.frameSamples);
    const micGain = 10 ** (this.micGainDb / 20);
    const output = Buffer.allocUnsafe(this.frameSamples * 2);

    for (let i = 0; i < this.frameSamples; i += 1) {
      const voice = this.limit((mic[i] / 32768) * micGain, (mic[i + lookahead] / 32768) * micGain);
      const value = voice + (song[i] / 32768) * this.backingGain;
      // The limiter holds the voice under the threshold, so anything reaching
      // here is the sum overflowing. Clamping keeps the wraparound crack out of
      // the mix but is still distortion, so count it rather than hide it.
      if (value > 1 || value < -1) this.clippedSamples += 1;
""",
    """    const mic = this.readRange(this.mic, micReadStart, this.frameSamples + lookahead);
    const song = this.readRange(this.backing, startSample, this.frameSamples);
    const micGain = 10 ** (this.micGainDb / 20);
    // `backingExpected` is the room's semantic signal that this is a two-source
    // mix. Do not attenuate voice-only rooms merely because a stale backing
    // timeline still exists from an earlier route.
    const mixHeadroomGain = this.backingExpected ? this.backingSumHeadroomGain : 1;
    const output = Buffer.allocUnsafe(this.frameSamples * 2);

    for (let i = 0; i < this.frameSamples; i += 1) {
      const voice = this.limit((mic[i] / 32768) * micGain, (mic[i + lookahead] / 32768) * micGain);
      const summed = voice + (song[i] / 32768) * this.backingGain;
      const value = summed * mixHeadroomGain;
      // Normal two-source peaks have already had deterministic summing headroom
      // reserved. Keep this clamp as an invariant/backstop for unexpected future
      // inputs or limiter overshoot, and keep counting it as audible distortion.
      if (value > 1 || value < -1) this.clippedSamples += 1;
""",
    'apply post-sum headroom',
)

replace_once(
    'test/audio-session.test.ts',
    """    assert.ok(Math.abs(peakMs - 400) < 5, `expected both events at ~400 ms, peak at ${peakMs.toFixed(1)} ms`);
    assert.ok(peak.value > 20_000, `the two should sum, got ${peak.value}`);
""",
    """    assert.ok(Math.abs(peakMs - 400) < 5, `expected both events at ~400 ms, peak at ${peakMs.toFixed(1)} ms`);
    assert.ok(
      peak.value > 12_000,
      `the two should still sum after deterministic bus headroom, got ${peak.value}`,
    );
""",
    'update aligned mix amplitude contract',
)

replace_once(
    'test/audio-session.test.ts',
    """  test('still reports a clamp when the sum overflows despite the limiter', () => {
    // The limiter only holds the voice down; the song is added after it.
    const session = makeSession({ backingGain: 1 });
    session.setMicGainDb(36);
    session.start(0);
    session.ingestMic(frame(0, sung(1, 3_200)), RATE, 0);
    session.ingestBacking(frame(0, pcmOf(new Array(RATE).fill(30_000))), RATE, 0);

    drainAll(session, 500);
    assert.ok(session.health().clippedSamples > 0, 'the backstop still has to report itself');
  });
""",
    """  test('reserves summing headroom before a hot voice and song can reach the clamp', () => {
    const session = makeSession({ backingGain: 1 });
    session.setMicGainDb(36);
    session.setBackingExpected(true);
    session.start(0);
    session.ingestMic(frame(0, sung(1, 3_200)), RATE, 0);
    session.ingestBacking(frame(0, pcmOf(new Array(RATE).fill(30_000))), RATE, 0);

    const mixed = drainAll(session, 500);
    assert.equal(
      session.health().clippedSamples,
      0,
      'normal two-source gain staging must not depend on the hard clamp',
    );
    assert.ok(session.health().limitedSamples > 0, 'the microphone limiter still owns vocal peaks');
    assert.ok(peakSampleIndex(mixed).value < 32_767, 'the mixed bus keeps real headroom');
  });
""",
    'turn overflow characterization into no-clipping regression',
)

anchor = """  test('does not carry limiter gain reduction into the next session', () => {
"""
voice_only_test = """  test('does not attenuate a voice-only room for backing headroom', () => {
    const session = makeSession({ backingGain: 1 });
    session.setMicGainDb(0);
    session.start(0);
    session.ingestMic(frame(0, pcmOf(new Array(RATE).fill(1_000))), RATE, 0);

    const mixed = drainAll(session, 20);
    assert.equal(mixed.readInt16LE(0), 1_000, 'voice-only output stays at unity');
    assert.equal(session.health().clippedSamples, 0);
  });

"""
path = Path('test/audio-session.test.ts')
text = path.read_text()
count = text.count(anchor)
if count != 1:
    raise SystemExit(f'test/audio-session.test.ts: voice-only anchor: expected one match, found {count}')
path.write_text(text.replace(anchor, voice_only_test + anchor, 1))
