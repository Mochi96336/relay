import assert from 'node:assert/strict';
import test from 'node:test';
import { roomSoundPresentation } from '../public/room-sound-presentation.js';

test('Room sound preserves start failure instead of collapsing it into user mute', () => {
  assert.deepEqual(
    roomSoundPresentation({ state: 'muted', phase: 'start-failed' }, false),
    {
      toggle: 'Turn on',
      note: 'Could not start room sound. Tap again to retry.',
    },
  );
  assert.deepEqual(
    roomSoundPresentation({ state: 'muted', phase: 'start-failed' }, true),
    {
      toggle: '開啟',
      note: '無法啟動房間聲音，再點一下重試',
    },
  );
});

test('Room sound reports transport recovery even when playback state is otherwise audible', () => {
  assert.equal(
    roomSoundPresentation({ state: 'audible', phase: 'reconnecting' }).note,
    'Reconnecting room sound…',
  );
  assert.equal(
    roomSoundPresentation({ state: 'audible', phase: 'buffering' }).note,
    'Buffering room sound…',
  );
  assert.equal(
    roomSoundPresentation({ state: 'audible', phase: 'playing' }).note,
    '',
  );
});

test('forced Room sound reasons remain dominant over transient phases', () => {
  assert.deepEqual(
    roomSoundPresentation({ state: 'mic-muted', phase: 'reconnecting' }, true),
    { toggle: '暫停中', note: '唱歌時暫停' },
  );
  assert.deepEqual(
    roomSoundPresentation({ state: 'playback-muted', phase: 'buffering' }, true),
    { toggle: '暫停中', note: '這支裝置正在播放伴奏' },
  );
  assert.deepEqual(
    roomSoundPresentation({ state: 'review-muted', phase: 'take-review' }, true),
    { toggle: '暫停中', note: '正在播放錄音' },
  );
});

test('ready Room sound still asks for the browser interaction needed to start audio', () => {
  assert.deepEqual(
    roomSoundPresentation({ state: 'ready', phase: 'first-interaction' }, true),
    { toggle: '靜音', note: '點一下以啟用房間聲音' },
  );
});
