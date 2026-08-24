import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { authorityState } from '../public/authority-freshness.js';

const micActionsSource = readFileSync(new URL('../public/mic-actions.js', import.meta.url), 'utf8');
const recordingUiSource = readFileSync(new URL('../public/recording-ui.js', import.meta.url), 'utf8');
const liveI18nSource = readFileSync(new URL('../public/live-i18n.js', import.meta.url), 'utf8');
const liveStatusSource = readFileSync(new URL('../public/live-status.js', import.meta.url), 'utf8');
const publisherSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const presenceSource = readFileSync(new URL('../public/presence.js', import.meta.url), 'utf8');

function presenterBody(source: string) {
  return source.replace(/^import '\.\/live-i18n\.js';\s*/, '');
}

class FakeElement {
  hidden = false;
  disabled = false;
  textContent = '';
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
}

function eventWindow() {
  const listeners = new Map<string, Array<(event: any) => void>>();
  return {
    listeners,
    addEventListener(type: string, listener: (event: any) => void) {
      const current = listeners.get(type) ?? [];
      current.push(listener);
      listeners.set(type, current);
    },
    dispatchEvent(event: any) {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
    emit(type: string, detail: any) {
      for (const listener of listeners.get(type) ?? []) listener({ type, detail });
    },
  };
}

test('shared authority contract requires fresh snapshot, fresh command channel, authorization and server allowance', () => {
  const base = {
    authorityFresh: true,
    lastKnownSnapshot: { revision: 8 },
    commandChannelFresh: true,
    authorized: true,
    serverAllowed: true,
  };
  assert.equal(authorityState(base).actionable, true);

  for (const key of ['authorityFresh', 'commandChannelFresh', 'authorized', 'serverAllowed'] as const) {
    assert.equal(authorityState({ ...base, [key]: false }).actionable, false, key);
  }

  const stale = authorityState({ ...base, authorityFresh: false });
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.lastKnownSnapshot, { revision: 8 });
});

test('production Mic action presenter disables stale actions and does not expose pending Cancel as actionable', () => {
  const events = eventWindow();
  const nodes = new Map<string, FakeElement>([
    ['#start-publisher', new FakeElement()],
    ['#release-mic', new FakeElement()],
    ['#mic-takeover', new FakeElement()],
    ['#mic-takeover-copy', new FakeElement()],
    ['#confirm-takeover', new FakeElement()],
    ['#cancel-takeover', new FakeElement()],
  ]);
  const document = { querySelector: (selector: string) => nodes.get(selector) ?? null };
  const window = {
    ...events,
    relayI18n: { getLocale: () => 'en', t: (key: string) => key, has: () => false },
    relayMicActionState: null,
  };
  class Event { constructor(public type: string) {} }
  const context = { window, document, Event };
  runInNewContext(liveI18nSource, context);
  runInNewContext(presenterBody(micActionsSource), context);

  events.emit('relay-mic-action-state', {
    authorityFresh: false,
    commandChannelFresh: false,
    owner: { id: 'other', nickname: 'Other' },
    releaseVisible: false,
    primaryMode: 'takeover',
    primaryActionable: false,
    takeoverOpen: true,
    takeoverPending: false,
    takeoverConfirmActionable: false,
    takeoverCancelActionable: false,
  });
  assert.equal(nodes.get('#start-publisher')?.disabled, true);
  assert.equal(nodes.get('#confirm-takeover')?.disabled, true);
  assert.equal(nodes.get('#cancel-takeover')?.disabled, true);
  assert.equal(nodes.get('#mic-takeover-copy')?.textContent, 'Reconnecting');

  events.emit('relay-mic-action-state', {
    authorityFresh: true,
    commandChannelFresh: true,
    owner: { id: 'other', nickname: 'Other' },
    releaseVisible: false,
    primaryMode: 'takeover',
    primaryActionable: true,
    takeoverOpen: true,
    takeoverPending: false,
    takeoverConfirmActionable: true,
    takeoverCancelActionable: true,
  });
  assert.equal(nodes.get('#confirm-takeover')?.disabled, false);
  assert.equal(nodes.get('#cancel-takeover')?.disabled, false);
  assert.equal(nodes.get('#confirm-takeover')?.textContent, 'Take over Mic');

  events.emit('relay-mic-action-state', {
    authorityFresh: true,
    commandChannelFresh: true,
    owner: { id: 'other', nickname: 'Other' },
    releaseVisible: false,
    primaryMode: 'takeover',
    primaryActionable: true,
    takeoverOpen: true,
    takeoverPending: true,
    takeoverConfirmActionable: false,
    takeoverCancelActionable: false,
  });
  assert.equal(nodes.get('#cancel-takeover')?.disabled, true,
    'pending takeover must not advertise a Cancel that the controller cannot honor');
});

test('production recording presenter freezes last-known timer while Take authority is stale', () => {
  const events = eventWindow();
  const strip = new FakeElement();
  const start = new FakeElement();
  const stop = new FakeElement();
  const status = new FakeElement();
  const document = {
    querySelector(selector: string) {
      if (selector === '.take-strip') return strip;
      if (selector === '#start-recording') return start;
      if (selector === '#stop-recording') return stop;
      if (selector === '#recording-status') return status;
      return null;
    },
  };
  let now = 10_000;
  class FakeDate extends Date {
    static now() { return now; }
  }
  class Event { constructor(public type: string) {} }
  const window = {
    ...events,
    relayI18n: { getLocale: () => 'en' },
    relayRecordingState: null,
  };
  const context = {
    window,
    document,
    Event,
    Date: FakeDate,
    queueMicrotask,
    setTimeout,
    clearTimeout,
  };
  runInNewContext(liveI18nSource, context);
  runInNewContext(presenterBody(recordingUiSource), context);

  const stale = {
    lifecycle: 'recording',
    take: { takeId: 'take-1234', startedAtMs: 1_000 },
    canStart: false,
    canStop: false,
    authorityFresh: false,
    commandChannelFresh: false,
    snapshotObservedAt: 5_000,
    commandError: null,
  };
  events.emit('relay-recording-state', stale);
  assert.equal(status.textContent, '● 0:04 · Reconnecting…');
  assert.equal(stop.hidden, false,
    'stale recording authority must keep Stop in the same visible control position');
  assert.equal(stop.disabled, true,
    'stale recording authority must disable Stop until a fresh TakeStatus replay arrives');

  now = 30_000;
  events.emit('relay-recording-state', stale);
  assert.equal(status.textContent, '● 0:04 · Reconnecting…',
    'last-known recording time must not advance without a fresh TakeStatus');

  events.emit('relay-recording-state', {
    ...stale,
    authorityFresh: true,
    commandChannelFresh: true,
    canStop: true,
  });
  assert.equal(status.textContent, '● 0:29');
  assert.equal(stop.hidden, false);
  assert.equal(stop.disabled, false);
});

test('status socket reconnect keeps System unknown until ProductStatus replay', () => {
  assert.match(liveStatusSource, /function markProductAuthorityStale\(\)/);
  assert.match(liveStatusSource, /systemRelay\.textContent = t\('system\.reconnecting'\)/);
  assert.match(liveStatusSource, /for \(const node of \[systemPhones, systemRobot, systemAudio, systemTiming, systemRecording\]\)[\s\S]*t\('system\.unknown'\)/);
  assert.match(liveStatusSource, /const next = new WebSocket\(wsUrl\(\)\);[\s\S]*markProductAuthorityStale\(\);/);
  assert.match(liveStatusSource, /An open status socket is not enough to revive last-known truth/);
  assert.match(liveStatusSource, /next\.addEventListener\('close'[\s\S]*markProductAuthorityStale\(\)/);
});

test('publisher command authority waits for registration and replayed control snapshots', () => {
  assert.match(publisherSource, /let publisherMixSettingsFresh = false/);
  assert.match(publisherSource, /let publisherSourceStatusFresh = false/);
  assert.match(
    publisherSource,
    /authorityFresh: publisherAuthorityFresh\s*&& publisherMixSettingsFresh\s*&& publisherSourceStatusFresh/,
  );
  assert.match(
    publisherSource,
    /message\.type === 'registered'[\s\S]*publisherAuthorityFresh = true[\s\S]*publishPublisherCommandAuthority\(\)[\s\S]*updateSingerControls\(\)/,
  );
  assert.match(
    publisherSource,
    /message\.type === 'source-status'[\s\S]*publisherSourceStatusFresh = true[\s\S]*publishPublisherCommandAuthority\(\)[\s\S]*updateSingerControls\(\)/,
  );
  assert.match(
    publisherSource,
    /message\.type === 'mix-settings'[\s\S]*publisherMixSettingsFresh = true[\s\S]*publishPublisherCommandAuthority\(\)[\s\S]*updateSingerControls\(\)/,
  );
  assert.match(publisherSource, /function adoptSocket\(ws\)[\s\S]*resetPublisherCommandFreshness\(\)/);
  assert.match(publisherSource, /ws\.addEventListener\('close'[\s\S]*resetPublisherCommandFreshness\(\)/);
  assert.match(publisherSource, /function sendMixSettings\(\)[\s\S]*if \(!publisherCommandAuthority\(\)\.actionable\)[\s\S]*restoreLastKnownControl\('set-mix'\)/);
  assert.match(publisherSource, /function sendVocalFineTune\(\)[\s\S]*if \(!publisherCommandAuthority\(\)\.actionable\)[\s\S]*restoreLastKnownControl\('set-vocal-fine-tune'\)/);
  assert.match(publisherSource, /message\.type === 'command-rejected'[\s\S]*restoreLastKnownControl\(message\.command\)[\s\S]*resetPublisherCommandFreshness\(\)/);
});

test('presence invalidates session authority through disconnect, open-without-replay, and server incarnation change', () => {
  assert.match(presenceSource, /let sessionAuthorityFresh = false/);
  assert.match(presenceSource, /const next = new WebSocket\(wsUrl\(\)\);[\s\S]*sessionAuthorityFresh = false;[\s\S]*publishPresenceState\(\)/);
  assert.match(presenceSource, /message\.type !== 'session-status'[\s\S]*sessionAuthorityFresh = true/);
  assert.match(presenceSource, /next\.addEventListener\('close'[\s\S]*sessionAuthorityFresh = false[\s\S]*publishPresenceState\(\)/);
  assert.match(presenceSource, /previousIncarnation[\s\S]*nextIncarnation[\s\S]*hideTakeover\(\{ cancelPrewarm: true \}\)/);
});
