export const PLAYBACK_TRANSPORT_KEY: string;
export const PLAYBACK_GENERATION_KEY: string;
export function validPlaybackTransportId(value: unknown): string | null;
export function shouldReusePlaybackTransport(storedTransportId: unknown, navigationType: unknown): boolean;
export function browserNavigationType(performanceObject: unknown): string;
export function preparePlaybackTransportStorage(
  storage: {
    getItem(key: string): string | null;
    removeItem(key: string): void;
  } | null | undefined,
  navigationType: unknown,
): 'unavailable' | 'reload' | 'rotated' | 'reset' | 'fresh';
