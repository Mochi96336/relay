// Open a realtime audio socket through the direct endpoint when available.
// An endpoint that fails before opening falls back once to the page's tunnel.
export async function openAudioSocket({
  directUrl, tunnelUrl, onPending, onDirectFailure, stillWanted,
  WebSocketClass = WebSocket, timeoutMs = 2500,
}) {
  const urls = directUrl === tunnelUrl ? [tunnelUrl] : [directUrl, tunnelUrl];
  for (let index = 0; index < urls.length; index++) {
    if (!stillWanted()) throw new Error('Audio connection cancelled.');
    let socket = null;
    try {
      socket = new WebSocketClass(urls[index]);
      socket.binaryType = 'arraybuffer';
      onPending(socket);
      await new Promise((resolve, reject) => {
        let timer = null;
        const finish = (error) => {
          clearTimeout(timer);
          socket.removeEventListener('open', opened);
          socket.removeEventListener('error', failed);
          socket.removeEventListener('close', failed);
          if (error) reject(error);
          else resolve();
        };
        const opened = () => finish(null);
        const failed = () => finish(new Error('Audio WebSocket failed before opening.'));
        socket.addEventListener('open', opened);
        socket.addEventListener('error', failed);
        socket.addEventListener('close', failed);
        // Only bound the optional direct probe. The tunnel may need longer
        // on a slow network; browser errors or revoked intent still close it.
        if (urls[index] !== tunnelUrl) timer = setTimeout(failed, timeoutMs);
      });
      if (!stillWanted()) throw new Error('Audio connection cancelled.');
      return socket;
    } catch (error) {
      try { socket?.close(); } catch {}
      if (index === urls.length - 1 || !stillWanted()) throw error;
      onDirectFailure();
    }
  }
}
