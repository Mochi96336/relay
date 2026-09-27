/**
 * The Relay socket URL for this page. The socket carries the page's own `key`,
 * so it is authorized the way the page was; nothing else in the page's query
 * belongs on it.
 */
export function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams();
  const key = new URLSearchParams(location.search).get('key');
  if (key) params.set('key', key);
  const query = params.toString();
  return `${protocol}//${location.host}/ws${query ? `?${query}` : ''}`;
}
