import type { AudioUplinkHealth } from './audio-uplink-health.js';

export type MicWebTransportLogRecord = {
  generation: number;
  /** The page's last failure reason; it is not cleared when a retry connects. */
  failure: string | null;
  /** True when a capture that reported a failure has since connected. */
  recovered?: true;
  path: 'websocket' | 'webtransport';
  attempts: number;
  connections: number;
  retries: number | undefined;
};

/**
 * Decides which Mic uplink health reports are worth a `[mic-webtransport]` log
 * line: each new failure reason, and the first connection after one.
 *
 * A page keeps its last failure reason after a retry succeeds, so logging
 * only new reasons recorded every fallback with `retries: 0` and never said
 * whether WebTransport came back. That read as "the retry never ran".
 */
export class MicWebTransportReport {
  private reported: { generation: number; failure: string | null; connections: number } | null = null;

  observe(health: AudioUplinkHealth): MicWebTransportLogRecord | null {
    const transport = health.transport;
    const failure = transport.webTransportLastFailure ?? null;
    const connections = transport.webTransportConnections;
    const previous = this.reported?.generation === health.captureGeneration ? this.reported : null;
    this.reported = { generation: health.captureGeneration, failure, connections };

    const record: MicWebTransportLogRecord = {
      generation: health.captureGeneration,
      failure,
      path: transport.path,
      attempts: transport.webTransportAttempts,
      connections,
      retries: transport.webTransportRetries,
    };
    if (failure !== null && failure !== previous?.failure) return record;
    if (
      previous?.failure != null
      && failure !== null
      && connections > previous.connections
    ) return { ...record, recovered: true };
    return null;
  }
}
