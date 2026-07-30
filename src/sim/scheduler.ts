// The turn-based scheduler — the revolving door.
//
// This is the Orleans concept people most often get wrong, and the one a city
// shows better than prose can: an activation processes ONE request at a time.
// Not one per core, not one per connection — one. Everything else waits in the
// street. There is no lock anywhere, and no grain code ever needs one, because
// the scheduler simply never runs two turns concurrently on the same
// activation.
//
// The subtle half is what happens when a turn awaits another grain. On a
// non-reentrant grain the activation stays OCCUPIED for the whole round trip —
// it is not returned to the pool, and nothing queued behind it can run. Two
// grains awaiting each other therefore wait forever, and only the request
// timeout breaks it. Marking a grain [Reentrant] lets a second turn in while
// the first waits, which is exactly why it fixes the cycle.

import type { Activation } from './activation';
import type { GrainAddress, GrainId, RequestId } from './types';

/** What a turn is waiting on, when it issues an outbound call. */
export interface TurnAwait {
  readonly blockedOn: GrainId;
  /** Id of the outbound call — distinct from the turn's own request id. */
  readonly awaitingRequestId: RequestId;
}

export interface SchedulerHooks {
  /**
   * Called as a turn begins. Return a TurnAwait to model the turn awaiting
   * another grain: it blocks, the activation stays occupied, and the caller
   * must later call resumeTurn(). Return undefined for a turn that just runs.
   */
  onTurnStarted(
    address: GrainAddress,
    requestId: RequestId,
    method: string,
  ): TurnAwait | undefined;
  onTurnCompleted(address: GrainAddress, requestId: RequestId, origin: string): void;
}

export interface SchedulerOptions {
  readonly turnDurationMs: number;
}

/**
 * Advances every activation by one tick: finishes turns that are due, then
 * admits waiting requests up to the concurrency cap.
 *
 * Order matters — completing before admitting means a freed slot is reused in
 * the same tick, so a queue drains at one turn per turnDuration rather than
 * stalling an extra tick per request.
 */
export function advanceTurns(
  activations: Iterable<Activation>,
  now: number,
  options: SchedulerOptions,
  hooks: SchedulerHooks,
): void {
  for (const activation of activations) {
    completeDueTurns(activation, now, hooks);
    admitWaiting(activation, now, options, hooks);
  }
}

function completeDueTurns(activation: Activation, now: number, hooks: SchedulerHooks): void {
  if (activation.running.length === 0) return;

  // Iterate backwards so splicing does not skip entries.
  for (let i = activation.running.length - 1; i >= 0; i--) {
    const turn = activation.running[i];
    if (!turn || turn.blockedOn !== undefined || turn.endsAt > now) continue;
    activation.running.splice(i, 1);
    activation.turnsCompleted++;
    activation.lastUsedAt = now;
    hooks.onTurnCompleted(activation.address, turn.request.requestId, turn.request.origin);
  }
}

function admitWaiting(
  activation: Activation,
  now: number,
  options: SchedulerOptions,
  hooks: SchedulerHooks,
): void {
  if (!activation.acceptsTurns) return;

  while (
    activation.inbox.length > 0 &&
    activation.running.length < activation.maxConcurrentTurns
  ) {
    const request = activation.inbox.shift();
    if (!request) break;

    const turn = {
      request,
      startedAt: now,
      endsAt: now + options.turnDurationMs,
      blockedOn: undefined as GrainId | undefined,
      awaitingRequestId: undefined as RequestId | undefined,
    };
    activation.running.push(turn);
    activation.lastUsedAt = now;

    const awaiting = hooks.onTurnStarted(
      activation.address,
      request.requestId,
      request.method,
    );
    if (awaiting !== undefined) {
      turn.blockedOn = awaiting.blockedOn;
      turn.awaitingRequestId = awaiting.awaitingRequestId;
      turn.endsAt = Number.POSITIVE_INFINITY;
    }
  }
}

/**
 * Un-blocks a turn whose awaited call has returned. It still owes the rest of
 * its work, so it finishes one turn duration later rather than immediately.
 *
 * `awaitedRequestId` is the id of the OUTBOUND call that just came back, not
 * the id of the turn itself.
 */
export function resumeTurn(
  activation: Activation,
  awaitedRequestId: RequestId,
  now: number,
  options: SchedulerOptions,
): boolean {
  const turn = activation.turnAwaiting(awaitedRequestId);
  if (!turn || turn.blockedOn === undefined) return false;
  turn.blockedOn = undefined;
  turn.awaitingRequestId = undefined;
  turn.endsAt = now + options.turnDurationMs;
  activation.lastUsedAt = now;
  return true;
}

/**
 * Finds cycles in the "who is waiting on whom" graph — the deadlocks.
 *
 * Reentrant grains are excluded as blockers: they admit another turn while
 * waiting, so their presence in a cycle does not stop it progressing. That is
 * the whole reason [Reentrant] is the fix.
 */
export function findDeadlocks(activations: Iterable<Activation>): GrainId[][] {
  const waitingOn = new Map<GrainId, GrainId>();
  for (const activation of activations) {
    if (activation.grainType.reentrant) continue;
    const blocked = activation.blockedOn;
    if (blocked !== undefined) waitingOn.set(activation.grainId, blocked);
  }

  const cycles: GrainId[][] = [];
  const seen = new Set<GrainId>();

  for (const start of waitingOn.keys()) {
    if (seen.has(start)) continue;

    const path: GrainId[] = [];
    const onPath = new Set<GrainId>();
    let current: GrainId | undefined = start;

    while (current !== undefined && !seen.has(current)) {
      if (onPath.has(current)) {
        cycles.push(path.slice(path.indexOf(current)));
        break;
      }
      path.push(current);
      onPath.add(current);
      current = waitingOn.get(current);
    }

    for (const node of path) seen.add(node);
  }

  return cycles;
}
