from pathlib import Path

path = Path('test/browser/live-interaction.spec.mjs')
source = path.read_text()
anchor = """        if (message.type === 'product-status-request') {
          deliverAfter(this, currentProduct, recorderReplayDelayMs);
          return;
        }

        if (message.type === 'register' && message.role === 'publisher') {
"""
replacement = """        if (message.type === 'product-status-request') {
          deliverAfter(this, currentProduct, recorderReplayDelayMs);
          return;
        }

        if (message.type === 'audio-uplink-health' && this.kind === 'publisher') {
          queueMicrotask(() => deliver(this, {
            type: 'audio-uplink-health-ack',
            version: 1,
            captureGeneration: message.captureGeneration,
          }));
          return;
        }

        if (message.type === 'register' && message.role === 'publisher') {
"""
if source.count(anchor) != 1:
    raise SystemExit(f'expected one fixture anchor, found {source.count(anchor)}')
path.write_text(source.replace(anchor, replacement, 1))
