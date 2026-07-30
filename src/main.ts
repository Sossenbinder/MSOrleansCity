// Entry point — wires sim, world, engine and ui together.
//
// This is the only place that converts wall-clock time into simulated time.
// Everything downstream reads a snapshot; nothing downstream advances the
// clock. Keeping that conversion in one function is what makes pause, speed
// control, scenarios and the tour trivial rather than a coordination problem.

import { Flows, Picker, Renderer } from './engine';
import { Cluster, DEFAULT_CONFIG, type PlacementStrategyId } from './sim';
import { ScenarioRunner, scenarioById } from './sim/scenarios';
import { Workload, type KeyDistribution } from './sim/workload';
import { Controls, EventLog, Inspector, Tour, buildChapters } from './ui';
import { City } from './world';

const canvas = document.querySelector<HTMLCanvasElement>('#city');
const uiRoot = document.querySelector<HTMLElement>('#ui');

if (!canvas) throw new Error('main.ts: expected <canvas id="city"> in index.html');
if (!uiRoot) throw new Error('main.ts: expected <div id="ui"> in index.html');

// Five silos rather than three: enough boroughs for ring arcs, probe
// neighbours and placement spread to be legible without the plaza feeling bare.
const cluster = new Cluster({ ...DEFAULT_CONFIG, siloCount: 5 });
const city = new City(cluster.snapshot());
const renderer = new Renderer(canvas);
const flows = new Flows({
  indexOf: (silo) => city.indexOf(silo),
  siloCount: cluster.siloAddresses().length,
  slotOf: (silo, grainId) => city.buildings.slotOf(silo, grainId),
});

renderer.add(city.group);
renderer.add(flows.group);

let speed = 1;
let paused = false;
let trafficOn = true;

const workload = new Workload();
const scenarios = new ScenarioRunner();

const inspector = new Inspector(uiRoot);
const eventLog = new EventLog(uiRoot);
cluster.events.on((event) => eventLog.push(event));

const tour = new Tour(uiRoot, (chapter) => {
  renderer.flyTo(chapter.camera.position, chapter.camera.target);
  chapter.enact?.(cluster);
});

const controls = new Controls(uiRoot, {
  onCall: (grainId) => cluster.callGrain(grainId),
  onSpeed: (multiplier) => {
    speed = multiplier;
  },
  onPause: (value) => {
    paused = value;
  },
  onPlacement: (strategy: PlacementStrategyId) => cluster.setPlacement(strategy),
  onKillSilo: (address) => cluster.killSilo(address),
  onTraffic: (enabled) => {
    trafficOn = enabled;
    if (!enabled) workload.reset();
  },
  onDistribution: (distribution: KeyDistribution) => {
    workload.setOptions({ ...workload.settings, distribution });
  },
  onScenario: (id) => {
    const scenario = scenarioById(id);
    if (!scenario) return;
    tour.stop();
    scenarios.start(scenario, cluster.time);
    controls.setNote(scenario.title, scenario.watchFor);
  },
  onTour: () => {
    scenarios.stop();
    controls.setNote(undefined, undefined);
    tour.start(buildChapters(cluster.siloAddresses().length));
  },
  onLabels: (visible) => city.labels.setVisible(visible),
});

// Vehicles are pickable too, so any hop can be interrogated mid-route.
const picker = new Picker(canvas, renderer.camera, () => [
  ...flows.pickables(),
  ...city.pickables(),
]);
picker.onPick((picked) => inspector.select(picked));

// Something to look at on arrival: one cold call, so the first thing a visitor
// sees is a grain being activated rather than an empty plaza.
cluster.callGrain('user/42');

renderer.start((deltaMs) => {
  if (!paused) {
    const simDelta = deltaMs * speed;
    // A running scenario owns the traffic; background load would drown out the
    // thing it is trying to show.
    if (scenarios.active) {
      const note = scenarios.tick(cluster, cluster.time);
      if (note) controls.setNote(scenarios.active.title, note);
      if (scenarios.elapsed(cluster.time) > scenarios.active.durationMs) {
        scenarios.stop();
        controls.setNote(undefined, undefined);
      }
    } else if (trafficOn) {
      workload.tick(simDelta, (grainId) => cluster.callGrain(grainId));
    }
    cluster.tick(simDelta);
  }

  const state = cluster.snapshot();
  city.sync(state);
  flows.sync(state.inFlight);
  controls.render(state);
  inspector.render(state, cluster.placement);
  eventLog.render();
});
