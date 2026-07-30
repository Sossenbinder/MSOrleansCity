// The activity feed — what the cluster just did, in words.
//
// Counters tell you a directory miss happened 84 times. They cannot tell you
// that THIS call missed, went to that partition, got placed over there and
// then queued behind two other requests. The feed is the causal narration the
// numbers can't carry, and it is where a viewer learns the vocabulary that the
// inspector then explains in depth.
//
// Routine chatter (probes, heartbeats, every individual message hop) is hidden
// by default. At six calls a second it would bury everything that matters.

import type { SimEvent, SimEventType } from '../sim/types';

interface Line {
  readonly at: number;
  readonly text: string;
  readonly tone: 'normal' | 'good' | 'warn' | 'bad' | 'dim';
}

const MAX_LINES = 240;
const RENDER_LINES = 40;

/** Per-message and per-probe events: correct, but far too noisy by default. */
const VERBOSE_ONLY: ReadonlySet<SimEventType> = new Set<SimEventType>([
  'message-sent',
  'message-delivered',
  'probe-missed',
  'request-enqueued',
  'turn-started',
  'cache-hit',
  'cache-miss',
  'directory-hit',
  'ring-rebuilt',
  'storage-read',
]);

function shortSilo(address: string): string {
  return address.split(':')[0] ?? address;
}

/** Turns one event into a line of narration, or null to drop it. */
function describe(event: SimEvent): Line | null {
  switch (event.type) {
    case 'request-started':
      return { at: event.at, tone: 'dim', text: `call → ${event.grainId}` };
    case 'request-completed':
      return {
        at: event.at,
        tone: 'good',
        text: `${event.grainId} answered in ${(event.latency / 1000).toFixed(1)}s`,
      };
    case 'request-timed-out':
      return { at: event.at, tone: 'bad', text: `${event.grainId} timed out — no answer` };

    case 'cache-hit':
      return { at: event.at, tone: 'dim', text: `${shortSilo(event.silo)} had ${event.grainId} cached` };
    case 'cache-miss':
      return { at: event.at, tone: 'dim', text: `${shortSilo(event.silo)} cache miss on ${event.grainId}` };
    case 'cache-invalidated':
      return {
        at: event.at,
        tone: 'warn',
        text: `${shortSilo(event.silo)} dropped stale address for ${event.grainId}`,
      };

    case 'directory-hit':
      return { at: event.at, tone: 'dim', text: `registry knows ${event.grainId}` };
    case 'directory-miss':
      return {
        at: event.at,
        tone: 'normal',
        text: `registry has no ${event.grainId} — it must be built`,
      };
    case 'placement-decided':
      return {
        at: event.at,
        tone: 'normal',
        text: `zoning put ${event.grainId} on ${shortSilo(event.target)} (${event.strategy})`,
      };

    case 'activation-registered':
      return {
        at: event.at,
        tone: 'normal',
        text: `${event.address.grainId} claimed the registry`,
      };
    case 'activation-valid':
      return { at: event.at, tone: 'good', text: `${event.address.grainId} is up` };
    case 'activation-ended':
      switch (event.reason) {
        case 'collected':
          return {
            at: event.at,
            tone: 'dim',
            text: `${event.address.grainId} collected — idle too long`,
          };
        case 'lost-registration-race':
          return {
            at: event.at,
            tone: 'warn',
            text: `${event.address.grainId} lost the race, demolished`,
          };
        case 'silo-died':
          return {
            at: event.at,
            tone: 'bad',
            text: `${event.address.grainId} lost with ${shortSilo(event.address.silo)}`,
          };
      }
      return null;

    case 'turn-completed':
      return { at: event.at, tone: 'dim', text: `${event.address.grainId} finished a turn` };
    case 'request-enqueued':
      return {
        at: event.at,
        tone: 'dim',
        text: `${event.address.grainId} queue depth ${event.queueDepth}`,
      };

    case 'rejected':
      return {
        at: event.at,
        tone: 'warn',
        text: `${shortSilo(event.silo)} rejected a call for ${event.grainId} (${event.reason})`,
      };

    case 'grain-called-grain':
      return {
        at: event.at,
        tone: 'normal',
        text: `${event.caller.grainId} is now waiting on ${event.callee}`,
      };
    case 'deadlock-detected':
      return {
        at: event.at,
        tone: 'bad',
        text: `DEADLOCK: ${event.cycle.join(' → ')} → ${event.cycle[0] ?? ''}`,
      };

    case 'probe-missed':
      return {
        at: event.at,
        tone: 'warn',
        text: `${shortSilo(event.prober)} missed ${event.consecutive} pings to ${shortSilo(event.target)}`,
      };
    case 'suspicion-voted':
      return {
        at: event.at,
        tone: 'warn',
        text: `${shortSilo(event.voter)} votes ${shortSilo(event.suspect)} dead (${event.votes}/${event.required})`,
      };
    case 'silo-declared-dead':
      return {
        at: event.at,
        tone: 'bad',
        text: `${shortSilo(event.silo)} DECLARED DEAD by ${event.votes} votes`,
      };
    case 'directory-partition-lost':
      return {
        at: event.at,
        tone: 'bad',
        text: `${event.entries} registrations lost with ${shortSilo(event.silo)}`,
      };
    case 'silo-status-changed':
      return {
        at: event.at,
        tone: 'warn',
        text: `${shortSilo(event.silo)} ${event.from} → ${event.to}`,
      };

    case 'collection-swept':
      return event.collected > 0
        ? {
            at: event.at,
            tone: 'dim',
            text: `collector swept ${event.examined}, took ${event.collected}`,
          }
        : null;

    case 'storage-written':
      return {
        at: event.at,
        tone: 'dim',
        text: `${event.address.grainId} wrote state v${event.version}`,
      };
    case 'storage-conflict':
      return {
        at: event.at,
        tone: 'bad',
        text: `${event.address.grainId} write REJECTED — stale ETag`,
      };
    case 'storage-read':
      return { at: event.at, tone: 'dim', text: `${event.address.grainId} loaded state` };

    case 'reminder-fired':
      return {
        at: event.at,
        tone: 'normal',
        text: `reminder fired for ${event.grainId} — waking it up`,
      };
    case 'stream-published':
      return { at: event.at, tone: 'dim', text: `stream ${event.streamId} published #${event.sequence}` };
    case 'stream-delivered':
      return { at: event.at, tone: 'dim', text: `${event.subscriber} received a stream event` };

    default:
      return null;
  }
}

export class EventLog {
  private readonly root: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private lines: Line[] = [];
  private verbose = false;
  private dirty = true;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'panel eventlog';

    const header = document.createElement('div');
    header.className = 'eventlog-header';

    const title = document.createElement('span');
    title.textContent = 'Activity';

    const verboseToggle = document.createElement('button');
    verboseToggle.type = 'button';
    verboseToggle.className = 'tiny';
    verboseToggle.textContent = 'verbose';
    verboseToggle.addEventListener('click', () => {
      this.verbose = !this.verbose;
      verboseToggle.classList.toggle('on', this.verbose);
      this.dirty = true;
    });

    header.append(title, verboseToggle);

    this.body = document.createElement('div');
    this.body.className = 'eventlog-body';

    this.root.append(header, this.body);
    parent.appendChild(this.root);
  }

  push(event: SimEvent): void {
    if (!this.verbose && VERBOSE_ONLY.has(event.type)) return;
    const line = describe(event);
    if (!line) return;

    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines = this.lines.slice(-MAX_LINES);
    this.dirty = true;
  }

  clear(): void {
    this.lines = [];
    this.dirty = true;
  }

  /** Rendered once per frame, and only when something actually changed. */
  render(): void {
    if (!this.dirty) return;
    this.dirty = false;

    const shown = this.lines.slice(-RENDER_LINES);
    this.body.innerHTML = shown
      .map(
        (line) =>
          `<div class="ev ev-${line.tone}"><span class="t">${(line.at / 1000).toFixed(1)}s</span>${escapeHtml(
            line.text,
          )}</div>`,
      )
      .join('');
    this.body.scrollTop = this.body.scrollHeight;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
