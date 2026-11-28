import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ui = await readFile(new URL('../public/local-file-ui.js', import.meta.url), 'utf8');

test('a file confirmed after a second singer joined is refused and explained', () => {
  const change = ui.slice(ui.indexOf("fileInput.addEventListener('change'"), ui.indexOf("closeButton.addEventListener('click'"));
  assert.match(change, /if \(roomHasDuet\) \{\s*showDuetNotice\('localFile\.blockedDuet'\);\s*return;\s*\}[\s\S]*localFileMix\.open\(file\);/);
});

test('a join admitted just before the file took effect keeps the singer and closes the file', () => {
  assert.match(ui, /roomHasDuet = Boolean\(room\?\.duet\);\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if \(roomHasDuet && localFileMix\.active\) \{\s*localFileMix\.close\(\);\s*showDuetNotice\('localFile\.closedForDuet'\);/);
});

test('with no file open, the explanation is still visible for a while', () => {
  assert.match(ui, /const noticeOnly = surface === 'none' && duetNoticeKey !== null;\s*panel\.hidden = surface === 'none' && !noticeOnly;/);
  assert.match(ui, /duetNoticeTimer = setTimeout\(\(\) => \{ duetNoticeKey = null; render\(\); \}, 8_000\);/);
});
