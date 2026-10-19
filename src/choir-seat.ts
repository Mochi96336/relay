type AuthenticatedSocket = object & { participantId?: string };

export type ChoirSeatHolder = Readonly<{
  primaryId: string;
  secondaryId: string;
  /** The socket B joined from: the only one that speaks for B. */
  socket: AuthenticatedSocket;
}>;

/**
 * Who the second singer is. B joins whoever holds the Mic by pressing
 * + Second Mic on its own authenticated socket; A does not approve and
 * cannot remove B. There is one B at a time, and like the Mic itself the
 * seat can be taken over: a different B joining replaces the one in, who is
 * told it was `replaced`.
 *
 * A join is not tied to a song. It lasts while A holds the Mic and B's
 * socket stays open, across pauses, seeks and Takes. It grants no media by
 * itself: B's media socket still needs a one-use claim (ChoirMediaClaims).
 *
 * Real participant identity comes from a server-authenticated socket, never
 * from a client-supplied participantId or a nickname.
 */
export class ChoirSeat {
  private current: ChoirSeatHolder | null = null;

  constructor(private readonly policy: {
    /** Whether `id` holds the Mic with its media live: required to join. */
    primaryStillOwnsMic: (id: string) => boolean;
    /**
     * Whether `id` still holds the Mic, through a reconnect grace. A join
     * follows the Mic owner, so a brief media or control hiccup must not end
     * it; only a new owner does.
     */
    holdsMic: (id: string) => boolean;
    participantConnected: (id: string) => boolean;
    socketOpen: (socket: AuthenticatedSocket) => boolean;
    notifySocket: (socket: AuthenticatedSocket, payload: Record<string, unknown>) => void;
  }) {}

  private valid(join: ChoirSeatHolder) {
    return this.policy.socketOpen(join.socket)
      && this.policy.holdsMic(join.primaryId)
      && this.policy.participantConnected(join.secondaryId);
  }

  /**
   * B joins the current Mic owner. Returns false when nobody else holds the
   * Mic, or when a reconnecting B finds its seat taken.
   */
  join(socket: AuthenticatedSocket, primaryId: string | null, { resume = false } = {}): boolean {
    this.sweep();
    const secondaryId = socket.participantId;
    if (!secondaryId || !primaryId || secondaryId === primaryId
      || !this.policy.socketOpen(socket)
      || !this.policy.primaryStillOwnsMic(primaryId)
      || !this.policy.participantConnected(secondaryId)) return false;
    const previous = this.current;
    if (previous && previous.primaryId === primaryId && previous.secondaryId === secondaryId
      && previous.socket === socket) return true;
    // Reconnection is not a user request to take over another singer's seat.
    if (resume && previous && previous.primaryId === primaryId
      && previous.secondaryId !== secondaryId) return false;
    this.current = { primaryId, secondaryId, socket };
    if (previous && previous.secondaryId !== secondaryId) this.notifyRevoked(previous, 'replaced');
    this.policy.notifySocket(socket, {
      type: 'choir-secondary-consent-status', status: 'accepted',
      secondaryId, primaryId, joined: true,
    });
    return true;
  }

  /** The joined pair, if a B is in. */
  active(): ChoirSeatHolder | null {
    this.sweep();
    return this.current;
  }

  /**
   * Whether this is the socket B joined from: the only one whose reports
   * (gain, song anchors, page state, test tone) may steer B's voice, and the
   * only one that may claim B's media. Another tab of the same participant
   * is not B.
   */
  isJoinSocket(socket: AuthenticatedSocket): boolean {
    return this.active()?.socket === socket;
  }

  /** B leaves, from the socket it joined on. */
  withdraw(socket: AuthenticatedSocket): boolean {
    if (!this.current || this.current.socket !== socket || !this.policy.socketOpen(socket)) return false;
    this.current = null;
    return true;
  }

  /** Closing B's join socket ends the join. */
  disconnected(socket: AuthenticatedSocket): boolean {
    if (this.current?.socket !== socket) return false;
    const join = this.current;
    this.current = null;
    this.notifyRevoked(join, 'connection-closed');
    return true;
  }

  /** Ends a join whose Mic owner, B or socket is gone. */
  sweep(): boolean {
    if (!this.current || this.valid(this.current)) return false;
    const join = this.current;
    this.current = null;
    this.notifyRevoked(join, 'scope-or-authority-changed');
    return true;
  }

  private notifyRevoked(join: ChoirSeatHolder, reason: string) {
    if (!this.policy.socketOpen(join.socket)) return;
    this.policy.notifySocket(join.socket, {
      type: 'choir-secondary-consent-status', status: 'revoked',
      reason, secondaryId: join.secondaryId,
    });
  }
}
