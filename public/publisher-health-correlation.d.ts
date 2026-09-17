export type PublisherHealthCorrelationIssue = {
  socket: object;
  sessionEpoch: number;
  generation: number;
  sentAtMs: number;
};

export type PublisherHealthCorrelationConsume = {
  requestId: number;
  socket: object | null;
  sessionEpoch: number;
  generation: number;
};

export type PublisherHealthRequestCorrelationOptions = {
  maxPending?: number;
};

export class PublisherHealthRequestCorrelation {
  constructor(options?: PublisherHealthRequestCorrelationOptions);
  reset(): void;
  issue(evidence: PublisherHealthCorrelationIssue): number;
  forget(requestId: number): boolean;
  consume(evidence: PublisherHealthCorrelationConsume): number | null;
}
