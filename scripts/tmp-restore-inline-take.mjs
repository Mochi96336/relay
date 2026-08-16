import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const path = 'public/index.html';
const before = `        <p id="recording-status" class="microcopy"></p>
        <audio id="recording-player" controls hidden></audio>
        <a id="download-recording" class="take-link" hidden>Last take</a>`;
const after = `        <p id="recording-status" class="microcopy"></p>
        <div id="last-take" class="last-take" hidden>
          <button id="last-take-toggle" class="take-link text-action" type="button" aria-expanded="false">Last take</button>
          <div id="last-take-review" class="take-review" hidden>
            <audio id="recording-player" controls preload="metadata"></audio>
            <a id="download-recording" class="take-download text-action" download>Download WAV</a>
          </div>
        </div>`;

const source = readFileSync(path, 'utf8');
const count = source.split(before).length - 1;
assert.equal(count, 1, `expected exactly one old Take artifact block, got ${count}`);
const next = source.replace(before, after);

for (const marker of [
  'class="system-item" data-system-scope="relay"',
  'id="diagnostics-panel"',
  'data-diagnostics-panel="overview"',
  'class="legacy-tools"',
]) {
  assert.ok(next.includes(marker), `restored Live markup missing ${marker}`);
}
assert.ok(next.includes('id="last-take-toggle"'), 'inline Last take toggle missing');
assert.ok(next.includes('id="last-take-review"'), 'inline Last take review missing');
writeFileSync(path, next);
