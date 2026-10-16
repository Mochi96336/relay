/**
 * The Relay socket URL for this page. The socket carries the page's own `key`,
 * so it is authorized the way the page was; nothing else in the page's query
 * belongs on it.
 *
 * A status socket also offers to take its JSON compressed, which Relay accepts
 * when it enables status compression. A socket that carries audio must pass
 * `{ compress: false }`: a browser compresses everything it sends on a
 * compressed socket.
 *
 * `direct` asks for the socket Relay offers outside the HTTPS tunnel
 * (direct-socket.ts) when the page was served one; otherwise it is the page's
 * own host like any other socket.
 */
export function wsUrl({ compress = true, direct = false } = {}) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams();
  const key = new URLSearchParams(location.search).get('key');
  if (key) params.set('key', key);
  if (compress) params.set('compress', '1');
  const query = params.toString();
  const base = (direct && directSocketBase()) || `${protocol}//${location.host}/ws`;
  return `${base}${query ? `?${query}` : ''}`;
}

function directSocketBase() {
  if (typeof document === 'undefined') return null;
  const content = document.querySelector('meta[name="relay-direct-socket"]')?.getAttribute('content');
  if (!content) return null;
  try {
    const url = new URL(content);
    return url.protocol === 'wss:' ? `${url.origin}${url.pathname}` : null;
  } catch {
    return null;
  }
}
