import type { CaptureDispatchClassification } from './capture-dispatch.js';
import type { CaptureClippingSnapshot } from './capture-observability.js';

export type UplinkDropReason = 'disconnected' | 'congested' | 'packet-too-large' | 'capture-backlog';

export function resetUplinkEvidence(): void;

export function countUplinkDrop(sampleCount: number, reason: UplinkDropReason | string): void;

export function noteCaptureDispatch(dispatch: CaptureDispatchClassification): void;

export function noteCaptureClipping(clipping: CaptureClippingSnapshot | null): void;

export function uplinkEvidenceReport(latestLocalMicLevel: unknown): {
  captureClipping: {
    railSamples: number;
    maxConsecutiveRailSamples: number;
    recentDetected?: boolean;
  } | null;
  captureDispatch: {
    lagMs: number;
    maxLagMs: number;
    backlogMs: number;
    backlogActive: boolean;
  } | null;
  droppedSamples: {
    total: number;
    disconnected: number;
    congested: number;
    packetTooLarge: number;
    captureBacklog: number;
  };
};

export function noteUplinkHealthSent(healthRequestId: number, sentAtMs: number): void;

export function settleCaptureClippingHealth(healthRequestId: number): boolean;

export function forgetUnsettledUplinkHealth(): void;
