function validQualityVerdict(value) {
  return value === null || value === 'clean' || value === 'review' || value === 'degraded';
}

export function validHistoryEntry(entry) {
  return Boolean(
    entry
    && typeof entry === 'object'
    && typeof entry.takeId === 'string'
    && Number.isFinite(Number(entry.endedAtMs))
    && (entry.songVideoId === null || typeof entry.songVideoId === 'string')
    && entry.artifact
    && typeof entry.artifact.url === 'string'
    && Number.isFinite(Number(entry.artifact.durationMs))
    && validQualityVerdict(entry.qualityVerdict)
    && typeof entry.recovered === 'boolean',
  );
}

export function historyEntryFromCurrentTake(take) {
  if (
    !take
    || typeof take.takeId !== 'string'
    || !Number.isFinite(Number(take.endedAtMs))
    || !take.artifact
    || typeof take.artifact.url !== 'string'
    || !Number.isFinite(Number(take.artifact.durationMs))
  ) return null;

  const verdict = take.quality?.verdict;
  return {
    takeId: take.takeId,
    endedAtMs: Number(take.endedAtMs),
    songVideoId: typeof take.song?.videoId === 'string' && take.song.videoId
      ? take.song.videoId
      : null,
    artifact: {
      url: take.artifact.url,
      durationMs: Number(take.artifact.durationMs),
    },
    qualityVerdict: validQualityVerdict(verdict) ? verdict : null,
    recovered: false,
  };
}

export function historyFromStatus(status, previous = []) {
  const next = Array.isArray(status?.history)
    ? status.history.filter(validHistoryEntry).map((entry) => structuredClone(entry))
    : previous.filter(validHistoryEntry).map((entry) => structuredClone(entry));

  // A finalized WAV is still a valid current review target if its metadata
  // sidecar failed to persist. Map the existing lifecycle payload down to the
  // same product history shape rather than leaking the richer TakeRecord into
  // the history collection.
  const current = status?.lifecycle === 'ready'
    ? historyEntryFromCurrentTake(status.take)
    : null;
  if (current) {
    const existing = next.findIndex((entry) => entry.takeId === current.takeId);
    if (existing >= 0) next.splice(existing, 1, current);
    else next.unshift(current);
  }

  return next.sort((a, b) => Number(b.endedAtMs) - Number(a.endedAtMs));
}

export function groupHistory(entries) {
  const groups = new Map();
  for (const entry of entries.filter(validHistoryEntry)) {
    const videoId = typeof entry.songVideoId === 'string' && entry.songVideoId
      ? entry.songVideoId
      : null;
    const kind = entry.recovered === true && !videoId
      ? 'recovered'
      : videoId
        ? 'song'
        : 'voice';
    const key = kind === 'song' ? `song:${videoId}` : kind;
    if (!groups.has(key)) groups.set(key, { key, kind, videoId, entries: [] });
    groups.get(key).entries.push(entry);
  }
  return [...groups.values()];
}
