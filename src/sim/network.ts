// Message transport — the roads.
//
// Every message takes real (simulated) time to travel, because the whole point
// of the city is that you can watch a request move. Latency is drawn from the
// seeded RNG so runs stay reproducible.

import type { Rng } from '../core/rng';
import type { Envelope, InFlight, NodeRef } from './types';

export interface NetworkOptions {
  readonly hopMs: number;
  /** Fractional jitter, e.g. 0.15 for +/-15%. Keeps traffic from lock-stepping. */
  readonly jitter: number;
}

export class Network {
  private readonly messages: InFlight[] = [];
  private nextId = 0;

  constructor(
    private readonly rng: Rng,
    private options: NetworkOptions,
  ) {}

  setOptions(options: NetworkOptions): void {
    this.options = options;
  }

  send(envelope: Envelope, from: NodeRef, to: NodeRef, now: number): InFlight {
    const spread = this.options.hopMs * this.options.jitter;
    const latency = Math.max(1, this.options.hopMs + this.rng.range(-spread, spread));
    const message: InFlight = {
      id: `m${this.nextId++}`,
      envelope,
      from,
      to,
      sentAt: now,
      arrivesAt: now + latency,
    };
    this.messages.push(message);
    return message;
  }

  /** Removes and returns every message that has arrived, oldest arrival first. */
  collectArrived(now: number): InFlight[] {
    const arrived: InFlight[] = [];
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i];
      if (!message || message.arrivesAt > now) continue;
      arrived.push(message);
      this.messages.splice(i, 1);
    }
    arrived.sort((a, b) => a.arrivesAt - b.arrivesAt);
    return arrived;
  }

  inFlight(): readonly InFlight[] {
    return this.messages;
  }

  /** Drops everything in transit to or from a node. Used when a silo dies. */
  dropInvolving(predicate: (message: InFlight) => boolean): InFlight[] {
    const dropped: InFlight[] = [];
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i];
      if (!message || !predicate(message)) continue;
      dropped.push(message);
      this.messages.splice(i, 1);
    }
    return dropped;
  }

  clear(): void {
    this.messages.length = 0;
  }
}

/** 0..1 along the route, clamped. */
export function progressOf(message: InFlight, now: number): number {
  const span = message.arrivesAt - message.sentAt;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (now - message.sentAt) / span));
}
