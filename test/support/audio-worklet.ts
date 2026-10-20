import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

/**
 * Runs an AudioWorklet module (a path from the repository root) in its own VM
 * realm against a fake AudioWorkletProcessor whose port keeps every message
 * posted, and returns a new instance of the processor it registers as `name`.
 * `context` is that realm, for tests that need objects created inside it.
 */
export async function loadWorkletProcessor<Processor>(
  file: string,
  name: string,
  { sampleRate = 48_000, currentTime = 12.5 } = {},
) {
  const source = await readFile(path.resolve(file), 'utf8');
  const registry: { name?: string; Processor?: new () => Processor } = {};

  class FakeAudioWorkletProcessor {
    port = {
      messages: [] as unknown[],
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (message: unknown) => {
        this.port.messages.push(message);
      },
    };
  }

  const context = vm.createContext({
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    sampleRate,
    currentTime,
    registerProcessor: (registeredName: string, Registered: new () => Processor) => {
      registry.name = registeredName;
      registry.Processor = Registered;
    },
  });
  vm.runInContext(source, context);

  assert.equal(registry.name, name, `${file} registers ${name}`);
  return { processor: new registry.Processor!(), context };
}
