import { describe, expect, it } from 'vitest';
import { Activation, type GrainType } from './activation';
import { advanceTurns } from './scheduler';
import type { GrainAddress, RequestId } from './types';

const ADDRESS: GrainAddress = { grainId: 'user/42', activationId: 'a1', silo: 'silo-a' };
const NON_REENTRANT: GrainType = {
  name: 'user',
  reentrant: false,
  persistent: false,
  description: '',
};
const REENTRANT: GrainType = {
  name: 'user',
  reentrant: true,
  persistent: false,
  description: '',
};
const TURN = { turnDurationMs: 100 };

function noopHooks() {
  return {
    started: [] as RequestId[],
    completed: [] as RequestId[],
  };
}

function makeActivation(grainType: GrainType): Activation {
  const activation = new Activation(ADDRESS, grainType, 0);
  activation.state = 'Valid';
  return activation;
}

function enqueue(activation: Activation, count: number, at = 0): void {
  for (let i = 0; i < count; i++) {
    activation.enqueue({ requestId: `r${i}`, method: 'Say', origin: 'silo-a', enqueuedAt: at });
  }
}

describe('turn-based scheduler', () => {
  it('never runs two turns at once on a non-reentrant grain', () => {
    const activation = makeActivation(NON_REENTRANT);
    const log = noopHooks();
    enqueue(activation, 5);

    let maxConcurrent = 0;
    for (let now = 0; now <= 1000; now += 10) {
      advanceTurns([activation], now, TURN, {
        onTurnStarted: (_a, id) => {
          log.started.push(id);
          return undefined;
        },
        onTurnCompleted: (_a, id) => log.completed.push(id),
      });
      maxConcurrent = Math.max(maxConcurrent, activation.running.length);
    }

    expect(maxConcurrent).toBe(1);
    expect(log.completed).toHaveLength(5);
  });

  it('processes queued requests strictly in arrival order', () => {
    const activation = makeActivation(NON_REENTRANT);
    const log = noopHooks();
    enqueue(activation, 4);

    for (let now = 0; now <= 1000; now += 10) {
      advanceTurns([activation], now, TURN, {
        onTurnStarted: (_a, id) => {
          log.started.push(id);
          return undefined;
        },
        onTurnCompleted: (_a, id) => log.completed.push(id),
      });
    }

    expect(log.started).toEqual(['r0', 'r1', 'r2', 'r3']);
    expect(log.completed).toEqual(['r0', 'r1', 'r2', 'r3']);
  });

  it('serialises the queue — n requests take n turn durations', () => {
    const activation = makeActivation(NON_REENTRANT);
    enqueue(activation, 3);
    const completedAt: number[] = [];

    for (let now = 0; now <= 1000; now += 10) {
      advanceTurns([activation], now, TURN, {
        onTurnStarted: () => undefined,
        onTurnCompleted: () => completedAt.push(now),
      });
    }

    // Each request waits for every request ahead of it. That queueing is the
    // whole visible consequence of single-threaded grain execution.
    expect(completedAt).toEqual([100, 200, 300]);
  });

  it('lets a reentrant grain interleave turns', () => {
    const activation = makeActivation(REENTRANT);
    enqueue(activation, 5);

    advanceTurns([activation], 0, TURN, {
      onTurnStarted: () => undefined,
      onTurnCompleted: () => {},
    });

    expect(activation.running.length).toBe(5);
  });

  it('admits nothing until the activation is Valid', () => {
    const activation = new Activation(ADDRESS, NON_REENTRANT, 0);
    activation.state = 'Activating';
    enqueue(activation, 2);

    advanceTurns([activation], 50, TURN, {
      onTurnStarted: () => undefined,
      onTurnCompleted: () => {},
    });

    expect(activation.running).toHaveLength(0);
    expect(activation.inbox).toHaveLength(2);
  });

  it('counts completed turns and tracks idleness', () => {
    const activation = makeActivation(NON_REENTRANT);
    enqueue(activation, 1);

    for (let now = 0; now <= 200; now += 10) {
      advanceTurns([activation], now, TURN, {
        onTurnStarted: () => undefined,
        onTurnCompleted: () => {},
      });
    }

    expect(activation.turnsCompleted).toBe(1);
    expect(activation.isIdle()).toBe(true);
    expect(activation.idleFor(300)).toBe(200);
  });
});
