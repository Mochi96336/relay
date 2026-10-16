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
    const playing = health?.contextState === 'running' && health?.playing;
    const row = (key, value, note = '', tone = 'neutral') => ({ key, label: t(`diag.listen.${key}`), value, note, tone });
    const zeroTone = value => health && value === 0 ? 'ok' : 'neutral';
    return { id: String(listener.connectionIncarnation), title: `${name}${listener.participantId === selfId ? ` · ${t('diag.listen.here')}` : ''} · ${t('diag.listen.connection')} ${listener.connectionIncarnation}`,
      // The title and summary carry the connection and format, so the rows
      // below do not repeat them.
      summary: `${state} · ${listener.codec === 'opus' ? 'Opus' : 'PCM16'}${health?.sampleRate ? ` · ${health.sampleRate / 1000} kHz` : ''}`,
      rows: [
        row('status', state, health ? t('diag.listen.age', { age: ms(age) }) : t('diag.listen.unknownNote'), health ? (playing ? 'ok' : 'warn') : 'neutral'),
        row('throughput', health && Number.isFinite(health.receivedKbps) ? `${health.receivedKbps.toFixed(1)} kbps` : '—', t('diag.listen.throughputNote')),
        row('buffer', health ? `${ms(health.queuedMs)} / ${ms(health.targetPrebufferMs)}` : '—', t('diag.listen.bufferNote'), health && Number.isFinite(health.queuedMs) ? (playing && health.queuedMs > 0 ? 'ok' : 'warn') : 'neutral'),
        row('jitter', health ? ms(health.arrivalJitterMs) : '—', t('diag.listen.jitterNote'), health && Number.isFinite(health.arrivalJitterMs) && health.queuedMs > 0 ? (health.arrivalJitterMs < health.queuedMs ? 'ok' : 'warn') : 'neutral'),
        row('underruns', health && Number.isFinite(health.underruns) ? String(health.underruns) : '—', t('diag.listen.underrunsNote'), zeroTone(health?.underruns)),
        row('conceal', health ? ms(health.concealedMs) : '—', t('diag.listen.concealNote'), zeroTone(health?.concealedMs)),
        row('trim', health ? ms(health.trimmedMs) : '—', t('diag.listen.trimNote'), zeroTone(health?.trimmedMs)),
        row('drop', health ? ms(health.droppedMs) : '—', t('diag.listen.dropNote'), zeroTone(health?.droppedMs)),
      ] };
  });
}
