import { sendParticipantAuthentication } from './participant-auth.js';

function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const source = new URLSearchParams(location.search);
  const params = new URLSearchParams();
  const key = source.get('key');
  if (key) params.set('key', key);
  const query = params.toString();
  return `${protocol}//${location.host}/ws${query ? `?${query}` : ''}`;
}

/**
 * Sends one Mic-owner calibration command on a short-lived authenticated socket.
 *
 * The normal publisher control socket historically gates its hidden calibration
 * button on Song presence. Robot boot-probe calibration deliberately does not:
 * it is useful as a preflight path measurement before any Song is loaded. This
 * adapter keeps that exceptional command path narrow while the legacy publisher
 * control surface is retired.
 *
 * The promise resolves only after the server publishes the expected boot-probe
 * transition. Keeping the caller pending across that acknowledgement prevents
 * the visible action from briefly becoming clickable again between send() and
 * ProductStatus, and avoids treating an unrelated timing broadcast as success.
 */
export function sendPreflightCalibrationCommand({ timeoutMs = 4_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== 'function') {
      reject(new Error('Calibration command transport is unavailable.'));
      return;
    }

    const socket = new WebSocket(wsUrl());
    let settled = false;
    let sent = false;
    const timer = setTimeout(() => finish(new Error('Calibration command timed out.')), timeoutMs);

    function finish(error = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      if (error) reject(error);
      else resolve();
    }

    socket.addEventListener('open', () => {
      if (!sendParticipantAuthentication(socket)) {
        finish(new Error('Participant authentication is unavailable.'));
      }
    });

    socket.addEventListener('message', (event) => {
      if (settled || typeof event.data !== 'string') return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }

      if (message?.type === 'participant-auth-rejected') {
        finish(new Error('Participant authentication was rejected.'));
        return;
      }

      if (message?.type === 'calibration-command-rejected') {
        finish(new Error(
          typeof message.reason === 'string' && message.reason
            ? message.reason
            : 'Calibration command was rejected.',
        ));
        return;
      }

      if (
        message?.type === 'command-rejected'
        && message.command === 'start-timing-calibration'
      ) {
        finish(new Error(
          typeof message.reason === 'string' && message.reason
            ? message.reason
            : 'Calibration command was rejected.',
        ));
        return;
      }

      if (message?.type === 'participant-authenticated' && !sent) {
        sent = true;
        socket.send(JSON.stringify({ type: 'start-timing-calibration' }));
        return;
      }

      if (sent && message?.type === 'timing-calibration-status') {
        if (message.state === 'failed' && typeof message.error === 'string' && message.error) {
          finish(new Error(message.error));
        } else if (message.probeActive === true) {
          finish();
        }
      }
    });

    socket.addEventListener('error', () => finish(new Error('Calibration command transport failed.')));
    socket.addEventListener('close', () => {
      if (!settled) {
        finish(new Error(
          sent
            ? 'Calibration command transport closed before server acknowledgement.'
            : 'Calibration command transport closed early.',
        ));
      }
    });
  });
}
