let browserMicSessionEpoch = 0;

if (typeof window !== 'undefined') {
  window.addEventListener('relay-microphone-local-state', (event) => {
    if (event.detail?.active === true) browserMicSessionEpoch += 1;
  });
}

export class MicLifecycleTransaction {
  #pendingBySession = new Map();

  run({ sessionEpoch = browserMicSessionEpoch, stop, isCurrent, onEnded }) {
    const pending = this.#pendingBySession.get(sessionEpoch);
    if (pending) return pending;

    const transaction = (async () => {
      const stoppedEpoch = await stop();
      if (!isCurrent(stoppedEpoch)) return false;
      onEnded();
      return true;
    })();

    this.#pendingBySession.set(sessionEpoch, transaction);
    const clear = () => {
      if (this.#pendingBySession.get(sessionEpoch) === transaction) {
        this.#pendingBySession.delete(sessionEpoch);
      }
    };
    transaction.then(clear, clear);
    return transaction;
  }
}
