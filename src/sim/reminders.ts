// Reminders — the Clock Tower.
//
// The distinction that matters, and the one this district exists to make:
//
//   TIMER     in-memory, lives inside an activation, dies with it, does not
//             keep the grain alive. Fine for "poll every 5 seconds while I
//             happen to be running".
//
//   REMINDER  durable, stored outside the cluster, survives deactivation AND
//             silo failure, and REACTIVATES the grain in order to deliver.
//
// So a reminder is the only one of the two that can wake a grain nobody is
// calling — which is exactly why a ledger keeps ticking long after the last
// client went away, and why the collector cannot permanently retire it.

import type { GrainId } from './types';

export interface Reminder {
  readonly id: string;
  readonly grainId: GrainId;
  readonly periodMs: number;
  nextFireAt: number;
  firedCount: number;
}

export class ReminderTable {
  private readonly reminders = new Map<string, Reminder>();

  register(grainId: GrainId, periodMs: number, now: number, id?: string): Reminder {
    const reminderId = id ?? `${grainId}:reminder`;
    const existing = this.reminders.get(reminderId);
    if (existing) return existing;

    const reminder: Reminder = {
      id: reminderId,
      grainId,
      periodMs,
      nextFireAt: now + periodMs,
      firedCount: 0,
    };
    this.reminders.set(reminderId, reminder);
    return reminder;
  }

  unregister(reminderId: string): boolean {
    return this.reminders.delete(reminderId);
  }

  all(): readonly Reminder[] {
    return [...this.reminders.values()];
  }

  forGrain(grainId: GrainId): Reminder[] {
    return this.all().filter((r) => r.grainId === grainId);
  }

  /** Reminders due now, rescheduled to their next period. */
  collectDue(now: number): Reminder[] {
    const due: Reminder[] = [];
    for (const reminder of this.reminders.values()) {
      if (reminder.nextFireAt > now) continue;
      reminder.firedCount++;
      // Scheduled from now rather than from the previous deadline: a paused or
      // slowed simulation must not queue up a burst of missed firings.
      reminder.nextFireAt = now + reminder.periodMs;
      due.push(reminder);
    }
    return due;
  }

  get size(): number {
    return this.reminders.size;
  }
}
