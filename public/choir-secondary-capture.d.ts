/** TypeScript contract for the browser-native, secondary-only capture module. */
export function encodeChoirMicV2(
  pcm: ArrayBuffer,
  generation: number,
  sequence: number,
  firstSampleIndex: number,
): ArrayBuffer;

/** This is NOT the primary/production Mic and does not manage Song authority. */
export class ChoirSecondaryCapture {
  constructor(onFailure?: (reason: string) => void);
  epoch: number;
  graph: any;
  context: any;
  socket: any;
  rate: number | null;
  generation: number | null;
  cursor: number;
  sequence: number;
  clockWallOriginMs: number | null;
  clockSampleOrigin: number;
  opus: any;
  readonly packetVersion: 2 | 3;
  prepare(): Promise<number | null>;
  attach(socket: any, sampleRate: number): boolean;
  onCapture(event: { data: unknown }, graph: any, epoch: number): void;
  sendPacket(packet: ArrayBuffer): void;
  stop(): void;
}
