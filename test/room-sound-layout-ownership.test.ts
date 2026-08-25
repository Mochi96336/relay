import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ia = readFileSync(new URL('../public/live-ia.css', import.meta.url), 'utf8');
const layout = readFileSync(new URL('../public/live-p0-layout.css', import.meta.url), 'utf8');
const paint = readFileSync(new URL('../public/room-sound-ui.css', import.meta.url), 'utf8');
const actions = readFileSync(new URL('../public/action-language.css', import.meta.url), 'utf8');

test('P0 is the only Room sound rail geometry owner', () => {
  assert.match(layout, /\.local-sound-control \{[\s\S]*?grid-template-columns:\s*44px minmax\(0, 1fr\) auto/);
  assert.match(layout, /#listen-toggle \{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px/);
  assert.match(layout, /#listen-gain-value \{[\s\S]*?width:\s*5ch;/);

  assert.doesNotMatch(ia, /\.local-sound-control/,
    'Live IA must not keep a second Room sound layout contract');
  assert.doesNotMatch(ia, /#listen-toggle\s*\{/,
    'Live IA must not size or position the Room sound toggle');
  assert.doesNotMatch(ia, /#listen-adjust-state\s*\{|#listen-note\s*\{/,
    'Live IA must not give Room sound semantic copy measured layout');

  assert.doesNotMatch(paint, /#listen-gain-value|#listen-adjust-state/,
    'Room sound state CSS paints state only');
  assert.match(actions, /#listen-toggle \{[\s\S]*?min-height:\s*44px;/,
    'the shared action layer may retain the cross-Live touch-target policy');
});

test('duplicate Room sound action-note suppression remains presentation-only', () => {
  assert.match(ia, /body\[data-listen="muted"\] #listen-note,[\s\S]*?display:\s*none;/);
  assert.doesNotMatch(ia, /body\[data-listen="muted"\][\s\S]*?(?:width|height|margin|padding|grid-template|position):/,
    'mute-state suppression must not regain rail geometry ownership');
});
