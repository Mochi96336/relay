import assert from 'node:assert/strict';
import test from 'node:test';

// youtube-local-audibility.js and youtube-song-metadata.js wrap YT.Player and
// keep one reference. choir-follower.js builds the second singer's player
// through the same constructor and destroys it on leaving: neither module
// may switch to that player, in either creation order or on a late onReady.

type Listener = (event: any) => void;

class FakeWindow extends EventTarget {
  YT: { Player: any };
  onYouTubeIframeAPIReady?: () => void;
  constructor(Player: any) { super(); this.YT = { Player }; }
}

class Player {
  muted = false;
  retired = false;
  options: any;
  constructor(public target: unknown, options: any) { this.options = options; }
  mute() { if (!this.retired) this.muted = true; }
  unMute() { if (!this.retired) this.muted = false; }
  isMuted() { return this.muted; }
  destroy() { this.retired = true; }
  getVideoData() {
    if (this.retired) throw new Error('retired');
    return this.target === 'youtube-player'
      ? { video_id: 'roomVideo01', title: 'Room song', author: 'Room artist' }
      : { video_id: 'roomVideo01', title: 'Follower copy', author: 'Follower' };
  }
}

async function load() {
  const fakeWindow = new FakeWindow(Player);
  (globalThis as any).window = fakeWindow;
  for (const name of ['youtube-local-audibility', 'youtube-song-metadata']) {
    const url = new URL(`../public/${name}.js`, import.meta.url);
    url.searchParams.set('t', `${Date.now()}-${Math.random()}`);
    await import(url.href);
  }
  const emit = (type: string, detail: any) => {
    fakeWindow.dispatchEvent(new CustomEvent(type, { detail }));
    return detail;
  };
  const review = (main: Player) => {
    emit('relay:playback-view', { role: 'holder' });
    emit('relay-take-review-playback', { active: true });
    const mutedDuring = main.isMuted();
    emit('relay-take-review-playback', { active: false });
    return { mutedDuring, mutedAfter: main.isMuted() };
  };
  const telemetry = () => emit('relay:youtube-telemetry', { videoId: 'roomVideo01' });
  const make = (target: unknown, onReady?: Listener) =>
    new fakeWindow.YT.Player(target, { events: onReady ? { onReady } : {} }) as Player;
  return { review, telemetry, make, emit };
}

const followerMount = () => ({ id: '' });
const roomSong = { videoId: 'roomVideo01', videoTitle: 'Room song', videoAuthor: 'Room artist' };

test('a follower made after the room player and destroyed leaves review and metadata on the room player', async () => {
  const page = await load();
  const previousWindow = (globalThis as any).window;
  try {
    const main = page.make('youtube-player');
    const follower = page.make(followerMount());
    follower.mute();
    follower.destroy();
    assert.deepEqual(page.review(main), { mutedDuring: true, mutedAfter: false });
    assert.deepEqual(page.telemetry(), roomSong);
  } finally {
    page.emit('beforeunload', {});
    (globalThis as any).window = previousWindow;
  }
});

test('a follower made first, or whose onReady arrives after it was destroyed, is never the room player', async () => {
  const page = await load();
  const previousWindow = (globalThis as any).window;
  try {
    const follower = page.make(followerMount(), () => {});
    const followerReady: Listener = follower.options.events.onReady;
    const main = page.make('youtube-player');
    follower.destroy();
    followerReady({ target: follower });
    assert.deepEqual(page.review(main), { mutedDuring: true, mutedAfter: false });
    assert.deepEqual(page.telemetry(), roomSong);
  } finally {
    page.emit('beforeunload', {});
    (globalThis as any).window = previousWindow;
  }
});
