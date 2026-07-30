# Outline: MSOrleansCity — an explorable 3D city that shows how Orleans actually works

## Context

`/home/stefan/Code/Personal/MSOrleansCity` is empty — fully greenfield. The goal is an Orleans equivalent of
[PGSimCity](https://nikolays.github.io/PGSimCity/): a static, browser-based 3D city where every building is a real
mechanism of the Orleans runtime, driven by a hand-built model of the actual algorithms rather than a cartoon.
Orleans' virtual-actor model is notoriously hard to teach from prose — single activation, turn-based concurrency, and
directory/membership interplay are all inherently spatial and temporal, which is exactly what a city can show.

## Scope

**In scope:**

- All four subsystem groups, delivered in phases (P0→P3): activation lifecycle + grain directory + turn-based scheduler;
  cluster membership + silo failure; placement strategies; persistence + reminders + streams.
- A pure-TypeScript simulation core implementing the real algorithms (consistent-hash ring, probe/suspicion-vote
  protocol, first-writer-wins directory registration, turn boundaries, activation collection) at slowed timescales.
- three.js city rendering, orbit/fly/walk cameras, click-to-inspect, scenario presets, guided tour.
- Headless Vitest suite asserting Orleans invariants (single activation, non-reentrancy, ring coverage, handoff).
- Static bundle deployable to GitHub Pages with no application server.

**Out of scope:**

- Running real Orleans code, or attaching to a live cluster's telemetry. This is a model, not an emulator.
- Orleans transactions, grain versioning / heterogeneous silos, custom serialization internals, Orleans Streams
  provider-specific machinery beyond a generic pulling agent.
- Multiplayer, persistence of user sessions, backend of any kind.

## Approach

**Stack.** TypeScript + three.js + Vite + Vitest. Static `dist/`, GitHub Pages, three.js as the only bundled runtime
dependency. Node 20+, WebGL2.

**Three structural rules** (lifted from the reference — they are why that codebase stayed coherent):

1. `world/layout.ts` is the single source of truth for every coordinate, anchor, and route in the city.
2. `sim/` never imports three.js; `world/` never mutates simulation state. They communicate through an immutable
   `SimState` snapshot plus a typed `SimEvent` bus. Enforced by an ESLint `no-restricted-imports` rule **and** a test.
3. Rendering is theme-aware — day and night convey meaning differently (night = state colors dominate).

```
src/
  core/    event bus, registry, themes, seeded RNG
  sim/     Orleans model — pure TS, deterministic, headless-testable
  world/   layout.ts + one module per district
  engine/  renderer, camera, flows, labels, picking
  ui/      controls, inspector, tour, search, scenarios, explanation cards
```

**Simulation modules** (`sim/`): `clock.ts` fixed-timestep tick with 0.1x–10x speed, pause and single-step ·
`ring.ts` consistent-hash ring + range ownership · `directory.ts` partitioned registry, first-writer-wins register,
local cache + invalidation-on-stale-forward, partition handoff · `placement.ts` Random / PreferLocal /
ActivationCountBased / HashBased / StatelessWorker directors · `activation.ts` state machine
(Creating→Activating→Valid→Deactivating→Invalid) + collection age · `scheduler.ts` per-activation queue, turn execution,
reentrancy rules, request timeout · `messaging.ts` router (local → cache → directory → placement, with rejection and
forwarding) · `membership.ts` table rows, statuses, IAmAlive, probes, suspicion votes, death declaration, gossip ·
`workload.ts` synthetic call generator (uniform / zipf / hot-key) · `scenarios.ts` preset scripts.

**City map** — cardinal layout, mirroring the reference's spatial discipline:

| Region                | Orleans mechanism                                                              |
| --------------------- | ------------------------------------------------------------------------------ |
| North sky + gates     | Clients, gateway connections                                                    |
| Central plaza blocks  | Silo boroughs (2–4), each with a stable hue; grain activations are its buildings |
| Encircling ring road  | Consistent-hash ring; arcs colored by owning silo = directory partitions         |
| Under the plaza       | The Vault — grain storage, ETag seals on deeds                                   |
| South                 | Town Hall (membership ledger) + patrol depot (probes, votes)                     |
| West                  | Maintenance yard — zoning board (placement), demolition crew (collection)        |
| East                  | Clock tower (reminders), canals + pumping stations (streams, pulling agents)     |

**Visual semantics.** Buildings inherit their host silo's hue, so a silo death literally shows color migrating across
the city as grains re-materialize. Message vehicles: white = request, green = response, red = rejection/stale-directory
redirect, amber = retry. Building state: lit = active idle, pulsing = executing a turn, queue markers on the pavement =
pending requests, greying = collection candidate, crumbling = deactivating. The revolving door is the scheduler — one
vehicle in at a time, unless `[Reentrant]` props it open.

**The inspector is the teaching surface.** Clicking anything shows three things: what you clicked → the Orleans
type/interface behind it → the configuration option that governs it (e.g. demolition crew → `ActivationCollector` →
`ActivationCollectionOptions.CollectionAgeLimit`). This is what turns a pretty visualization into a reference.

**Phasing.**

- **P0 — walkable skeleton, one flow end to end.** Scaffold, `layout.ts`, clock, ring, directory, Random +
  PreferLocal placement, activation lifecycle, scheduler, messaging, 3 silos, client sky, gateway, ring road, orbit
  camera, inspector. Deliverable: trigger a call to `user/42` and watch vehicle → directory miss → zoning → building
  rises → turn executes → response returns. Other districts are geometry with `TODO` behavior.
- **P1 — membership + failure.** Town Hall, patrol probes, suspicion votes, death declaration, directory handoff,
  re-activation elsewhere; scenario "kill silo 2".
- **P2 — pressure & policy.** All placement strategies swappable live, activation collection, StatelessWorker,
  zipf/hot-key workloads, reentrancy + the classic A↔B deadlock, message timeouts.
- **P3 — expansion.** Vault (persistence + ETag conflict), Clock Tower (reminders), Canals (streams), guided tour,
  walk camera, day/night themes.

**Accuracy discipline.** Every numeric default (probe limits, vote thresholds, collection age, timeouts) must be
verified against the Orleans source or docs at implementation time and cited in a code comment with its options class.
Do not transcribe remembered values.

## Key Decisions

| Decision                | Choice                                                  | Rationale                                                                                             |
| ----------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Stack                   | TypeScript + three.js + Vite, static bundle              | Matches the reference; best 3D tooling, instant cold load, free hosting. A .NET-authored sim buys nothing the viewer can see. |
| Fidelity                | Hand-built model of real algorithms, slowed 10–100x      | The "working model" credibility is the whole point; also the only way to pause, step, and inject failure. |
| Sim/render boundary     | `sim/` pure, one-way `SimState` + event bus, lint+test enforced | The single rule that kept the reference maintainable; violating it early is unrecoverable.       |
| Coordinates             | All in `world/layout.ts`                                 | Districts must agree on anchors and routes or flows visibly desync.                                    |
| Determinism             | Seeded RNG throughout `sim/`                             | Reproducible scenarios, and tests that assert on exact sequences.                                      |
| Scope sequencing        | All four groups in scope, but strictly P0→P3             | User selected full breadth; phasing prevents a city of half-finished mechanisms.                       |
| Silo count              | 3 by default, 2–6 configurable                           | 3 is the minimum that makes ring arcs, probe neighbours, and vote thresholds legible.                  |
| Teaching hook           | Inspector always maps object → Orleans type → config option | Converts the toy into something engineers return to.                                                |
| Testing                 | Vitest, headless `sim/` only; invariants not snapshots   | Rendering tests are brittle; the invariants are the actual claims being made.                          |
| Streams scope           | Generic pulling-agent model, no provider specifics       | Provider detail is Azure/EventHub trivia, not Orleans semantics.                                       |

## Trade-offs

- **Credibility over speed to first pixel.** Implementing the real ring, vote protocol, and turn boundaries costs
  significantly more than faking them — accepted, because "every building is a real mechanism" is the entire premise.
- **Breadth over depth in v1.** All four subsystem groups are in scope, so P0–P1 will look sparse for a while. Accepted
  via strict phasing: a small number of fully-correct districts beats many approximate ones.
- **Not written in .NET.** For a project about a .NET framework this is thematically odd; accepted because payload size
  and cold-start latency directly determine whether people actually explore it.
- **Slowed timescales distort intuition.** Watching a probe cycle take seconds may mislead about real-world pacing —
  mitigated by always displaying the real default alongside the simulated interval.
- **Determinism constrains the visuals.** Seeded RNG rules out incidental animation randomness in `sim/`; jitter must
  live in `engine/`.

## Execution profile

- **Tier:** in-session
- **Rationale:** This is a greenfield 3D application whose core is a concurrency model — turn boundaries, reentrancy,
  directory races, and ring handoff are subtle correctness work where a plausible-looking implementation is quietly
  wrong. The sim/render boundary is a cross-cutting architectural constraint that must be established by judgment, not
  transcription. The outline fixes *what* to build but deliberately leaves the modeling to implementation.
- **Delegable subset:** the P0 scaffold alone — `package.json`, Vite/tsconfig/ESLint config, Vitest setup, GitHub Pages
  CI workflow, directory skeleton — is mechanical and can go to a `sonnet` executor before in-session work begins.
- **Escalation triggers:** any conflict between a remembered Orleans default and the source; any change to the
  sim/render boundary; adding a runtime dependency beyond three.js; any district whose behavior can't be modeled
  without inventing semantics Orleans doesn't have.

## Open Questions

- **Exact Orleans defaults** (probe limits, vote thresholds, collection age, refresh timeouts) — _not resolvable from
  memory with the confidence this project's premise requires; must be read from the Orleans source at implementation
  time and cited inline._
- **Whether the directory model targets `LocalGrainDirectory` (pre-8) or `DistributedGrainDirectory` (8+)** — _depends
  on which Orleans version is pinned as the reference, which in turn depends on checking what the current release
  actually ships; the ring-based teaching story holds either way._
- **Performance ceiling for simultaneous message vehicles** — _needs profiling on real hardware; determines whether
  flows use instanced meshes or a GPU particle system, and that choice can't be made from a plan._
