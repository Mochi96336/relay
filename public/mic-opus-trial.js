export async function createMicOpusTrial({ bitrate = 32000, onPacket, onDrop, onError }) {
  const worker = new Worker(new URL('./mic-opus-worker.js', import.meta.url), { type: 'module' });
  const pending = new Map();
  let generation = null, nextId = 0, closed = false, delaySamples = 0;
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Opus startup timed out')); }, 8000);
    worker.onerror = () => { clearTimeout(timeout); reject(new Error('Opus worker failed')); onError?.(); };
    worker.onmessage = ({ data }) => {
      if (closed) return;
      if (data.type === 'ready') {
        clearTimeout(timeout); delaySamples = data.delaySamples; resolve(); return;
      }
      if (data.type === 'error') {
        clearTimeout(timeout); reject(new Error(data.message)); onError?.(new Error(data.message)); return;
      }
      if (data.type !== 'encoded') return;
      const request = pending.get(data.id);
      pending.delete(data.id);
      if (!request || request.generation !== generation) return;
      if (performance.now() - request.at > 100) { onDrop(960, 'capture-backlog'); return; }
      const packet = new ArrayBuffer(28 + data.encoded.byteLength);
      const view = new DataView(packet);
      view.setUint16(0, 0x4c52, true); view.setUint8(2, 3); view.setUint8(3, 1);
      view.setUint32(4, generation, true); view.setUint32(8, request.sequence, true);
      view.setUint32(12, 960, true); view.setFloat64(16, request.firstSampleIndex, true);
      view.setUint16(24, delaySamples, true);
      new Uint8Array(packet, 28).set(new Uint8Array(data.encoded));
      onPacket(packet);
    };
  });
  worker.postMessage({ type: 'init', bitrate });
  await ready;
  return {
    reset(value) { generation = value; pending.clear(); worker.postMessage({ type: 'reset' }); },
    encode(pcm, sequence, firstSampleIndex) {
      if (closed || pending.size >= 2) { onDrop(pcm.byteLength / 2, 'capture-backlog'); return false; }
      const id = nextId++;
      pending.set(id, { generation, sequence, firstSampleIndex, at: performance.now() });
      const copy = pcm.slice(0);
      worker.postMessage({ type: 'encode', id, pcm: copy }, [copy]);
      return true;
    },
    close() { closed = true; pending.clear(); worker.terminate(); },
  };
}
