import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_AUDIO_TRANSPORT_CONFIG,
  loadAudioTransportConfig,
} from '../src/audio-transport-config.js';
import { startRelay } from './helpers/harness.js';

describe('audio transport configuration', () => {
  it('has one explicit set of defaults', () => {
    assert.deepEqual(loadAudioTransportConfig({}), DEFAULT_AUDIO_TRANSPORT_CONFIG);
    assert.deepEqual(DEFAULT_AUDIO_TRANSPORT_CONFIG, {
      reorderWindowPackets: 8,
      reorderDeadlineMs: 40,
      maxForwardJumpPackets: 256,
    });
  });

  it('accepts explicit zero window/deadline and a positive forward bound', () => {
    assert.deepEqual(loadAudioTransportConfig({
      RELAY_AUDIO_REORDER_WINDOW_PACKETS: '0',
      RELAY_AUDIO_REORDER_DEADLINE_MS: '0',
      RELAY_AUDIO_MAX_FORWARD_JUMP_PACKETS: '12',
    }), {
      reorderWindowPackets: 0,
      reorderDeadlineMs: 0,
      maxForwardJumpPackets: 12,
    });
  });

  for (const [name, value] of [
    ['RELAY_AUDIO_REORDER_WINDOW_PACKETS', '-1'],
    ['RELAY_AUDIO_REORDER_WINDOW_PACKETS', '1.5'],
    ['RELAY_AUDIO_REORDER_DEADLINE_MS', '-1'],
    ['RELAY_AUDIO_REORDER_DEADLINE_MS', 'forty'],
    ['RELAY_AUDIO_MAX_FORWARD_JUMP_PACKETS', '0'],
    ['RELAY_AUDIO_MAX_FORWARD_JUMP_PACKETS', ''],
  ] as const) {
    it(`rejects invalid ${name}=${JSON.stringify(value)} instead of silently using a default`, () => {
      assert.throws(() => loadAudioTransportConfig({ [name]: value }), new RegExp(name));
    });
  }

  it('rejects a reorder window wider than the accepted forward-jump domain', () => {
    assert.throws(() => loadAudioTransportConfig({
      RELAY_AUDIO_REORDER_WINDOW_PACKETS: '20',
      RELAY_AUDIO_MAX_FORWARD_JUMP_PACKETS: '10',
    }), /cannot exceed/);
  });

  it('keeps sequence-distance tuning inside the unambiguous half of uint32 space', () => {
    assert.throws(() => loadAudioTransportConfig({
      RELAY_AUDIO_MAX_FORWARD_JUMP_PACKETS: String(0x8000_0000),
    }), /RELAY_AUDIO_MAX_FORWARD_JUMP_PACKETS/);
  });

  it('fails the real server before listen when deployment tuning is invalid', async () => {
    await assert.rejects(
      () => startRelay({ RELAY_AUDIO_REORDER_WINDOW_PACKETS: 'not-a-number' }),
      /RELAY_AUDIO_REORDER_WINDOW_PACKETS must be an integer/,
    );
  });
});
