export type SessionOwnershipProjection = {
  revision: number;
  serverIncarnation: string | null;
  micOwnerId: string | null;
  retiredIncarnations: string[];
};

export function reduceSessionOwnership(
  previous: SessionOwnershipProjection | null,
  message: unknown,
): SessionOwnershipProjection | null;
