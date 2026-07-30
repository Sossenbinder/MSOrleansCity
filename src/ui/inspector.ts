// The inspector — the teaching surface.
//
// Clicking anything in the city answers three questions, always in the same
// order (outline: Approach):
//
//   1. What did I click, and what is it doing right now?
//   2. What is this in Orleans — the actual type or interface?
//   3. Which configuration option governs it in a real cluster?
//
// Point 3 is what makes this worth returning to rather than a toy. Where a
// knob's real Orleans default has not been verified against source yet, we say
// so explicitly instead of quietly showing our own simulated number as if it
// were Orleans' (see sim/config.ts).

import type { Inspectable } from '../core/inspect';
import { MESSAGE_COLORS, MESSAGE_LABELS, siloColorCss } from '../core/theme';
import { COUNTS, KNOBS, isTimeKnob, type Setting } from '../sim/config';
import { GRAIN_TYPES } from '../sim/grainTypes';
import { directorFor, type PlacementStrategyId } from '../sim/placement';
import type { SimState } from '../sim/types';

interface Section {
  readonly title: string;
  readonly subtitle: string;
  readonly accent: string;
  readonly facts: ReadonlyArray<readonly [string, string]>;
  readonly orleansType: string;
  readonly explanation: string;
  readonly knobs: readonly Setting[];
}

function knobRow(setting: Setting): string {
  const simulated = isTimeKnob(setting)
    ? `${(setting.simulatedMs / 1000).toFixed(1)}s`
    : String(setting.simulated);

  let real: string;
  if (!setting.orleansDefault) {
    real = '<span class="unverified">not yet verified against Orleans source</span>';
  } else if (isTimeKnob(setting)) {
    real = `${(setting.orleansDefault.valueMs / 1000).toFixed(1)}s <span class="src">${escape(setting.orleansDefault.sourceRef)}</span>`;
  } else {
    real = `${setting.orleansDefault.value} <span class="src">${escape(setting.orleansDefault.sourceRef)}</span>`;
  }

  return `
    <div class="knob">
      <div class="knob-label">${escape(setting.label)}</div>
      <code>${escape(setting.optionsClass)}</code>
      <div class="knob-values">
        <span>simulated <b>${simulated}</b></span>
        <span>real default ${real}</span>
      </div>
      <p>${escape(setting.description)}</p>
    </div>`;
}

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export class Inspector {
  private readonly root: HTMLDivElement;
  private current: Inspectable | undefined;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'panel inspector hidden';
    parent.appendChild(this.root);
  }

  select(inspectable: Inspectable | undefined): void {
    this.current = inspectable;
    this.root.classList.toggle('hidden', inspectable === undefined);
  }

  get selection(): Inspectable | undefined {
    return this.current;
  }

  render(state: SimState, placement: PlacementStrategyId): void {
    if (!this.current) return;
    const section = this.describe(this.current, state, placement);
    if (!section) return;

    this.root.innerHTML = `
      <button class="close" type="button" aria-label="Close">&times;</button>
      <div class="accent" style="background:${section.accent}"></div>
      <h2>${escape(section.title)}</h2>
      <div class="subtitle">${escape(section.subtitle)}</div>
      <dl>${section.facts
        .map(([k, v]) => `<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`)
        .join('')}</dl>
      <h3>In Orleans</h3>
      <code class="type">${escape(section.orleansType)}</code>
      <p>${escape(section.explanation)}</p>
      ${section.knobs.length ? `<h3>Governed by</h3>${section.knobs.map(knobRow).join('')}` : ''}
    `;

    this.root.querySelector('.close')?.addEventListener('click', () => this.select(undefined));
  }

  private describe(
    target: Inspectable,
    state: SimState,
    placement: PlacementStrategyId,
  ): Section | undefined {
    switch (target.kind) {
      case 'silo': {
        const silo = state.silos.find((s) => s.address === target.address);
        if (!silo) return undefined;

        const health = silo.status === 'Dead'
          ? 'Dead — declared by quorum'
          : silo.crashed
            ? 'Crashed — the cluster has NOT noticed yet'
            : silo.suspicionVotes > 0
              ? `Suspected (${silo.suspicionVotes}/${silo.votesRequired} votes)`
              : 'Healthy';

        return {
          title: 'Borough',
          subtitle: silo.address,
          accent: siloColorCss(silo.index),
          facts: [
            ['Membership status', silo.status],
            ['Actual health', health],
            ['Activations hosted', String(silo.activationCount)],
            ['Directory entries owned', String(silo.directoryEntryCount)],
            ['Cached addresses', String(silo.cacheEntryCount)],
            ['Watching', silo.probing.length ? silo.probing.join(', ') : '—'],
            [
              'Last IAmAlive',
              silo.status === 'Dead'
                ? '—'
                : `${((state.now - silo.iAmAliveAt) / 1000).toFixed(1)}s ago`,
            ],
            ['Ring positions', silo.ringPositions.map((p) => p.toFixed(4)).join(', ')],
          ],
          orleansType: 'Orleans.Runtime.Silo · SiloAddress (ip:port@generation)',
          explanation:
            'A silo is one host in the cluster. It runs grain activations, owns a slice ' +
            'of the grain directory, keeps a cache of where other grains live, watches a ' +
            'few ring neighbours, and acts as a gateway for clients. Every borough does ' +
            'all of that at once — there are no special silos in Orleans, and no master.',
          knobs: [KNOBS.iAmAlivePublish, COUNTS.numProbedSilos],
        };
      }

      case 'townhall': {
        const suspected = state.silos.filter((s) => s.suspicionVotes > 0);
        const dead = state.silos.filter((s) => s.status === 'Dead');
        return {
          title: 'Town Hall',
          subtitle: 'The cluster membership table',
          accent: '#9fb0c4',
          facts: [
            ['Silos on the roll', String(state.silos.length)],
            ['Active', String(state.silos.filter((s) => s.status === 'Active').length)],
            ['Dead', String(dead.length)],
            [
              'Under suspicion',
              suspected.length
                ? suspected.map((s) => `${s.address} (${s.suspicionVotes}/${s.votesRequired})`).join(', ')
                : 'none',
            ],
            ['Probes sent', String(state.stats.probesSent)],
            ['Probes missed', String(state.stats.probesMissed)],
            ['Silos declared dead', String(state.stats.silosDeclaredDead)],
          ],
          orleansType:
            'Orleans.IMembershipTable (Azure Table / ADO.NET / Consul / ZooKeeper)',
          explanation:
            'Shared storage every silo can read and write — not a silo itself, and not a ' +
            'coordinator. Orleans has no master and no leader election. Silos stamp their ' +
            'own rows to say they are alive, and file suspicion votes against peers that ' +
            'stop answering pings. Once enough INDEPENDENT silos have voted, the suspect ' +
            'is declared dead. That quorum is what stops one silo with a broken network ' +
            'card from evicting the entire cluster one peer at a time. Note the pings ' +
            'themselves never come here: detection is peer-to-peer, and this is only ' +
            'where the conclusion gets recorded.',
          knobs: [
            COUNTS.numVotesForDeathDeclaration,
            COUNTS.numMissedProbesLimit,
            KNOBS.probeInterval,
            KNOBS.deathVoteExpiration,
          ],
        };
      }

      case 'directory': {
        const silo = state.silos.find((s) => s.address === target.address);
        if (!silo) return undefined;
        const arcs = state.ring.filter((a) => a.silo === target.address);
        return {
          title: 'Land registry',
          subtitle: `Directory partition owned by ${silo.address}`,
          accent: '#c9a227',
          facts: [
            ['Registrations held', String(silo.directoryEntryCount)],
            ['Ring arcs owned', String(arcs.length)],
            [
              'Arc coverage',
              arcs.map((a) => `${a.start.toFixed(3)}→${a.end.toFixed(3)}`).join('  '),
            ],
          ],
          orleansType: 'Orleans.GrainDirectory.IGrainDirectory · GrainAddress',
          explanation:
            'The authoritative record of which activation currently serves a grain, ' +
            'sharded across silos by the ring. Registration is first-writer-wins: when ' +
            'two silos race to create the same grain, only one registration is recorded ' +
            'and the loser destroys its activation. That single rule is what makes a ' +
            'grain a singleton across the whole cluster. Note this is NOT where the ' +
            'grain runs — the partition owner and the host are usually different silos.',
          knobs: [],
        };
      }

      case 'activation': {
        const activation = state.activations.find(
          (a) => a.address.silo === target.silo && a.address.grainId === target.grainId,
        );
        if (!activation) return undefined;
        const host = state.silos.find((s) => s.address === target.silo);
        const idleFor = activation.queueDepth === 0 && !activation.executing
          ? `${((state.now - activation.lastUsedAt) / 1000).toFixed(1)}s`
          : 'in use';
        const type = GRAIN_TYPES[activation.grainType];

        const facts: Array<readonly [string, string]> = [
          ['State', activation.state],
          ['Concurrency', activation.reentrant ? '[Reentrant]' : 'one turn at a time'],
          ['Executing a turn', activation.executing ? 'yes' : 'no'],
          ['Requests queued', String(activation.queueDepth)],
          ['Turns completed', String(activation.turnsCompleted)],
          ['Idle for', idleFor],
        ];
        if (activation.blockedOn) {
          facts.push(['Blocked waiting on', activation.blockedOn]);
        }
        if (activation.collectible) {
          facts.push(['Collector', 'idle past the age limit — due on the next sweep']);
        }
        if (activation.persistent) {
          facts.push(['State version', String(activation.storageVersion)]);
          facts.push(['Writes', String(activation.storageWrites)]);
          if (activation.storageConflicts > 0) {
            facts.push(['ETag conflicts', String(activation.storageConflicts)]);
          }
        }

        let explanation =
          'A grain always exists conceptually; this building is its activation — the ' +
          'in-memory instance, which exists only while the grain is in use. ' +
          (activation.reentrant
            ? 'This one is [Reentrant], so it admits another turn while an earlier turn ' +
              'is awaiting something. That is what lets it take part in a call cycle ' +
              'without deadlocking.'
            : 'It processes exactly one request at a time, so everything queued is ' +
              'waiting on the request currently inside. No locks are involved anywhere: ' +
              'the scheduler simply never runs two turns on one activation at once.');
        if (activation.blockedOn) {
          explanation +=
            ` Right now it is occupied but doing nothing — waiting on ${activation.blockedOn}. ` +
            'The activation is not released during that wait, which is exactly how a ' +
            'call cycle between two non-reentrant grains deadlocks.';
        }
        if (type) explanation += ` (${type.description})`;

        const knobs: Setting[] = [KNOBS.turnDuration, KNOBS.activationDuration, KNOBS.collectionAgeLimit];
        if (activation.persistent) knobs.push(KNOBS.storageLatency);

        return {
          title: activation.address.grainId,
          subtitle: `Activation ${activation.address.activationId} on ${target.silo}`,
          accent: siloColorCss(host?.index ?? 0),
          facts,
          orleansType: 'Orleans.Grain · IGrainContext · GrainId (type/key)',
          explanation,
          knobs,
        };
      }

      case 'vault': {
        const persistent = state.activations.filter((a) => a.persistent);
        return {
          title: 'The Vault',
          subtitle: 'Grain storage',
          accent: '#4fd1c5',
          facts: [
            ['Grains with stored state', String(state.vault.grainCount)],
            ['Total versions written', String(state.vault.totalVersions)],
            ['ETag conflicts', String(state.vault.conflicts)],
            ['Persistent grains active', String(persistent.length)],
            ['Reads', String(state.stats.storageReads)],
            ['Writes', String(state.stats.storageWrites)],
          ],
          orleansType: 'Orleans.Runtime.IGrainStorage · IPersistentState<T>',
          explanation:
            'Orleans does NOT persist grain state for you. This is the single most ' +
            'common surprise about the virtual actor model: an activation is memory, ' +
            'and when it goes away — collected, or taken down with its silo — anything ' +
            'it did not explicitly write is gone. A grain opts in by declaring ' +
            'IPersistentState<T> and calling WriteStateAsync. Reading is part of ' +
            'activation, which is why persistent grains take visibly longer to come up. ' +
            'Writes carry an ETag: if storage has moved on since the writer read it, the ' +
            'write is rejected rather than applied, so a stale activation cannot ' +
            'overwrite a newer one.',
          knobs: [KNOBS.storageLatency],
        };
      }

      case 'clocktower': {
        const next = state.reminders.length
          ? state.reminders.reduce((soonest, r) => (r.nextFireAt < soonest.nextFireAt ? r : soonest))
          : undefined;
        return {
          title: 'Clock Tower',
          subtitle: 'Durable reminders',
          accent: '#ffd166',
          facts: [
            ['Registered reminders', String(state.reminders.length)],
            ['Total firings', String(state.stats.remindersFired)],
            ['Next reminder', next ? next.grainId : '—'],
            [
              'Fires in',
              next ? `${Math.max(0, (next.nextFireAt - state.now) / 1000).toFixed(1)}s` : '—',
            ],
          ],
          orleansType: 'Orleans.IGrainReminder · IRemindable.ReceiveReminder',
          explanation:
            'Reminders are durable and live outside the cluster, so they survive both ' +
            'deactivation and silo failure — and delivering one ACTIVATES the target ' +
            'grain. That is the whole difference from a timer: a timer is in-memory, ' +
            'dies with its activation, and cannot wake a grain that is not running. If ' +
            'you need something to happen whether or not anyone is calling the grain, ' +
            'it has to be a reminder.',
          knobs: [KNOBS.reminderPeriod],
        };
      }

      case 'pullingagent': {
        const silo = state.silos.find((s) => s.address === target.silo);
        const mine = state.streams.filter((s) => s.agentSilo === target.silo);
        return {
          title: 'Pumping station',
          subtitle: `Stream pulling agent on ${target.silo}`,
          accent: '#6ad4ff',
          facts: [
            ['Streams serviced', String(mine.length)],
            ['Stream ids', mine.length ? mine.map((s) => s.id).join(', ') : '—'],
            ['Events published', String(mine.reduce((n, s) => n + s.published, 0))],
            ['Events delivered', String(mine.reduce((n, s) => n + s.delivered, 0))],
            ['Host status', silo?.status ?? 'unknown'],
          ],
          orleansType: 'Orleans.Streams.IStreamProvider · pulling agent · PubSubRendezvousGrain',
          explanation:
            'A stream is not a pipe between two grains. Producers publish to a stream id, ' +
            'subscribers register interest in that id, and neither knows the other exists. ' +
            'Some silo’s pulling agent is responsible for draining the stream to its ' +
            'subscribers — chosen by hashing the stream id, so neither the producer nor ' +
            'the consumer picked it. Delivery is an ordinary grain call, which means a ' +
            'subscriber that has been deactivated is simply reactivated to receive.',
          knobs: [KNOBS.streamPublishInterval],
        };
      }

      case 'ring': {
        const director = directorFor(placement);
        return {
          title: 'The ring road',
          subtitle: 'Consistent hash ring',
          accent: '#8b9bb0',
          facts: [
            ['Arcs', String(state.ring.length)],
            ['Participating silos', String(state.silos.filter((s) => s.status === 'Active').length)],
            ['Current placement strategy', `${director.label} ${director.attribute}`],
          ],
          orleansType: 'Orleans.Runtime.ConsistentRingProvider',
          explanation:
            'Every grain id hashes to a point on this ring, and the silo owning the arc ' +
            'clockwise of that point is its directory partition owner. Losing a silo only ' +
            'disturbs the arcs next to it rather than reshuffling the whole directory — ' +
            'that property is the entire reason for using a ring instead of a modulo.',
          knobs: [],
        };
      }

      case 'message': {
        const message = state.inFlight.find((m) => m.id === target.id);
        if (!message) {
          return {
            title: 'Delivered',
            subtitle: 'This message has already arrived',
            accent: '#5f708a',
            facts: [],
            orleansType: '—',
            explanation:
              'Messages are only inspectable while they are on the road. Pause the ' +
              'simulation to hold one still, or slow the speed control down.',
            knobs: [],
          };
        }

        const describeNode = (node: typeof message.from): string => {
          switch (node.kind) {
            case 'client':
              return 'client';
            case 'silo':
              return node.silo;
            case 'directory':
              return `registry on ${node.silo}`;
            case 'activation':
              return `${node.grainId} on ${node.silo}`;
            case 'townhall':
              return 'Town Hall';
            case 'vault':
              return 'the Vault';
            case 'clocktower':
              return 'Clock Tower';
            case 'pullingagent':
              return `pulling agent on ${node.silo}`;
          }
        };

        const colour = MESSAGE_COLORS[message.kind] ?? 0xffffff;
        return {
          title: MESSAGE_LABELS[message.kind] ?? message.kind,
          subtitle: message.kind,
          accent: `#${colour.toString(16).padStart(6, '0')}`,
          facts: [
            ['From', describeNode(message.from)],
            ['To', describeNode(message.to)],
            ['Grain', message.grainId ?? '—'],
            ['Progress', `${Math.round(message.progress * 100)}%`],
          ],
          orleansType: 'Orleans.Runtime.Message',
          explanation:
            'One hop of one request. Following a single vehicle from the client sky ' +
            'through the registry, the zoning board and back is the fastest way to ' +
            'understand what a grain call actually costs. Pause to hold it still.',
          knobs: [KNOBS.networkHop],
        };
      }

      case 'client':
        return {
          title: 'Client',
          subtitle: 'Outside the cluster, calling in',
          accent: '#d8e2ef',
          facts: [
            ['Requests started', String(state.stats.requestsStarted)],
            ['Requests completed', String(state.stats.requestsCompleted)],
            ['Gateway cache hits', String(state.stats.cacheHits)],
            ['Gateway cache misses', String(state.stats.cacheMisses)],
          ],
          orleansType: 'Orleans.IClusterClient · IGrainFactory.GetGrain<T>(key)',
          explanation:
            'Clients hold grain references, not grain instances. Getting a reference is ' +
            'free and involves no network call at all — nothing is activated until you ' +
            'actually invoke a method on it. Calls enter through a silo acting as a ' +
            'gateway, which is where the address cache that shortcuts the directory lives.',
          knobs: [KNOBS.requestTimeout],
        };
    }
  }
}
