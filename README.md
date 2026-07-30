# MSOrleansCity

An explorable, browser-based 3D city where every building is a real mechanism of the [Microsoft Orleans](https://learn.microsoft.com/en-us/dotnet/orleans/overview) virtual-actor runtime, driven by a hand-built model of the actual algorithms rather than a cartoon.

Inspired by [PGSimCity](https://nikolays.github.io/PGSimCity/) by Nikolay Samokhvalov — this project is unaffiliated with PGSimCity or its author.

**This is a model, not an emulator.** No Orleans code runs here. Timings on screen are slowed by orders of
magnitude so a request is watchable; the real Orleans defaults are tracked separately in `src/sim/config.ts` and are
marked unverified until they have been read from the Orleans source and cited. Do not quote the simulated numbers as
Orleans' numbers.

## Start here

Open it, hit **Take the guided tour** (11 chapters, flies you round the districts), or pick one of the eight
**scenarios** in the left panel. Each scenario sets the city up so a single mechanism is unmistakable, then gets out
of the way. Click anything to inspect it.

## Status: P0–P3 complete

**P0 — the cold-call story.** A client call enters through a gateway, misses the gateway's address cache, asks the
directory partition owner on the ring, misses, runs the placement director, builds an activation in the chosen
borough, registers it first-writer-wins, executes a turn, and returns — ten visible hops. Warm calls collapse that to
four via the cache. A stale cache entry produces a rejection that invalidates and rejoins the cold path. Registration
races resolve to a single activation. Four placement strategies (Random, PreferLocal, ActivationCountBased,
HashBased) are swappable live.

**P1 — membership and failure.** Silos stamp their own rows in the membership table and ping a bounded set of ring
neighbours. Enough consecutive missed pings makes a watcher file a suspicion vote; enough independent votes declares
the silo dead. Then: its activations are destroyed, registrations pointing at it are purged, the directory partition
it owned is lost outright, caches are invalidated as the news gossips outward, and the ring closes over its arc. The
grains come back — fresh, with new activation ids — on the next call.

The interesting part is the gap. Hit **kill** on a silo and it goes dark immediately while the cluster still believes
it is Active and keeps routing to it. Calls time out, stale caches produce rejections, and only once the quorum lands
does the ring hand over. That window is real, and it is the reason failure detection has thresholds at all.

Turn on **Traffic** before killing a silo — steady load is what makes the reroute legible.

**P2 — collection and concurrency.** The collector sweeps idle activations and demolishes them, unregistering as it
goes; call one again and it is silently rebuilt, which is the whole meaning of a grain being "virtual". Grains also
call each other, and a caller stays *occupied* for the entire round trip. `alpha`/`beta` call each other and
deadlock; `gamma`/`delta` do exactly the same thing but are `[Reentrant]` and sail through. Nothing breaks the
deadlock but the response timeout — Orleans does not detect them either.

**P3 — the outer districts.** The **Vault** under the plaza is grain storage: persistent grains read as part of
activation (so they visibly take longer to come up) and write back under an ETag, which rejects a stale writer rather
than letting it overwrite. The **Clock Tower** fires durable reminders, which survive deactivation and silo failure
and *reactivate* the grain to deliver — the thing a timer can never do. The **Canals** are stream delivery: a pulling
agent chosen by hashing the stream id drains events to subscribers, reactivating any that had been collected.

### Grain types

The type prefix of a grain id selects its behaviour, the way attributes on a grain class would:

| Prefix           | Behaviour                                                    |
| ---------------- | ------------------------------------------------------------ |
| `user`, `order`  | plain grain — one turn at a time, no state                    |
| `account`        | `IPersistentState` — reads on activation, writes under an ETag |
| `ledger`         | persistent, and registers a durable reminder on activation     |
| `alpha` / `beta` | call each other; non-reentrant, so they deadlock               |
| `gamma` / `delta`| the same cycle, `[Reentrant]` — completes                      |
| `feed`           | stream subscriber                                             |

Not yet built: `StatelessWorkerPlacement` (it is the one strategy that breaks the one-activation-per-grain assumption
in the directory, so it needs multi-activation support first), grain transactions, and per-silo divergent membership
views — the model uses a single cluster-wide ring, noted inline where that simplification lives.

## Development

```
npm install
npm run dev       # start the Vite dev server
npm run build     # type-check and build the static bundle
npm run preview   # preview the production build
npm test          # run the Vitest suite once
npm run test:watch
npm run lint       # eslint .
```

## Structural rules

1. `world/layout.ts` is the single source of truth for every coordinate, anchor, and route in the city.
2. `sim/` never imports three.js; `world/` never mutates simulation state. They communicate through an immutable `SimState` snapshot plus a typed `SimEvent` bus. Enforced by an ESLint `no-restricted-imports` rule **and** a test.
3. Rendering is theme-aware — day and night convey meaning differently (night = state colors dominate).
   _Not yet implemented; the city currently renders in a single night theme._

Colour carries meaning: each borough has a stable hue and every building inherits its host silo's hue, so a grain
moving between silos is visible as a colour change. Amber is reserved for the grain directory and registry traffic.

**Entities, not aggregates.** Anywhere the runtime holds a collection, the city draws one object per item rather than
a number or a bar: a marker per queued request lined up at the door, a shelf per directory registration stacked in
the owning tower, a cell per stored grain on the vault floor (height = its version count), a tick on the ring at each
grain's actual hash position, a plate per row of the membership table. Boroughs show their full 8×8 plot lattice, so
spare capacity is as visible as occupancy.

**Three ways to read it.** The city shows you *where*; the **activity feed** (bottom right) narrates *what just
happened* in plain language — "registry has no user/87 — it must be built", "user/12 lost the race, demolished"; and
the **inspector** explains *what it means* in Orleans, including the configuration option that governs it. Every
vehicle on the road is clickable too — pause and click one to see which hop of which request it is.

See `specs/outlines/orleans-city-3d-visualization.md` for the full design outline.
