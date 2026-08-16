import { readFileSync, writeFileSync } from 'node:fs';

function replaceAllExact(text, from, to, expected, label) {
  const count = text.split(from).length - 1;
  if (count !== expected) throw new Error(`${label}: expected ${expected} matches, found ${count}`);
  return text.split(from).join(to);
}

let app = readFileSync('public/app.js', 'utf8');

app = replaceAllExact(app, 'let activeRole = null;', 'let publisherActive = false;', 1, 'publisher state declaration');
app = replaceAllExact(
  app,
  `function setActiveRole(role) {\n  activeRole = role;\n  window.relayActiveRole = role;\n}`,
  `function setPublisherActive(active) {\n  publisherActive = Boolean(active);\n  // listen.js only needs to know whether this phone is the singer phone.\n  // Keep the old global shape temporarily while the Mic controller remains in app.js.\n  window.relayActiveRole = publisherActive ? 'publisher' : null;\n}`,
  1,
  'role setter',
);
app = replaceAllExact(app, "activeRole === 'publisher'", 'publisherActive', 4, 'publisher checks');
app = replaceAllExact(app, "activeRole !== 'publisher'", '!publisherActive', 5, 'publisher inverse checks');
app = replaceAllExact(app, '!activeRole', '!publisherActive', 5, 'generic active checks');
app = replaceAllExact(app, "setActiveRole('publisher')", 'setPublisherActive(true)', 1, 'publisher activation');
app = replaceAllExact(app, 'setActiveRole(null)', 'setPublisherActive(false)', 1, 'publisher deactivation');

if (/\bactiveRole\b/.test(app)) throw new Error('generic activeRole state still exists');
if (app.includes('setActiveRole')) throw new Error('generic role setter still exists');
if (!app.includes('let publisherActive = false;')) throw new Error('publisherActive state missing');
if (!app.includes('setPublisherActive(true)')) throw new Error('publisher activation missing');
if (!app.includes("window.relayActiveRole = publisherActive ? 'publisher' : null")) {
  throw new Error('Listen compatibility signal missing');
}
writeFileSync('public/app.js', app);

let test = readFileSync('test/legacy-monitor-retirement.test.ts', 'utf8');
test = replaceAllExact(
  test,
  `  assert.match(app, /setActiveRole\\('publisher'\\)/);\n`,
  `  assert.match(app, /let publisherActive = false/);\n  assert.match(app, /setPublisherActive\\(true\\)/);\n`,
  1,
  'publisher state test',
);
test = replaceAllExact(
  test,
  `  assert.doesNotMatch(app, /setActiveRole\\('monitor'\\)/);\n`,
  `  assert.doesNotMatch(app, /\\bactiveRole\\b|setActiveRole|setPublisherActive\\('monitor'\\)/);\n`,
  1,
  'generic role retirement test',
);
writeFileSync('test/legacy-monitor-retirement.test.ts', test);

console.log('generic browser activeRole state narrowed to publisherActive');
