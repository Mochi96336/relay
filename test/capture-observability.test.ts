import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  captureLevelSnapshot,
  readCaptureSettings,
} from '../public/capture-observability.js';

describe('capture observability', () => {
  test('reports the settings the browser actually applied', () => {
    const stream = {
      getAudioTracks: () => [{
        getSettings: () => ({
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: false,
        }),
      }],
    };

    assert.deepEqual(readCaptureSettings(stream, { audioSession: { type: 'play-and-record' } }), {
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: false,
      audioSessionType: 'play-and-record',
    });
  });

  test('keeps unsupported capture settings null instead of echoing requested constraints', () => {
    const stream = {
      getAudioTracks: () => [{
        getSettings: () => ({
          echoCancellation: 'unknown',
          noiseSuppression: undefined,
          autoGainControl: 0,
        }),
      }],
    };

    assert.deepEqual(readCaptureSettings(stream, {}), {
      echoCancellation: null,
      noiseSuppression: null,
      autoGainControl: null,
      audioSessionType: null,
    });
  });

  test('fails closed when getSettings is unavailable or throws', () => {
    assert.equal(readCaptureSettings({ getAudioTracks: () => [{}] }, {}), null);
    assert.equal(readCaptureSettings({
      getAudioTracks: () => [{ getSettings: () => { throw new Error('unsupported'); } }],
    }, {}), null);
    assert.equal(readCaptureSettings(null, {}), null);
  });

  test('projects only physically valid finite worklet levels', () => {
    assert.deepEqual(captureLevelSnapshot({ peakDbfs: -18, rmsDbfs: -31 }), {
      peakDbfs: -18,
      rmsDbfs: -31,
    });
    assert.equal(captureLevelSnapshot({ peakDbfs: 1, rmsDbfs: -20 }), null);
    assert.equal(captureLevelSnapshot({ peakDbfs: -30, rmsDbfs: -20 }), null);
    assert.equal(captureLevelSnapshot({ peakDbfs: Number.NEGATIVE_INFINITY, rmsDbfs: -50 }), null);
    assert.equal(captureLevelSnapshot({ peakDbfs: '-18', rmsDbfs: '-31' }), null);
  });
});