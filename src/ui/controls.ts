// Controls, stats and the legend.
//
// The speed control has exactly one owner: it reports a multiplier, and
// main.ts is the only thing that converts wall-clock time into simulated time.
// Nothing here touches the simulation directly beyond the callbacks it is
// handed.

import { MESSAGE_COLORS, MESSAGE_LABELS, siloColorCss } from '../core/theme';
import { unverifiedSettings } from '../sim/config';
import { PLACEMENT_DIRECTORS, type PlacementStrategyId } from '../sim/placement';
import { SCENARIOS } from '../sim/scenarios';
import type { EnvelopeKind, SimState } from '../sim/types';
import type { KeyDistribution } from '../sim/workload';

export interface ControlHandlers {
  onCall(grainId: string): void;
  onSpeed(multiplier: number): void;
  onPause(paused: boolean): void;
  onPlacement(strategy: PlacementStrategyId): void;
  onKillSilo(address: string): void;
  onTraffic(enabled: boolean): void;
  onDistribution(distribution: KeyDistribution): void;
  onScenario(id: string): void;
  onTour(): void;
  onLabels(visible: boolean): void;
}

/** The hops worth showing in a legend — the rest share these colours. */
const LEGEND_KINDS: EnvelopeKind[] = [
  'client-request',
  'dir-lookup',
  'create-activation',
  'grain-response',
  'rejection',
];

export class Controls {
  private readonly stats: HTMLDivElement;
  private readonly siloList: HTMLDivElement;
  private note!: HTMLDivElement;
  private paused = false;
  private siloSignature = '';

  constructor(parent: HTMLElement, handlers: ControlHandlers) {
    const panel = document.createElement('div');
    panel.className = 'panel controls';

    const grainInput = document.createElement('input');
    grainInput.type = 'text';
    grainInput.value = 'user/42';
    grainInput.spellcheck = false;
    grainInput.setAttribute('aria-label', 'Grain id to call');

    const callButton = document.createElement('button');
    callButton.type = 'button';
    callButton.className = 'primary';
    callButton.textContent = 'Call grain';
    callButton.addEventListener('click', () => {
      const value = grainInput.value.trim();
      if (value) handlers.onCall(value);
    });
    grainInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') callButton.click();
    });

    const callRow = document.createElement('div');
    callRow.className = 'row';
    callRow.append(grainInput, callButton);

    const pauseButton = document.createElement('button');
    pauseButton.type = 'button';
    pauseButton.textContent = 'Pause';
    pauseButton.addEventListener('click', () => {
      this.paused = !this.paused;
      pauseButton.textContent = this.paused ? 'Resume' : 'Pause';
      handlers.onPause(this.paused);
    });

    const speed = document.createElement('input');
    speed.type = 'range';
    speed.min = '0.25';
    speed.max = '4';
    speed.step = '0.25';
    speed.value = '1';
    const speedLabel = document.createElement('span');
    speedLabel.className = 'speed-label';
    speedLabel.textContent = '1.00x';
    speed.addEventListener('input', () => {
      const multiplier = Number(speed.value);
      speedLabel.textContent = `${multiplier.toFixed(2)}x`;
      handlers.onSpeed(multiplier);
    });

    const speedRow = document.createElement('div');
    speedRow.className = 'row';
    speedRow.append(pauseButton, speed, speedLabel);

    const placement = document.createElement('select');
    placement.setAttribute('aria-label', 'Placement strategy');
    for (const director of Object.values(PLACEMENT_DIRECTORS)) {
      const option = document.createElement('option');
      option.value = director.id;
      option.textContent = `${director.label}  ${director.attribute}`;
      placement.appendChild(option);
    }
    placement.addEventListener('change', () => {
      handlers.onPlacement(placement.value as PlacementStrategyId);
    });

    const placementRow = document.createElement('div');
    placementRow.className = 'row';
    const placementLabel = document.createElement('label');
    placementLabel.textContent = 'Zoning';
    placementRow.append(placementLabel, placement);

    const traffic = document.createElement('input');
    traffic.type = 'checkbox';
    traffic.id = 'traffic-toggle';
    // Must match main.ts's initial trafficOn, or the box lies about the state.
    traffic.checked = true;
    traffic.addEventListener('change', () => handlers.onTraffic(traffic.checked));
    const trafficLabel = document.createElement('label');
    trafficLabel.htmlFor = 'traffic-toggle';
    trafficLabel.textContent = 'Traffic';

    const distribution = document.createElement('select');
    distribution.setAttribute('aria-label', 'Key distribution');
    for (const [value, label] of [
      ['uniform', 'Uniform keys'],
      ['zipf', 'Hot keys (zipf)'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      distribution.appendChild(option);
    }
    distribution.addEventListener('change', () => {
      handlers.onDistribution(distribution.value as KeyDistribution);
    });

    const trafficRow = document.createElement('div');
    trafficRow.className = 'row';
    trafficRow.append(trafficLabel, traffic, distribution);

    this.stats = document.createElement('div');
    this.stats.className = 'stats';

    this.siloList = document.createElement('div');
    this.siloList.className = 'silos';
    // Delegated: the silo list is re-rendered whenever membership changes, so
    // handlers bound to individual buttons would not survive.
    this.siloList.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-kill]');
      const address = button?.dataset['kill'];
      if (address) handlers.onKillSilo(address);
    });

    const legend = document.createElement('div');
    legend.className = 'legend';
    for (const kind of LEGEND_KINDS) {
      const item = document.createElement('div');
      item.className = 'legend-item';
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = `#${(MESSAGE_COLORS[kind] ?? 0xffffff).toString(16).padStart(6, '0')}`;
      const text = document.createElement('span');
      text.textContent = MESSAGE_LABELS[kind] ?? kind;
      item.append(swatch, text);
      legend.appendChild(item);
    }

    // Scenarios: the fastest route from "what am I looking at" to seeing one
    // mechanism do something unmistakable.
    const scenarios = document.createElement('div');
    scenarios.className = 'scenarios';
    scenarios.innerHTML = `<div class="section-label">Scenarios</div>`;
    for (const scenario of SCENARIOS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'scenario';
      button.dataset['scenario'] = scenario.id;
      button.innerHTML = `<b>${scenario.title}</b><span>${scenario.teaches}</span>`;
      button.addEventListener('click', () => handlers.onScenario(scenario.id));
      scenarios.appendChild(button);
    }

    const tourButton = document.createElement('button');
    tourButton.type = 'button';
    tourButton.className = 'primary wide';
    tourButton.textContent = 'Take the guided tour';
    tourButton.addEventListener('click', () => handlers.onTour());

    const labels = document.createElement('input');
    labels.type = 'checkbox';
    labels.id = 'labels-toggle';
    labels.checked = true;
    labels.addEventListener('change', () => handlers.onLabels(labels.checked));
    const labelsLabel = document.createElement('label');
    labelsLabel.htmlFor = 'labels-toggle';
    labelsLabel.textContent = 'Labels';

    const labelsRow = document.createElement('div');
    labelsRow.className = 'row';
    labelsRow.append(labelsLabel, labels);

    const title = document.createElement('h1');
    title.textContent = 'MSOrleansCity';
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Drag to orbit, scroll to zoom, click anything to inspect it.';

    // Stated up front rather than buried: the pacing on screen is ours, and
    // the real Orleans defaults have not been checked against source yet
    // (outline: Accuracy discipline). Better an honest caveat than a viewer
    // who leaves believing our timings are Orleans' timings.
    const unverified = unverifiedSettings().length;
    const caveat = document.createElement('p');
    caveat.className = 'caveat';
    caveat.textContent = unverified
      ? `Model, not an emulator. Timings are slowed for watchability; ${unverified} real Orleans defaults are still unverified against source.`
      : 'Model, not an emulator. Timings are slowed for watchability.';

    this.note = document.createElement('div');
    this.note.className = 'note hidden';

    panel.append(
      title,
      hint,
      caveat,
      tourButton,
      scenarios,
      this.note,
      callRow,
      speedRow,
      trafficRow,
      placementRow,
      labelsRow,
      this.stats,
      this.siloList,
      legend,
    );
    parent.appendChild(panel);
  }

  /** Shows what the running scenario is doing, or clears it. */
  setNote(title: string | undefined, body: string | undefined): void {
    if (!title) {
      this.note.classList.add('hidden');
      return;
    }
    this.note.classList.remove('hidden');
    this.note.innerHTML = `<b>${title}</b>${body ? `<span>${body}</span>` : ''}`;
  }

  render(state: SimState): void {
    const s = state.stats;
    const timedOut = s.requestsTimedOut > 0
      ? ` · <b class="bad">${s.requestsTimedOut}</b> timed out`
      : '';
    this.stats.innerHTML = `
      <div><b>${s.requestsCompleted}</b>/${s.requestsStarted} calls done${timedOut}</div>
      <div><b>${state.activations.length}</b> activations</div>
      <div><b>${state.inFlight.length}</b> messages in flight</div>
      <div>cache <b>${s.cacheHits}</b> hit / <b>${s.cacheMisses}</b> miss</div>
      <div>directory <b>${s.directoryHits}</b> hit / <b>${s.directoryMisses}</b> miss</div>
      <div>races lost <b>${s.registrationRacesLost}</b> · rejections <b>${s.rejections}</b></div>
      <div>probes <b>${s.probesSent}</b> sent / <b>${s.probesMissed}</b> missed</div>
      <div>collected <b>${s.activationsCollected}</b> · grain→grain <b>${s.grainToGrainCalls}</b></div>
      <div>storage <b>${s.storageWrites}</b> writes${s.storageConflicts ? ` · <b class="bad">${s.storageConflicts}</b> conflicts` : ''}</div>
      <div>reminders <b>${s.remindersFired}</b> · stream events <b>${s.streamEventsDelivered}</b></div>
      ${s.deadlockedActivations ? `<div class="bad">deadlocked: ${s.deadlockedActivations} activations</div>` : ''}
      <div class="clock">t = ${(state.now / 1000).toFixed(1)}s</div>
    `;

    // Only rebuild when something actually changed — the list holds buttons,
    // and replacing them every frame would make them impossible to click.
    const signature = state.silos
      .map((x) => `${x.address}:${x.status}:${x.crashed}:${x.suspicionVotes}:${x.activationCount}:${x.directoryEntryCount}`)
      .join('|');
    if (signature === this.siloSignature) return;
    this.siloSignature = signature;

    this.siloList.innerHTML = state.silos
      .map((silo) => {
        const dead = silo.status === 'Dead';
        const state_ = dead
          ? '<span class="bad">dead</span>'
          : silo.crashed
            ? '<span class="bad">crashed</span>'
            : silo.suspicionVotes > 0
              ? `<span class="warn">${silo.suspicionVotes}/${silo.votesRequired} votes</span>`
              : `${silo.activationCount}a · ${silo.directoryEntryCount}d`;
        return `
        <div class="silo-row${dead ? ' is-dead' : ''}">
          <span class="swatch" style="background:${siloColorCss(silo.index)}"></span>
          <span class="addr">${silo.address}</span>
          <span class="counts">${state_}</span>
          ${dead || silo.crashed ? '' : `<button class="kill" type="button" data-kill="${silo.address}" title="Crash this silo">kill</button>`}
        </div>`;
      })
      .join('');
  }
}
