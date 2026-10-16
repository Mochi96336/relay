export declare function openAudioSocket(options: {
  directUrl: string;
  tunnelUrl: string;
  onPending: (socket: WebSocket) => void;
  onDirectFailure: () => void;
  stillWanted: () => boolean;
  WebSocketClass?: typeof WebSocket;
  timeoutMs?: number;
}): Promise<WebSocket>;
