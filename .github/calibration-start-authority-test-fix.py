from pathlib import Path

path = Path('test/adjust-ui-contract.test.ts')
text = path.read_text()
marker = "\ntest('Calibration enablement follows ProductStatus action authority', () => {"
start = text.find(marker)
if start < 0:
    raise SystemExit('calibration UI authority test marker not found')
if text.find(marker, start + 1) >= 0:
    raise SystemExit('calibration UI authority test marker duplicated')

replacement = """
test('Calibration enablement follows ProductStatus action authority', () => {
  assert.equal(app.includes('let roomCanStartCalibration = null;'), true);
  assert.equal(
    app.includes('roomCanStartCalibration = event.detail?.actions?.canStartCalibration === true;'),
    true,
  );

  const updateStart = app.indexOf('function updateCalibrateButton() {');
  const updateEnd = app.indexOf('function wsUrl()', updateStart);
  assert.ok(updateStart >= 0 && updateEnd > updateStart);
  const updateBlock = app.slice(updateStart, updateEnd);
  const disabledStart = updateBlock.indexOf('calibrateButton.disabled = ');
  const disabledEnd = updateBlock.indexOf(';', disabledStart);
  assert.ok(disabledStart >= 0 && disabledEnd > disabledStart);
  const disabled = updateBlock.slice(disabledStart, disabledEnd);
  assert.equal(disabled.includes('publisherActive'), true);
  assert.equal(disabled.includes('roomSongAvailable'), true);
  assert.equal(disabled.includes('roomCanStartCalibration'), true);
  assert.equal(disabled.includes('liveMixActive'), false);
  assert.equal(disabled.includes('collecting'), false);
  assert.equal(disabled.includes('probeActive'), false);
});
"""
path.write_text(text[:start] + '\n' + replacement)
