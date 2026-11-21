// A control socket's handshake must settle. A browser can sit in CONNECTING
// with no error or close (an endpoint that accepts TCP but never answers the
// upgrade), and connect() then refuses to start another attempt. Close a
// handshake that has not opened by the deadline, so the caller's ordinary
// reconnect takes over.
export const CONTROL_SOCKET_OPEN_TIMEOUT_MS = 15_000;

export function waitForSocketOpen(socket, timeoutMs = CONTROL_SOCKET_OPEN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Settle first: close() may dispatch its own close event synchronously.
      reject(new Error('WebSocket handshake timed out.'));
      try { socket.close(); } catch {}
    }, timeoutMs);
    const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };
    socket.addEventListener('open', settle(resolve), { once: true });
    socket.addEventListener('error', settle(reject), { once: true });
    socket.addEventListener('close', settle(reject), { once: true });
  });
}
