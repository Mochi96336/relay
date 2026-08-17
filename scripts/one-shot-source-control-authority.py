from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: {label}: expected one match, found {count}')
    target.write_text(text.replace(old, new, 1))


# Desktop Source is an infrastructure projection, not the singer authority.
replace_once(
    'public/source.html',
    '<span>只改送進 Relay 的歌曲 / 人聲比例，不影響手機端歌手聽到的 YouTube 音量。</span>',
    '<span>由拿著 Mic 的手機控制；這頁只顯示並套用 Relay 的共享設定。</span>',
    'describe source mix as read-only projection',
)
replace_once(
    'public/source.html',
    '<input id="source-volume" type="range" min="0" max="100" step="1" value="40" />',
    '<input id="source-volume" type="range" min="0" max="100" step="1" value="40" disabled />',
    'disable source song-level duplicate',
)
replace_once(
    'public/source.html',
    '<input id="source-mic-gain" type="range" min="0" max="36" step="1" value="24" />',
    '<input id="source-mic-gain" type="range" min="0" max="36" step="1" value="24" disabled />',
    'disable source mic-gain duplicate',
)
replace_once(
    'public/source.html',
    '<button id="start-timing-calibration" disabled>Calibrate timing</button>',
    '<button id="start-timing-calibration" hidden disabled>Calibrate timing</button>',
    'hide unauthorized source calibration button',
)
replace_once(
    'public/source.html',
    '<input id="vocal-fine-tune" type="range" min="-100" max="100" step="5" value="0" />',
    '<input id="vocal-fine-tune" type="range" min="-100" max="100" step="5" value="0" disabled />',
    'make source fine-tune a readout',
)
replace_once(
    'public/source.html',
    '<p class="hint">負值讓人聲更早，正值讓人聲更晚；自動校準完成後通常只需要很小的微調。</p>',
    '<p class="hint">這裡只顯示目前設定；Vocal fine tune 請在拿著 Mic 的手機 Adjust → Timing 調整。</p>',
    'point fine tune to singer authority',
)

replace_once('public/source.js', 'const SLIDER_HOLD_MS = 2000;\n', '', 'remove obsolete source slider hold')
replace_once('public/source.js', 'let vocalFineTuneTouchedAt = 0;\n', '', 'remove obsolete fine-tune hold')
replace_once('public/source.js', 'const sliderTouchedAt = new Map();\n', '', 'remove obsolete source slider map')
replace_once(
    'public/source.js',
    """// The server echoes every source-status back to every client, which used to\n// snap this slider back to a stale value while the user was still dragging it.\nfunction fineTuneIsBusy() {\n  return document.activeElement === vocalFineTune\n    || performance.now() - vocalFineTuneTouchedAt < SLIDER_HOLD_MS;\n}\n\nfunction sliderIsBusy(slider) {\n  return document.activeElement === slider\n    || performance.now() - (sliderTouchedAt.get(slider) ?? -Infinity) < SLIDER_HOLD_MS;\n}\n\n""",
    '',
    'remove obsolete source-side authority hold logic',
)
replace_once(
    'public/source.js',
    'function applyBalance(sendToServer = true) {\n',
    'function applyBalance() {\n',
    'make source balance projection-only',
)
replace_once(
    'public/source.js',
    """  if (sendToServer && armed && !robotSuperseded) {\n    send({ type: 'set-mix', micGainDb, songLevel });\n  }\n\n""",
    '',
    'remove unauthorized source set-mix',
)
replace_once(
    'public/source.js',
    """function applyFineTune(sendToServer = true) {\n  const valueMs = Math.max(-100, Math.min(100, Number(vocalFineTune.value) || 0));\n  vocalFineTuneValue.value = signed(valueMs, ' ms');\n  if (sendToServer) send({ type: 'set-vocal-fine-tune', valueMs });\n}\n""",
    """function applyFineTune() {\n  const valueMs = Math.max(-100, Math.min(100, Number(vocalFineTune.value) || 0));\n  vocalFineTuneValue.value = signed(valueMs, ' ms');\n}\n""",
    'make source fine tune projection-only',
)
replace_once(
    'public/source.js',
    """  if (Number.isFinite(Number(message.vocalFineTuneMs)) && !fineTuneIsBusy()) {\n    vocalFineTune.value = String(Number(message.vocalFineTuneMs));\n    applyFineTune(false);\n  }\n""",
    """  if (Number.isFinite(Number(message.vocalFineTuneMs))) {\n    vocalFineTune.value = String(Number(message.vocalFineTuneMs));\n    applyFineTune();\n  }\n""",
    'always project canonical fine tune',
)
replace_once(
    'public/source.js',
    """    if (message.type === 'mix-settings') {\n      if (!sliderIsBusy(sourceMicGain) && Number.isFinite(Number(message.micGainDb))) {\n        sourceMicGain.value = String(message.micGainDb);\n      }\n      if (!sliderIsBusy(sourceVolume) && Number.isFinite(Number(message.songLevel))) {\n        sourceVolume.value = String(message.songLevel);\n      }\n      applyBalance(false);\n      return;\n    }\n""",
    """    if (message.type === 'mix-settings') {\n      if (Number.isFinite(Number(message.micGainDb))) {\n        sourceMicGain.value = String(message.micGainDb);\n      }\n      if (Number.isFinite(Number(message.songLevel))) {\n        sourceVolume.value = String(message.songLevel);\n      }\n      applyBalance();\n      return;\n    }\n""",
    'project canonical mix without local edit hold',
)
replace_once(
    'public/source.js',
    """for (const slider of [sourceVolume, sourceMicGain]) {\n  slider.addEventListener('input', () => {\n    sliderTouchedAt.set(slider, performance.now());\n    applyBalance();\n  });\n}\nvocalFineTune.addEventListener('input', () => {\n  vocalFineTuneTouchedAt = performance.now();\n  applyFineTune(true);\n});\nvocalFineTune.addEventListener('change', () => {\n  vocalFineTuneTouchedAt = performance.now();\n});\ntimingButton.addEventListener('click', () => {\n  if (!send({ type: 'start-timing-calibration' })) {\n    timingStatus.textContent = 'Server 尚未連線。';\n  }\n});\n\n""",
    '',
    'remove zombie source authority controls',
)
replace_once('public/source.js', 'applyFineTune(false);\n', 'applyFineTune();\n', 'simplify initial fine-tune projection')

# Restore Vocal fine tune at the actual Mic-owner surface on the phone.
replace_once(
    'public/index.html',
    """              <div class=\"timing-row\">\n                <strong id=\"calibrate-status\" data-i18n=\"adjust.waitingPlayback\">Waiting for playback</strong>\n                <button id=\"calibrate-timing\" class=\"text-action\" type=\"button\" data-i18n=\"adjust.recalibrate\">Recalibrate</button>\n              </div>\n""",
    """              <label class=\"adjust-control\" for=\"vocal-fine-tune\">\n                <div class=\"adjust-row-heading\">\n                  <strong data-i18n=\"adjust.vocalFineTune\">Vocal fine tune</strong>\n                  <output id=\"vocal-fine-tune-value\" for=\"vocal-fine-tune\">0 ms</output>\n                </div>\n                <input id=\"vocal-fine-tune\" class=\"adjust-range\" type=\"range\" min=\"-100\" max=\"100\" step=\"5\" value=\"0\" disabled aria-label=\"Vocal fine tune\" data-i18n-aria-label=\"adjust.vocalFineTuneAria\" />\n                <p class=\"adjust-helper\" data-i18n=\"adjust.vocalFineTuneHelp\">Negative moves voice earlier; positive moves it later.</p>\n              </label>\n              <div class=\"timing-row\">\n                <strong id=\"calibrate-status\" data-i18n=\"adjust.waitingPlayback\">Waiting for playback</strong>\n                <button id=\"calibrate-timing\" class=\"text-action\" type=\"button\" data-i18n=\"adjust.recalibrate\">Recalibrate</button>\n              </div>\n""",
    'move fine tune to singer Adjust surface',
)

replace_once(
    'public/app.js',
    """const songLevel = document.querySelector('#song-level');\nconst songLevelValue = document.querySelector('#song-level-value');\nconst calibrateButton = document.querySelector('#calibrate-timing');\n""",
    """const songLevel = document.querySelector('#song-level');\nconst songLevelValue = document.querySelector('#song-level-value');\nconst vocalFineTune = document.querySelector('#vocal-fine-tune');\nconst vocalFineTuneValue = document.querySelector('#vocal-fine-tune-value');\nconst calibrateButton = document.querySelector('#calibrate-timing');\n""",
    'bind singer fine-tune control',
)
replace_once(
    'public/app.js',
    """function updateSingerControls() {\n  micGain.disabled = !publisherActive;\n  songLevel.disabled = !publisherActive;\n  renderGainAdvice();\n""",
    """function updateSingerControls() {\n  micGain.disabled = !publisherActive;\n  songLevel.disabled = !publisherActive;\n  vocalFineTune.disabled = !publisherActive;\n  renderGainAdvice();\n""",
    'gate fine tune by Mic ownership',
)
replace_once(
    'public/app.js',
    """function updateMixLabels() {\n  micGainValue.value = signed(micGain.value, ' dB');\n  songLevelValue.value = `${Math.round(Number(songLevel.value) || 0)}%`;\n  // The verdict compares the slider against the meter, so it moves with both.\n  renderGainAdvice();\n}\n\nfunction sendMixSettings() {\n""",
    """function updateMixLabels() {\n  micGainValue.value = signed(micGain.value, ' dB');\n  songLevelValue.value = `${Math.round(Number(songLevel.value) || 0)}%`;\n  // The verdict compares the slider against the meter, so it moves with both.\n  renderGainAdvice();\n}\n\nfunction updateVocalFineTuneLabel() {\n  vocalFineTuneValue.value = signed(vocalFineTune.value, ' ms');\n}\n\nfunction sendVocalFineTune() {\n  updateVocalFineTuneLabel();\n  if (socket?.readyState !== WebSocket.OPEN || !publisherActive) return;\n  socket.send(JSON.stringify({\n    type: 'set-vocal-fine-tune',\n    valueMs: Number(vocalFineTune.value),\n  }));\n}\n\nfunction sendMixSettings() {\n""",
    'add singer fine-tune command path',
)
replace_once(
    'public/app.js',
    """  if (message.type === 'source-status') {\n    liveMixActive = Boolean(message.active);\n    updateCalibrateButton();\n    return;\n  }\n""",
    """  if (message.type === 'source-status') {\n    liveMixActive = Boolean(message.active);\n    const nextFineTune = Number(message.vocalFineTuneMs);\n    if (Number.isFinite(nextFineTune) && !sliderIsBusy(vocalFineTune)) {\n      vocalFineTune.value = String(nextFineTune);\n      updateVocalFineTuneLabel();\n    }\n    updateCalibrateButton();\n    return;\n  }\n""",
    'project canonical fine tune into singer UI',
)
replace_once(
    'public/app.js',
    """for (const slider of [micGain, songLevel]) {\n  slider.addEventListener('input', () => {\n    markSliderTouched(slider);\n    sendMixSettings();\n  });\n  slider.addEventListener('change', () => markSliderTouched(slider));\n}\n\nuseMicGainSuggestion.addEventListener('click', () => {\n""",
    """for (const slider of [micGain, songLevel]) {\n  slider.addEventListener('input', () => {\n    markSliderTouched(slider);\n    sendMixSettings();\n  });\n  slider.addEventListener('change', () => markSliderTouched(slider));\n}\n\nvocalFineTune.addEventListener('input', () => {\n  markSliderTouched(vocalFineTune);\n  sendVocalFineTune();\n});\nvocalFineTune.addEventListener('change', () => markSliderTouched(vocalFineTune));\n\nuseMicGainSuggestion.addEventListener('click', () => {\n""",
    'wire singer fine-tune slider',
)

replace_once(
    'public/i18n.js',
    """      'adjust.timing': 'Timing',\n      'adjust.roomAlignment': 'Room alignment',\n      'adjust.waitingPlayback': 'Waiting for playback',\n""",
    """      'adjust.timing': 'Timing',\n      'adjust.roomAlignment': 'Room alignment',\n      'adjust.vocalFineTune': 'Vocal fine tune',\n      'adjust.vocalFineTuneAria': 'Vocal fine tune',\n      'adjust.vocalFineTuneHelp': 'Negative moves voice earlier; positive moves it later.',\n      'adjust.waitingPlayback': 'Waiting for playback',\n""",
    'add English fine-tune copy',
)
replace_once(
    'public/i18n.js',
    """      'adjust.timing': 'Timing',\n      'adjust.roomAlignment': '房間對齊',\n      'adjust.waitingPlayback': '等待播放',\n""",
    """      'adjust.timing': 'Timing',\n      'adjust.roomAlignment': '房間對齊',\n      'adjust.vocalFineTune': '人聲微調',\n      'adjust.vocalFineTuneAria': '人聲時間微調',\n      'adjust.vocalFineTuneHelp': '負值讓人聲更早，正值讓人聲更晚。',\n      'adjust.waitingPlayback': '等待播放',\n""",
    'add Traditional Chinese fine-tune copy',
)

Path('test/source-control-authority.test.ts').write_text("""import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sourceJs = readFileSync(new URL('../public/source.js', import.meta.url), 'utf8');
const sourceHtml = readFileSync(new URL('../public/source.html', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('Desktop Source no longer exposes authority-bearing singer commands', () => {
  assert.doesNotMatch(sourceJs, /type:\s*'set-mix'/);
  assert.doesNotMatch(sourceJs, /type:\s*'set-vocal-fine-tune'/);
  assert.doesNotMatch(sourceJs, /type:\s*'start-timing-calibration'/);
  assert.match(sourceHtml, /id=\"source-volume\"[^>]*disabled/);
  assert.match(sourceHtml, /id=\"source-mic-gain\"[^>]*disabled/);
  assert.match(sourceHtml, /id=\"vocal-fine-tune\"[^>]*disabled/);
  assert.match(sourceHtml, /id=\"start-timing-calibration\"[^>]*hidden[^>]*disabled/);
});

test('Vocal fine tune lives on the authenticated Mic-owner phone surface', () => {
  assert.match(indexHtml, /id=\"vocal-fine-tune\"[^>]*disabled/);
  assert.match(appJs, /vocalFineTune\.disabled = !publisherActive/);
  assert.match(
    appJs,
    /function sendVocalFineTune\(\)[\s\S]{0,500}!publisherActive[\s\S]{0,300}type: 'set-vocal-fine-tune'/,
  );
  assert.match(
    appJs,
    /message\.type === 'source-status'[\s\S]{0,500}message\.vocalFineTuneMs[\s\S]{0,300}vocalFineTune\.value/,
  );
});

test('Source still applies the canonical Song level locally without writing it back', () => {
  assert.match(
    sourceJs,
    /message\.type === 'mix-settings'[\s\S]{0,500}sourceVolume\.value[\s\S]{0,200}applyBalance\(\)/,
  );
  assert.match(sourceJs, /player\.setVolume\(songLevel\)/);
});
""")
