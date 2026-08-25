export type AuthorityStateInput<T = unknown> = {
  authorityFresh?: boolean;
  lastKnownSnapshot?: T | null;
  commandChannelFresh?: boolean;
  authorized?: boolean;
  serverAllowed?: boolean;
};

export type AuthorityState<T = unknown> = {
  authorityFresh: boolean;
  lastKnownSnapshot: T | null;
  commandChannelFresh: boolean;
  authorized: boolean;
  serverAllowed: boolean;
  actionable: boolean;
  stale: boolean;
  unknown: boolean;
};

export function authorityState<T = unknown>(input?: AuthorityStateInput<T>): AuthorityState<T>;
export function authorityPresentation(state: AuthorityState<unknown> | null | undefined): 'unknown' | 'reconnecting' | 'fresh';
