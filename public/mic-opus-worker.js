// Uses the installed @evan/opus WASM asset. No browser codec support is assumed.
export function createOpusEncoder(bytes, bitrate = 32000) {
  let wasm;
  const memoryChanged = () => {};
  wasm = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
    wasi_snapshot_preview1: { fd_seek() {}, fd_write() {}, fd_close() {}, proc_exit() {} },
    env: { emscripten_notify_memory_growth: memoryChanged },
  }).exports;
  const check = value => { if (value < 0) throw new Error(`Opus error ${value}`); return value; };
  const encoder = wasm.malloc(wasm.opus_encoder_get_size(1));
  const input = wasm.malloc(1920);
  const output = wasm.malloc(1275);
  check(wasm.opus_encoder_init(encoder, 48000, 1, 2051)); // restricted low delay
  check(wasm.opus_encoder_ctl_set(encoder, 4002, bitrate));
  check(wasm.opus_encoder_ctl_set(encoder, 4006, 0)); // bounded CBR
  check(wasm.opus_encoder_ctl_set(encoder, 4010, 5));
  const delaySamples = wasm.opus_encoder_ctl_get(encoder, 4027);
  return {
    delaySamples,
    reset() { check(wasm.opus_encoder_ctl_set(encoder, 4028, 0)); },
    encode(pcm) {
      if (pcm.byteLength !== 1920) throw new Error('Opus requires a 20 ms / 48 kHz mono frame');
      new Uint8Array(wasm.memory.buffer, input, 1920).set(new Uint8Array(pcm));
      const length = check(wasm.opus_encode(encoder, input, 960, output, 1275));
      return new Uint8Array(wasm.memory.buffer, output, length).slice();
    },
  };
}

if (typeof self !== 'undefined') {
  let encoder;
  self.onmessage = async ({ data }) => {
    try {
      if (data.type === 'init') {
        const response = await fetch('/mic-opus.wasm');
        if (!response.ok) throw new Error('Opus asset unavailable');
        encoder = createOpusEncoder(await response.arrayBuffer(), data.bitrate);
        self.postMessage({ type: 'ready', delaySamples: encoder.delaySamples });
      } else if (data.type === 'reset') {
        encoder.reset();
      } else if (data.type === 'encode') {
        const encoded = encoder.encode(data.pcm);
        self.postMessage({ type: 'encoded', id: data.id, encoded: encoded.buffer }, [encoded.buffer]);
      }
    } catch (error) {
      self.postMessage({ type: 'error', message: String(error?.message ?? error) });
    }
  };
}
