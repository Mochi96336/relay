/**
 * The Relay socket URL for this page. The socket carries the page's own `key`,
 * so it is authorized the way the page was; nothing else in the page's query
 * belongs on it.
 *
 * A status socket also offers to take its JSON compressed, which Relay accepts
 * when it enables status compression. A socket that carries audio must pass
 * `{ compress: false }`: a browser compresses everything it sends on a
 * compressed socket.
 */
export function wsUrl({ compress = true } = {}) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams();
  const key = new URLSearchParams(location.search).get('key');
  if (key) params.set('key', key);
  if (compress) params.set('compress', '1');
  const query = params.toString();
  return `${protocol}//${location.host}/ws${query ? `?${query}` : ''}`;
}
