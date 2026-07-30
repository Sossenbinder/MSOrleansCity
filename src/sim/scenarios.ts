// Scenarios — one-click stories.
//
// Each scenario sets the city up so that one mechanism is unmistakable, then
// gets out of the way. They are scripted against the public Cluster API only,
// so a scenario can never reach into simulation internals to fake an outcome —
// what you see is the model actually doing it.

import type { Cluster } from './cluster';

export interface ScenarioStep {
  /** Simulated ms after the scenario starts. */
  readonly at: number;
  readonly note?: string;
  run(cluster: Cluster): void;
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly teaches: string;
  /** What to watch for, shown while it runs. */
  readonly watchFor: string;
  readonly steps: readonly ScenarioStep[];
  /** Suggested run length in simulated ms. */
  readonly durationMs: number;
}

function step(at: number, note: string, run: (cluster: Cluster) => void): ScenarioStep {
  return { at, note, run };
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'cold-call',
    title: 'A cold call, hop by hop',
    teaches: 'Activation on first use',
    watchFor:
      'Cache miss, then the directory, then the zoning board, then a building rises — ' +
      'and only then does the call get answered.',
    durationMs: 20_000,
    steps: [step(0, 'Client calls user/42, which exists nowhere', (c) => c.callGrain('user/42'))],
  },

  {
    id: 'single-activation',
    title: 'Registration race',
    teaches: 'One activation per grain, cluster-wide',
    watchFor:
      'Several boroughs start building the same grain at once. Only one registration ' +
      'wins; the losers demolish what they started and defer to the winner.',
    durationMs: 25_000,
    steps: [
      step(0, 'Every gateway is asked for the same cold grain simultaneously', (c) => {
        for (const gateway of c.siloAddresses()) c.callGrain('user/7', 'Say', gateway);
      }),
    ],
  },

  {
    id: 'hot-grain',
    title: 'Hot grain',
    teaches: 'Single-threaded execution',
    watchFor:
      'One building grows tall as requests stack up outside its door. Everything ' +
      'queues, because a grain runs one turn at a time no matter how much load arrives.',
    durationMs: 40_000,
    steps: [
      step(0, 'Twelve simultaneous calls, all to the same grain', (c) => {
        for (let i = 0; i < 12; i++) c.callGrain('user/1');
      }),
      step(6_000, 'Twelve more', (c) => {
        for (let i = 0; i < 12; i++) c.callGrain('user/1');
      }),
    ],
  },

  {
    id: 'deadlock',
    title: 'Deadlock, and the fix',
    teaches: '[Reentrant]',
    watchFor:
      'alpha and beta call each other and both freeze — neither can accept the other’s ' +
      'call while waiting. gamma and delta do exactly the same thing but are ' +
      '[Reentrant], and sail straight through.',
    durationMs: 70_000,
    steps: [
      step(0, 'alpha/1 calls beta/1, which calls alpha/1 back', (c) => c.callGrain('alpha/1')),
      step(12_000, 'Same cycle, but both grains are [Reentrant]', (c) => c.callGrain('gamma/1')),
    ],
  },

  {
    id: 'silo-failure',
    title: 'Silo failure',
    teaches: 'Membership, quorum, recovery',
    watchFor:
      'The borough goes dark instantly, but the cluster keeps routing to it. Watch ' +
      'probes start missing, votes accumulate, and only then does the ring close over ' +
      'its arc and the grains come back elsewhere.',
    durationMs: 90_000,
    steps: [
      step(0, 'Warm the city up', (c) => {
        for (let i = 0; i < 10; i++) c.callGrain(`user/${i}`);
      }),
      step(14_000, 'Kill the busiest silo', (c) => {
        const busiest = [...c.snapshot().silos]
          .filter((s) => s.status === 'Active')
          .sort((a, b) => b.activationCount - a.activationCount)[0];
        if (busiest) c.killSilo(busiest.address);
      }),
      step(50_000, 'Call the lost grains again — they simply come back', (c) => {
        for (let i = 0; i < 10; i++) c.callGrain(`user/${i}`);
      }),
    ],
  },

  {
    id: 'collection',
    title: 'Collection sweep',
    teaches: 'Why grains are "virtual"',
    watchFor:
      'Buildings that stop being used are demolished, and their directory entries go ' +
      'with them. Call one again and it is silently rebuilt — the caller never knows.',
    durationMs: 60_000,
    steps: [
      step(0, 'Activate eight grains', (c) => {
        for (let i = 0; i < 8; i++) c.callGrain(`order/${i}`);
      }),
      step(30_000, 'Call two of them again after the sweep', (c) => {
        c.callGrain('order/0');
        c.callGrain('order/3');
      }),
    ],
  },

  {
    id: 'persistence',
    title: 'Persistent state',
    teaches: 'IPersistentState and ETags',
    watchFor:
      'Persistent grains take a trip to the vault before they can take a turn, and ' +
      'another trip after every turn. The shelves fill as versions accumulate.',
    durationMs: 50_000,
    steps: [
      step(0, 'Activate three persistent grains', (c) => {
        for (let i = 0; i < 3; i++) c.callGrain(`account/${i}`);
      }),
      step(14_000, 'Write to them repeatedly', (c) => {
        for (let i = 0; i < 3; i++) {
          c.callGrain(`account/${i}`);
          c.callGrain(`account/${i}`);
        }
      }),
    ],
  },

  {
    id: 'reminders-streams',
    title: 'Reminders and streams',
    teaches: 'Waking a grain nobody called',
    watchFor:
      'The clock tower reactivates a collected ledger with no client involved. The ' +
      'canals deliver stream events to subscribers that were not running either.',
    durationMs: 90_000,
    steps: [
      step(0, 'A ledger registers a durable reminder on activation', (c) =>
        c.callGrain('ledger/1'),
      ),
      step(1_000, 'Open a stream with two subscribers', (c) =>
        c.createStream('orders', 'user/1', ['feed/1', 'feed/2']),
      ),
    ],
  },
];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/** Drives a scenario's steps against simulated time. */
export class ScenarioRunner {
  private scenario: Scenario | undefined;
  private startedAt = 0;
  private nextStep = 0;

  start(scenario: Scenario, now: number): void {
    this.scenario = scenario;
    this.startedAt = now;
    this.nextStep = 0;
  }

  stop(): void {
    this.scenario = undefined;
  }

  get active(): Scenario | undefined {
    return this.scenario;
  }

  elapsed(now: number): number {
    return this.scenario ? now - this.startedAt : 0;
  }

  /** Runs any steps that have come due. Returns the note of the last one run. */
  tick(cluster: Cluster, now: number): string | undefined {
    if (!this.scenario) return undefined;
    const elapsed = now - this.startedAt;
    let note: string | undefined;

    while (this.nextStep < this.scenario.steps.length) {
      const step = this.scenario.steps[this.nextStep];
      if (!step || step.at > elapsed) break;
      step.run(cluster);
      note = step.note;
      this.nextStep++;
    }
    return note;
  }

  get finished(): boolean {
    return this.scenario !== undefined && this.nextStep >= this.scenario.steps.length;
  }
}
