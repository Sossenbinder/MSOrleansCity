// The guided tour.
//
// A chaptered walkthrough that flies the camera to each district and explains
// what it is for. This is the path for someone who has never seen the city
// before and does not yet know what is worth clicking.
//
// Each chapter can also poke the simulation, so the thing being described is
// happening while it is described.

import { Vector3 } from 'three';
import type { Cluster } from '../sim/cluster';
import { LAYOUT, boroughCenter, ringPoint } from '../world/layout';

export interface Chapter {
  readonly title: string;
  readonly body: string;
  /** Where the camera goes, and what it looks at. */
  readonly camera: { readonly position: Vector3; readonly target: Vector3 };
  /** Optional simulation nudge so the chapter has something to show. */
  readonly enact?: (cluster: Cluster) => void;
}

export function buildChapters(siloCount: number): Chapter[] {
  const borough0 = boroughCenter(0, siloCount);

  return [
    {
      title: 'Welcome to the cluster',
      body:
        'Every building here is a real mechanism of the Orleans runtime, driven by a ' +
        'model of the actual algorithms — not an animation. Timings are slowed by ' +
        'orders of magnitude so you can follow a single request with your eyes.',
      camera: { position: new Vector3(0, 110, 130), target: new Vector3(0, 0, 0) },
    },
    {
      title: 'Boroughs are silos',
      body:
        'Each raised block is one silo — one host in the cluster. It runs grain ' +
        'activations, owns a slice of the grain directory, caches where other grains ' +
        'live, watches a few neighbours, and acts as a gateway for clients. Every silo ' +
        'does all of that. There is no master and no special node.',
      camera: {
        position: new Vector3(borough0.x + 26, 34, borough0.z + 30),
        target: borough0.clone(),
      },
    },
    {
      title: 'Buildings are activations',
      body:
        'A grain always exists conceptually. The building is its ACTIVATION — the ' +
        'in-memory instance, which exists only while the grain is in use. Call a grain ' +
        'that is nowhere and one is built on demand. That is what "virtual actor" means.',
      camera: {
        position: new Vector3(borough0.x + 16, 22, borough0.z + 18),
        target: borough0.clone(),
      },
      enact: (cluster) => cluster.callGrain('user/42'),
    },
    {
      title: 'One turn at a time',
      body:
        'An activation processes exactly one request at a time. Not one per core — one. ' +
        'Watch the building grow as calls queue outside its door. No grain code ever ' +
        'needs a lock, because the scheduler never runs two turns on it concurrently.',
      camera: {
        position: new Vector3(borough0.x + 14, 18, borough0.z + 16),
        target: borough0.clone(),
      },
      enact: (cluster) => {
        for (let i = 0; i < 10; i++) cluster.callGrain('user/42');
      },
    },
    {
      title: 'The ring road',
      body:
        'Every grain id hashes to a point on this ring, and the silo owning the arc ' +
        'clockwise of it is that grain’s directory partition owner. Losing a silo only ' +
        'disturbs the arcs beside it instead of reshuffling the whole directory — that ' +
        'property is the entire reason for a ring rather than a modulo.',
      camera: { position: new Vector3(0, 96, 118), target: new Vector3(0, 0, 0) },
    },
    {
      title: 'The land registry',
      body:
        'The amber towers hold directory partitions: the authoritative record of which ' +
        'activation serves a grain. Registration is first-writer-wins, and that single ' +
        'rule is what makes a grain a singleton across the whole cluster. Note the ' +
        'partition owner and the silo actually hosting the grain are usually different.',
      camera: {
        position: ringPoint(0.12, 40).multiplyScalar(0.8),
        target: new Vector3(0, 4, 0),
      },
    },
    {
      title: 'Town Hall',
      body:
        'Shared storage every silo reads and writes — not a coordinator. Silos stamp ' +
        'their own rows to say they are alive and file suspicion votes against peers ' +
        'that stop answering pings. Enough independent votes declares a silo dead. The ' +
        'pings themselves never come here: detection is peer-to-peer.',
      camera: {
        position: new Vector3(2, 26, LAYOUT.townHall.z + 34),
        target: LAYOUT.townHall.clone().setY(5),
      },
    },
    {
      title: 'The Vault',
      body:
        'Orleans does NOT persist grain state for you. An activation is memory; when it ' +
        'goes away, anything not explicitly written is gone. A grain opts in with ' +
        'IPersistentState, reads on activation, and writes under an ETag so a stale ' +
        'activation cannot overwrite a newer one.',
      camera: { position: new Vector3(0, 30, 42), target: new Vector3(0, -8, 0) },
      enact: (cluster) => {
        cluster.callGrain('account/1');
        cluster.callGrain('account/2');
      },
    },
    {
      title: 'The Clock Tower',
      body:
        'Reminders are durable, live outside the cluster, survive silo failure, and ' +
        'ACTIVATE the grain in order to deliver. A timer can do none of that — it dies ' +
        'with its activation. If something must happen whether or not anyone is calling ' +
        'the grain, it has to be a reminder.',
      camera: {
        position: new Vector3(LAYOUT.clockTower.x + 34, 40, LAYOUT.clockTower.z + 16),
        target: LAYOUT.clockTower.clone().setY(14),
      },
      enact: (cluster) => cluster.callGrain('ledger/1'),
    },
    {
      title: 'The Canals',
      body:
        'A stream is not a pipe between two grains. Producers publish to a stream id and ' +
        'subscribers register interest; neither knows the other. A pulling agent — ' +
        'chosen by hashing the stream id — drains the stream to subscribers, reactivating ' +
        'any that are not running.',
      camera: { position: new Vector3(-40, 40, 46), target: new Vector3(0, 2, 0) },
      enact: (cluster) => cluster.createStream('orders', 'user/1', ['feed/1', 'feed/2']),
    },
    {
      title: 'When a silo dies',
      body:
        'Kill a borough from the panel on the left. It goes dark instantly, but the ' +
        'cluster keeps routing to it until probes miss, votes accumulate and quorum is ' +
        'reached. Then the ring closes over its arc, and the grains it held come back ' +
        'elsewhere — fresh, with nothing recovered that was not written down.',
      camera: { position: new Vector3(0, 104, 124), target: new Vector3(0, 0, 0) },
    },
  ];
}

export class Tour {
  private readonly root: HTMLDivElement;
  private chapters: Chapter[] = [];
  private index = 0;
  private active = false;

  constructor(
    parent: HTMLElement,
    private readonly onGoTo: (chapter: Chapter) => void,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'panel tour hidden';
    parent.appendChild(this.root);
  }

  get isActive(): boolean {
    return this.active;
  }

  start(chapters: Chapter[]): void {
    this.chapters = chapters;
    this.index = 0;
    this.active = true;
    this.root.classList.remove('hidden');
    this.show();
  }

  stop(): void {
    this.active = false;
    this.root.classList.add('hidden');
  }

  next(): void {
    if (this.index >= this.chapters.length - 1) {
      this.stop();
      return;
    }
    this.index++;
    this.show();
  }

  previous(): void {
    if (this.index === 0) return;
    this.index--;
    this.show();
  }

  private show(): void {
    const chapter = this.chapters[this.index];
    if (!chapter) return;
    this.onGoTo(chapter);

    this.root.innerHTML = `
      <div class="tour-progress">${this.index + 1} / ${this.chapters.length}</div>
      <h2>${escapeHtml(chapter.title)}</h2>
      <p>${escapeHtml(chapter.body)}</p>
      <div class="tour-actions">
        <button type="button" data-tour="prev"${this.index === 0 ? ' disabled' : ''}>Back</button>
        <button type="button" class="primary" data-tour="next">${
          this.index === this.chapters.length - 1 ? 'Finish' : 'Next'
        }</button>
        <button type="button" data-tour="exit">Exit tour</button>
      </div>
    `;

    this.root.querySelector('[data-tour="prev"]')?.addEventListener('click', () => this.previous());
    this.root.querySelector('[data-tour="next"]')?.addEventListener('click', () => this.next());
    this.root.querySelector('[data-tour="exit"]')?.addEventListener('click', () => this.stop());
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
