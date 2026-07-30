// Streams — the Canals.
//
// A stream is not a channel between two grains. Producers publish to a stream
// id; subscribers register interest in that id; neither knows the other
// exists. The runtime keeps the subscription list (Orleans does this in a
// pub-sub rendezvous grain) and a PULLING AGENT on some silo is responsible
// for moving events from the stream to its subscribers.
//
// The agent is the part worth drawing. It is why stream delivery is decoupled
// from publishing, why a subscriber that is deactivated gets reactivated to
// receive, and why streams have a silo that owns their delivery even though
// neither producer nor consumer chose it.

import { hash32 } from './hash';
import type { GrainId, SiloAddress } from './types';

export interface Stream {
  readonly id: string;
  readonly producer: GrainId;
  readonly subscribers: GrainId[];
  published: number;
  delivered: number;
  nextPublishAt: number;
  sequence: number;
}

export class StreamRegistry {
  private readonly streams = new Map<string, Stream>();

  create(id: string, producer: GrainId, subscribers: GrainId[], firstPublishAt: number): Stream {
    const existing = this.streams.get(id);
    if (existing) return existing;
    const stream: Stream = {
      id,
      producer,
      subscribers: [...subscribers],
      published: 0,
      delivered: 0,
      nextPublishAt: firstPublishAt,
      sequence: 0,
    };
    this.streams.set(id, stream);
    return stream;
  }

  subscribe(streamId: string, subscriber: GrainId): boolean {
    const stream = this.streams.get(streamId);
    if (!stream || stream.subscribers.includes(subscriber)) return false;
    stream.subscribers.push(subscriber);
    return true;
  }

  unsubscribe(streamId: string, subscriber: GrainId): boolean {
    const stream = this.streams.get(streamId);
    if (!stream) return false;
    const index = stream.subscribers.indexOf(subscriber);
    if (index < 0) return false;
    stream.subscribers.splice(index, 1);
    return true;
  }

  get(id: string): Stream | undefined {
    return this.streams.get(id);
  }

  all(): readonly Stream[] {
    return [...this.streams.values()];
  }

  /** Streams whose next publish is due, rescheduled by `periodMs`. */
  collectDue(now: number, periodMs: number): Stream[] {
    const due: Stream[] = [];
    for (const stream of this.streams.values()) {
      if (stream.nextPublishAt > now) continue;
      stream.nextPublishAt = now + periodMs;
      stream.sequence++;
      stream.published++;
      due.push(stream);
    }
    return due;
  }

  recordDelivery(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (stream) stream.delivered++;
  }

  /**
   * Which silo's pulling agent services a stream. Hashed from the stream id so
   * responsibility is spread and stable — the same property the grain
   * directory gets from the ring.
   */
  static agentFor(streamId: string, activeSilos: readonly SiloAddress[]): SiloAddress | undefined {
    if (activeSilos.length === 0) return undefined;
    const ordered = [...activeSilos].sort();
    return ordered[hash32(streamId) % ordered.length];
  }
}
