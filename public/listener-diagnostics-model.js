import { diagnosticsTranslator } from './diagnostics-copy.js';

export function describeListeners({ statusz, session, selfId } = {}, t = diagnosticsTranslator()) {
  const listeners = statusz?.audio?.listenerPlayback;
  if (!Array.isArray(listeners)) return null;
  const ms = value => typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)} ms` : '—';
  return listeners.map(listener => {
    const name = session?.participants?.find(p => p.id === listener.participantId)?.nickname
      || t('diag.listen.receiver');
    const age = listener.reportAgeMs;
    const health = typeof age === 'number' && age <= 2000 ? listener.health : null;
    const state = !health ? t(age == null ? 'diag.listen.unknown' : 'diag.listen.stale')
      : t(health.contextState === 'running' && health.playing ? 'diag.listen.playing' : 'diag.listen.buffering');
    const row = (key, value, note = '') => ({ key, label: t(`diag.listen.${key}`), value, note, tone: 'neutral' });
    return { id: String(listener.connectionIncarnation), title: `${name}${listener.participantId === selfId ? ` · ${t('diag.listen.here')}` : ''} · #${listener.connectionIncarnation}`,
      summary: `${state} · ${listener.codec === 'opus' ? 'Opus' : 'PCM16'}`,
      rows: [
        row('status', state, health ? t('diag.listen.age', { age: ms(age) }) : t('diag.listen.unknownNote')),
        row('format', `${listener.codec === 'opus' ? 'Opus' : 'PCM16'}${health?.sampleRate ? ` · ${health.sampleRate / 1000} kHz` : ''}`),
        row('buffer', health ? `${ms(health.queuedMs)} / ${ms(health.targetPrebufferMs)}` : '—', t('diag.listen.bufferNote')),
        row('jitter', health ? ms(health.arrivalJitterMs) : '—'),
        row('underruns', health && Number.isFinite(health.underruns) ? String(health.underruns) : '—'),
        row('conceal', health ? ms(health.concealedMs) : '—'),
        row('trim', health ? ms(health.trimmedMs) : '—'),
        row('drop', health ? ms(health.droppedMs) : '—'),
      ] };
  });
}
