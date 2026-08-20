let player = null;

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return Array.from(normalized).slice(0, maxLength).join('');
}

function attachPlayer(nextPlayer) {
  if (nextPlayer) player = nextPlayer;
}

function wrapPlayerConstructor() {
  const YT = window.YT;
  const OriginalPlayer = YT?.Player;
  if (typeof OriginalPlayer !== 'function' || OriginalPlayer.__relaySongMetadataWrapped) return;

  function RelayMetadataPlayer(target, options = {}) {
    const created = new OriginalPlayer(target, options);
    attachPlayer(created);
    return created;
  }

  Object.setPrototypeOf(RelayMetadataPlayer, OriginalPlayer);
  RelayMetadataPlayer.prototype = OriginalPlayer.prototype;
  RelayMetadataPlayer.__relaySongMetadataWrapped = true;
  YT.Player = RelayMetadataPlayer;
}

if (window.YT?.Player) {
  wrapPlayerConstructor();
} else {
  const previousReady = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = () => {
    previousReady?.();
    wrapPlayerConstructor();
  };
}

// youtube.js owns timing evidence and dispatches this event. Enrich the same
// packet synchronously before youtube-sync.js publishes it to Relay. Metadata is
// descriptive only: it never participates in playback authority or timing.
window.addEventListener('relay:youtube-telemetry', (event) => {
  const detail = event.detail;
  if (!detail || typeof detail !== 'object' || !player) return;

  let data;
  try {
    data = player.getVideoData?.();
  } catch {
    return;
  }
  if (!data || typeof data !== 'object') return;

  const videoId = cleanText(data.video_id, 32);
  if (videoId && typeof detail.videoId === 'string' && videoId !== detail.videoId) return;

  const title = cleanText(data.title, 180);
  const author = cleanText(data.author, 96);
  if (title) detail.videoTitle = title;
  if (author) detail.videoAuthor = author;
});
