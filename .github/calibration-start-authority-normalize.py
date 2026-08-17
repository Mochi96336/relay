from pathlib import Path

path = Path('src/server.ts')
text = path.read_text()
old = """      if (takeBlocksCalibration()) {
        sendJson(socket, { type: 'calibration-command-rejected', reason: 'take-active' });
        return;
      }
"""
new = """      if (takeBlocksCalibration()) {
        sendJson(socket, {
          type: 'calibration-command-rejected',
          reason: 'take-active',
        });
        return;
      }
"""
count = text.count(old)
if count != 1:
    raise SystemExit(f'normalize take-active rejection: expected exactly one match, found {count}')
path.write_text(text.replace(old, new, 1))
