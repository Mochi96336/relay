export const LISTEN_VOLUME_KEY: string;
export const MIC_GAIN_KEY: string;
export function storedNumber(key: string, min: number, max: number): number | null;
export function storeNumber(key: string, value: number): void;
