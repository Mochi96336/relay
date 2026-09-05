import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayTakeCommandCoordinator } from '../src/relay-take-command-coordinator.js';

test('Take start preserves boundary, validation, commit and acceptance ordering', () => {
  const calls: string[] = [];
  const socket = { id: 'socket' };
  const coordinator = createRelayTakeCommandCoordinator({
    frameBoundary: (nowMs: number) => {
      calls.push(`boundary:${nowMs}`);
      return { atMs: 110, position: { generation: 2, firstSampleIndex: 480 } };
    },
    songSnapshot: (atMs: number) => {
      calls.push(`song:${atMs}`);
      return { videoId: 'video' };
    },
    cancelActiveContentValidation: (nowMs: number) => {
      calls.push(`cancel-validation:${nowMs}`);
      return true;
    },
    standDownContentCalibration: () => {
      calls.push('stand-down-calibration');
      return true;
    },
    reportTimingStatus: () => calls.push('timing-status'),
    startTake: (participantId, song, position, wallClockMs) => {
      calls.push(`start:${participantId}:${song.videoId}:${position.firstSampleIndex}:${wallClockMs}`);
      return { ok: true as const, takeId: 'take-1' };
    },
    stopTake: () => ({ ok: false as const, reason: 'unused' }),
    reject: () => calls.push('reject'),
    acceptStart: (_socket, takeId) => calls.push(`accept-start:${takeId}`),
    acceptStop: () => calls.push('accept-stop'),
  });

  assert.equal(coordinator.start({
    socket,
    participantId: 'participant-1',
    commandWallClockMs: 1_000,
    nowMs: 100,
  }), true);
  assert.deepEqual(calls, [
    'boundary:100',
    'song:110',
    'cancel-validation:100',
    'timing-status',
    'start:participant-1:video:480:1010',
    'stand-down-calibration',
    'timing-status',
    'accept-start:take-1',
  ]);
});

test('a rejected Take start leaves the background content measurement running', () => {
  const calls: string[] = [];
  const coordinator = createRelayTakeCommandCoordinator({
    frameBoundary: () => ({ atMs: 20, position: 30 }),
    songSnapshot: () => null,
    cancelActiveContentValidation: () => {
      calls.push('cancel-validation');
      return false;
    },
    standDownContentCalibration: () => {
      calls.push('stand-down-calibration');
      return true;
    },
    reportTimingStatus: () => calls.push('timing-status'),
    startTake: () => {
      calls.push('start');
      return { ok: false as const, reason: 'take-active' };
    },
    stopTake: () => ({ ok: false as const, reason: 'unused' }),
    reject: (_socket, command, reason) => calls.push(`reject:${command}:${reason}`),
    acceptStart: () => calls.push('accept-start'),
    acceptStop: () => calls.push('accept-stop'),
  });

  assert.equal(coordinator.start({
    socket: {},
    participantId: 'participant-1',
    commandWallClockMs: 100,
    nowMs: 10,
  }), false);
  assert.deepEqual(calls, ['cancel-validation', 'start', 'reject:start:take-active']);
});

test('Take stop preserves boundary, controller commit and duplicate acceptance', () => {
  const calls: string[] = [];
  const coordinator = createRelayTakeCommandCoordinator({
    frameBoundary: (nowMs: number) => {
      calls.push(`boundary:${nowMs}`);
      return { atMs: 215, position: { generation: 4, firstSampleIndex: 960 } };
    },
    songSnapshot: () => null,
    cancelActiveContentValidation: () => false,
    standDownContentCalibration: () => {
      calls.push('stand-down-calibration');
      return true;
    },
    reportTimingStatus: () => calls.push('timing-status'),
    startTake: () => ({ ok: false as const, reason: 'unused' }),
    stopTake: (takeId, participantId, position, reason, wallClockMs) => {
      calls.push(`stop:${takeId}:${participantId}:${position.firstSampleIndex}:${reason}:${wallClockMs}`);
      return { ok: true as const, duplicate: true };
    },
    reject: () => calls.push('reject'),
    acceptStart: () => calls.push('accept-start'),
    acceptStop: (_socket, takeId, duplicate) => calls.push(`accept-stop:${takeId}:${duplicate}`),
  });

  assert.equal(coordinator.stop({
    socket: {},
    participantId: 'participant-2',
    takeId: 'take-2',
    commandWallClockMs: 2_000,
    nowMs: 200,
  }), true);
  assert.deepEqual(calls, [
    'boundary:200',
    'stop:take-2:participant-2:960:user:2015',
    'accept-stop:take-2:true',
  ]);
});
