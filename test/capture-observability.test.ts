import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  captureLevelSnapshot,
  captureVoiceProcessingActive,
  enforceUnprocessedCapture,
  readCaptureSettings,
} from '../public/capture-observability.js';

describe('capture observability', () => {

  test('exactly disables only browser voice processing proven controllable', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const track = {
      getSettings: () => ({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      }),
      getCapabilities: () => ({
        echoCancellation: [true, false],
        noiseSuppression: [true],
        autoGainControl: [true, false],
      }),
      getConstraints: () => ({
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }),
      applyConstraints: async (constraints: Record<string, unknown>) => {
        calls.push(constraints);
      },
    };
    const changed = await enforceUnprocessedCapture({ getAudioTracks: () => [track] });

    assert.equal(changed, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      channelCount: 1,
      echoCancellation: { exact: false },
      noiseSuppression: false,
      autoGainControl: false,
    });
  });

  test('capture cleanup is fail-open when capabilities cannot prove false', async () => {
    let called = false;
    const changed = await enforceUnprocessedCapture({
      getAudioTracks: () => [{
        getSettings: () => ({ echoCancellation: true }),
        getCapabilities: () => ({ echoCancellation: [true] }),
        applyConstraints: async () => { called = true; },
      }],
    });
    assert.equal(changed, false);
    assert.equal(called, false);
  });

  test('capture cleanup keeps earlier successful exact constraints when a later one fails', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const track = {
      getSettings: () => ({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      }),
      getCapabilities: () => ({
        echoCancellation: [true, false],
        noiseSuppression: [true, false],
      }),
      getConstraints: () => ({ channelCount: 1 }),
      applyConstraints: async (constraints: Record<string, unknown>) => {
        calls.push(constraints);
        if ('noiseSuppression' in constraints) throw new Error('not jointly available');
      },
    };
    const changed = await enforceUnprocessedCapture({ getAudioTracks: () => [track] });

    assert.equal(changed, true);
    assert.deepEqual(calls, [
      { channelCount: 1, echoCancellation: { exact: false } },
      {
        channelCount: 1,
        echoCancellation: { exact: false },
        noiseSuppression: { exact: false },
      },
    ]);
  });

  test('voice-processing warning is driven only by browser-applied true settings', () => {
    assert.equal(captureVoiceProcessingActive({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      audioSessionType: 'play-and-record',
    }), false);
    assert.equal(captureVoiceProcessingActive({
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: false,
      audioSessionType: null,
    }), true);
    assert.equal(captureVoiceProcessingActive({
      echoCancellation: null,
      noiseSuppression: null,
      autoGainControl: null,
      audioSessionType: null,
    }), false);
    assert.equal(captureVoiceProcessingActive(null), false);
  });

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

  test('bounds browser-reported audio session type before telemetry', () => {
    const stream = {
      getAudioTracks: () => [{ getSettings: () => ({}) }],
    };

    assert.equal(
      readCaptureSettings(stream, { audioSession: { type: 'x'.repeat(65) } })?.audioSessionType,
      null,
    );
    assert.equal(
      readCaptureSettings(stream, { audioSession: { type: '' } })?.audioSessionType,
      null,
    );
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
