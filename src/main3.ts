// import type _ from 'lodash'

// // Economic Constants
// const CREEP_LIFETIME = 1500;
// const INCOME_WEIGHT = CREEP_LIFETIME / 4;
// const INCOME_WINDOW = 60; // ticks to average energy income over for the map readout (~a minute)
// const INCOMING_REGEN_WEIGHT = 0.3;
// const CONTROLLER_BASE_VALUE = 25;
// const UPGRADE_DEFAULT_STRESS = 0.3;
// const UPGRADE_DEDICATION = 0.2;    // when not building, share of worker loads taken to the controller (rest fills spawn/extensions)
// const BUILD_DEDICATION = 0.7;      // when there's a build goal, share of loads spent constructing it (rest fills/makes workers/upgrades)
// const WORKER_FIRST_SPOTS = 3;       // ≥ this many free mining tiles around sources ⇒ always fill (make a worker) before any upgrade
// const CONTAINER_RANGE = 2;          // place source containers within this range of a source (around it, not adjacent)
// const CONTAINERS_PER_SOURCE = 2;    // target containers per source (1st blocks upgrading, rest is optional polish)
// const CONTAINER_VALUE = 400;        // urgency weight of a container goal (× its stress)
// const CONTAINER_REPEAT_STRESS = 0.1; // low stress for containers beyond the first-per-source
// const TOWER_VALUE = 500;            // urgency weight of a tower goal (× its stress)
// const TOWER_REPEAT_STRESS = 0.1;    // low stress for towers beyond the first-per-spawn
// const TOWER_REPAIR_RESERVE = TOWER_CAPACITY / 2; // keep this much tower energy in hand for defence; repair only above it
// const TOWER_BARRIER_TARGET = 30000; // don't sink tower energy into a rampart past this many hits
// const ROAD_VALUE = 200;             // urgency weight of a road goal (× its stress)
// const ROAD_CONTROLLER_STRESS = 0.6; // priority of the spawn→controller road
// const ROAD_EXIT_STRESS = 0.3;       // priority of a spawn→exit road (lower)
// const ROAD_SOURCE_STRESS = 0.5;     // priority of the source↔spawn and source↔controller haul roads
// const ROAD_FILL_STRESS = 0.15;      // priority of paving the spawn's checkerboard movement lanes (lowest)
// const ROAD_FILL_RADIUS = 5;         // how far around the spawn to pave the reverse-checkerboard road lanes
// const REMOTE_SOURCE_RANGE = 45;     // path tiles from a spawn within which a (scouted) remote-room source is worth mining
// const REMOTE_TRAVEL_WEIGHT = 1.35;   // effective round-trip multiplier on distance in the remote-miner count (<2 ⇒ slightly fewer per distance)
// const WORKER_HAUL_CHANCE = 0.5;     // in container mode with no transporters, chance a worker hauls from a container instead of mining
// const WORKER_SATURATION_DECAY = 2; // worker income drops by (workers per source/mineral + 1) ^ this
// const WORKER_COST_RELIEF = 0.9;    // higher → a room's cost barrier fades faster as worker count grows
// const WORKER_COST_SENSITIVITY = 3; // cost exponent at 0 workers (>1 ⇒ cost matters MUCH more when few workers)



// const SETTLE_MINERAL_WEIGHT = 0.3; // how much a new spawn's distance-to-minerals matters vs distance-to-sources

// // A real world-map room name (W/E + digits + N/S + digits). Anything else (e.g. the "sim" room) has no
// // world position, so parseRoomName/toWorldPosition throws for it — guard before map.visual / PathFinder.
// const isMapRoom = (n: string) => /^[WE]\d+[NS]\d+$/.test(n);

// const SETTLE_VALUE = 1000;          // urgency weight of claiming a whole new room
// const SETTLER_BODY: BodyPartConstant[] = [CLAIM, MOVE, MOVE]; // CLAIM creep; extra MOVE to survive the trip
// const SETTLER_COST = SETTLER_BODY.reduce((a, p) => a + BODY_COSTS[p], 0); // energy needed to build a settler

// const NOTABLE: StructureConstant[] = [STRUCTURE_TOWER, STRUCTURE_KEEPER_LAIR, STRUCTURE_INVADER_CORE, STRUCTURE_SPAWN];

// // Higher = better room to settle: sources (primary) + a mineral (secondary).
// const roomScore = (d: ScoutData) => d.sources.length + (d.minerals.length ? SETTLE_MINERAL_WEIGHT : 0);

// // Best unowned, claimable, scouted room — or undefined if GCL is maxed / nothing worth it.
// function settleTarget(): string | undefined {
//   if (Object.values(Game.rooms).filter(r => r.controller?.my).length >= Game.gcl.level) return undefined; // GCL cap
//   let best: string | undefined, bestScore = 0;
//   const scout = scoutMemory();
//   for (const name in scout) {
//     const d = scout[name];
//     if (!d.controller || d.controller.owner || d.controller.reservation) continue; // need a free, unclaimed controller
//     if (Game.map.getRoomStatus(name).status !== 'normal') continue;
//     const s = roomScore(d);
//     if (s > bestScore) { bestScore = s; best = name; }
//   }
//   return best;
// }

// const settlerExists = (room: string) => Object.values(Game.creeps).some(c => c.memory.claim === room);

// // Could we claim another room at all? (GCL cap.) Gates settling — no point sending a settler we
// // couldn't act on. (Scouting is NOT gated on this — we always want fresh frontier intel.)
// const canClaim = () => Object.values(Game.rooms).filter(r => r.controller?.my).length < Game.gcl.level;

// // "Container logistics" mode: once every source has a container, miners drop into them and transporters
// // haul, instead of every worker ferrying its own energy.
// const containerMode = (room: Room) => Goal.BuildContainer.onePerSource(room);

// // --- per-source stand-in coverage (in WORK parts) ---
// // WORK parts to fully mine a source within its regen window. Measured in WORK (not creep count) because a
// // full miner stacks many WORK on one tile, while a stand-in transporter has only ≈1 — so several transporters
// // substitute for one miner. Not capped by tiles: the stand-in COUNT is naturally bounded by free tiles.
// function sourceWorkNeeded(source: Source): number {
//   return Math.ceil(source.energyCapacity / (ENERGY_REGEN_TIME * HARVEST_POWER));
// }
// // WORK parts of stand-in transporters currently assigned to a source (excluding `ignore`, e.g. the asker).
// function standInWork(source: Source, ignore?: Creep): number {
//   return Object.values(Game.creeps)
//     .filter(c => c.id !== ignore?.id && isTransporter(c) && !!c.memory.mining && c.memory.target === source.id)
//     .reduce((n, c) => n + c.body.filter(p => p.type === WORK).length, 0);
// }
// // Is a real miner already assigned to this source? Once one is, stand-ins leave it to them ("until a miner
// // shows up") — and a real miner can reclaim the tile because it ignores yielding stand-ins when picking.
// const sourceHasRealMiner = (source: Source): boolean =>
//   Object.values(Game.creeps).some(c => isLocalWorker(c) && c.memory.target === source.id);

// // Target transporters = enough to keep up with each source's throughput over the round-trip to its
// // farthest sink — whichever of the controller or the spawn is further from that source — so a more
// // spread-out room ⇒ more haulers.
// function transporterTarget(room: Room): number {
//   const carry = Unit.bestTransporter(room.energyCapacityAvailable, haulRoadsComplete(room)).body.filter(p => p === CARRY).length * CARRY_CAPACITY;
//   if (!carry) return 0;
//   const sinks: RoomPosition[] = [];
//   if (room.controller) sinks.push(room.controller.pos);
//   const spawn = room.find(FIND_MY_SPAWNS)[0];
//   if (spawn) sinks.push(spawn.pos);
//   if (!sinks.length) return 0;
//   return room.find(FIND_SOURCES).reduce((n, s) => {
//     const dist = Math.max(...sinks.map(p => s.pos.getRangeTo(p)));
//     return n + Math.ceil((s.energyCapacity / ENERGY_REGEN_TIME) * 2 * dist / carry);
//   }, 0);
// }

// // Memo so a finished road isn't re-scanned tile-by-tile every tick. Re-verified every so often so a road
// // that has since decayed away gets rebuilt.
// const roadDoneUntil: Record<string, number> = {};
// function roadNeedsWork(road: { name: string; isComplete(): boolean }): boolean {
//   if ((roadDoneUntil[road.name] ?? 0) > Game.time) return false; // recently verified complete
//   if (road.isComplete()) { roadDoneUntil[road.name] = Game.time + 500; return false; }
//   return true;
// }

// // The structure checkerboard: extensions, containers and towers all sit on the (x+y)-even tiles, which
// // leaves every (x+y)-odd tile as an open movement lane (what the road fill paves). True = a structure tile.
// const onCheckerboard = (x: number, y: number) => (x + y) % 2 === 0;

// // Reverse-checkerboard tiles around the spawn — the movement lanes between the structure tiles.
// // Paving these lets creeps cross the extension field at road speed.
// function fillRoadTiles(room: Room, spawn: RoomPosition): RoomPosition[] {
//   const tiles: RoomPosition[] = [];
//   const terrain = room.getTerrain();
//   const ctrl = room.controller?.pos;
//   for (let dx = -ROAD_FILL_RADIUS; dx <= ROAD_FILL_RADIUS; dx++) for (let dy = -ROAD_FILL_RADIUS; dy <= ROAD_FILL_RADIUS; dy++) {
//     const x = spawn.x + dx, y = spawn.y + dy;
//     if (x < 1 || x > 48 || y < 1 || y > 48) continue;
//     if (onCheckerboard(x, y)) continue; // lanes are the OFF-checkerboard tiles (between the structures)
//     if (terrain.get(x, y) & TERRAIN_MASK_WALL) continue;
//     // Tiles that can never host a road (a source/mineral/controller sits there) would stay 'todo' forever
//     // and stall the goal — leave them out of the route entirely.
//     if (room.lookForAt(LOOK_SOURCES, x, y).length || room.lookForAt(LOOK_MINERALS, x, y).length) continue;
//     if (ctrl && ctrl.x === x && ctrl.y === y) continue;
//     tiles.push(new RoomPosition(x, y, room.name));
//   }
//   return tiles;
// }

// // The "haul-loop" roads: spawn↔controller, spawn↔each source, source↔controller, plus the spawn's
// // checkerboard fill. These are what the reduced-MOVE transporter body depends on (the loaded haul route
// // must be roaded before we drop a MOVE). Exit roads are NOT part of this set. Keyed by source id so the
// // tile cache stays stable regardless of find() ordering.
// function haulRoads(room: Room): Goal.BuildRoad[] {
//   const spawn = room.find(FIND_MY_SPAWNS)[0];
//   if (!spawn) return [];
//   const ctrl = room.controller;
//   const roads: Goal.BuildRoad[] = [];
//   if (ctrl) roads.push(Goal.BuildRoad.path(room, 'controller', spawn.pos, ctrl.pos, ROAD_CONTROLLER_STRESS));
//   for (const src of room.find(FIND_SOURCES)) {
//     roads.push(Goal.BuildRoad.path(room, `src-${src.id}-spawn`, spawn.pos, src.pos, ROAD_SOURCE_STRESS));
//     if (ctrl) roads.push(Goal.BuildRoad.path(room, `src-${src.id}-ctrl`, src.pos, ctrl.pos, ROAD_SOURCE_STRESS));
//   }
//   roads.push(Goal.BuildRoad.fill(room, spawn.pos, ROAD_FILL_STRESS));
//   return roads;
// }

// // True once every haul-loop road is fully built — gates the reduced-MOVE transporter body. Uses the
// // roadNeedsWork memo so a completed network is a cheap check.
// function haulRoadsComplete(room: Room): boolean {
//   const roads = haulRoads(room);
//   return roads.length > 0 && roads.every(r => !roadNeedsWork(r));
// }

// // Remote creeps report (in Memory) when they see a container at their source, so the spawn loop — which has
// // no vision there — can switch that source to container mode (fewer static miners + dedicated haulers).
// const remoteContSeen = (): Record<string, number> => ((Memory as any).remoteCont ??= {});
// const remoteContainerKnown = (srcId: Id<Source>): boolean => {
//   const t = remoteContSeen()[srcId];
//   return t !== undefined && Game.time - t < CREEP_LIFETIME; // seen within a creep's lifetime
// };

// // How many remote haulers to keep once a source has a container: enough transporter capacity to clear the
// // source's throughput over the road round-trip.
// function remoteHaulerTarget(room: Room, r: { dist: number }): number {
//   const carry = Unit.bestTransporter(room.energyCapacityAvailable, true).body.filter(p => p === CARRY).length * CARRY_CAPACITY;
//   if (!carry) return 1;
//   // Neutral-room sources hold SOURCE_ENERGY_NEUTRAL_CAPACITY (1500) ⇒ ~5/tick throughput to clear over the round trip.
//   return Math.max(1, Math.ceil((SOURCE_ENERGY_NEUTRAL_CAPACITY / ENERGY_REGEN_TIME) * REMOTE_TRAVEL_WEIGHT * r.dist / carry));
// }

// // Military Constants
// const DEFENCE_TO_STRESS_RATIO = 2 // % Military stress is invested in defence.
// const PANIC_AT = 1 / DEFENCE_TO_STRESS_RATIO; // Treshold for dedicating all resources to defence.

// export function loop() {
//   // Clear dead creeps.
//   for (const name in Memory.creeps) if (!Game.creeps[name]) delete Memory.creeps[name];

//   // Map readout: average energy income/sec (over the last minute), yellow, bottom-right of each owned room.
//   // Drawn FIRST so it always renders even if something later in the tick throws.
//   const rate = incomeRate();
//   const label = `${rate.toFixed(1)} E/m`;
//   for (const name in Game.rooms) {
//     const room = Game.rooms[name];
//     if (!room.controller?.my) continue;

//     room.visual.text(label, 48, 48, { color: '#cccc00', align: 'right', font: 0.8 });
//   }

//   goals = [];
//   for (const name in Game.rooms) {
//     // A claimed room with no spawn → send one worker from here to go build its spawn.
//     if (room.controller?.my && room.find(FIND_MY_SPAWNS).length === 0
//         && !Object.values(Game.creeps).some(c => isWorker(c) && c.memory.home === name)) {
//       const free = Object.values(Game.creeps).find(c =>
//         isWorker(c) && !c.memory.home && !c.memory.scout && !c.memory.remote && c.room.controller?.my && c.room.find(FIND_MY_SPAWNS).length > 0);
//       if (free) free.memory.home = name;
//     }
//   }

//   const spawnRemoteHauler = (s: StructureSpawn, r: { id: Id<Source>; room: string }) =>
//     s.spawnCreep(Unit.bestTransporter(s.room.energyCapacityAvailable, haulRoadsComplete(s.room)).body, 'Haul' + Game.time, { memory: { role: 'harvest', remote: { src: r.id, room: r.room, home: s.room.name } } });
//   }
// }

// namespace Goal {
//   export type Amount = number | { type: 'income', amount: number };

//   // Roulette-wheel pick weighted by (clamped) urgency.
//   export function pick(candidates: Obj[]): Obj | undefined {
//     const weights = candidates.map(g => Math.max(0, g.urgency));
//     const total = weights.reduce((a, b) => a + b, 0);
//     if (total <= 0) return undefined;

//     let r = Math.random() * total;
//     for (let i = 0; i < candidates.length; i++) {
//       r -= weights[i];
//       if (r < 0) return candidates[i];
//     }
//     return candidates[candidates.length - 1];
//   }

//   // Deterministic highest-urgency pick — used for per-creep targeting so re-evaluating each
//   // tick is stable (no random jitter). Distribution comes from candidates dropping out (e.g.
//   // a source whose tiles are all taken), not from randomness.
//   export function best(candidates: Obj[]): Obj | undefined {
//     let winner: Obj | undefined;
//     let top = 0;
//     for (const g of candidates) {
//       const u = g.urgency;
//       if (u > top) { top = u; winner = g; }
//     }
//     return winner;
//   }

//   export function forRoom(room: Room): Obj[] {
//     if (!room.controller?.my) return [];

//     const out: Obj[] = [new UpgradeController(room)];

//     // Mine each source.
//     out.push(...room.find(FIND_SOURCES).map(source => new MineEnergy(room, source)));

//     if (room.find(FIND_MY_SPAWNS).length) {
//       out.push(new SpawnWorker(room));
//       out.push(new Scout(room)); // keep frontier intel fresh (gated by stress, not by canClaim)
//       // A container site already placed must be finished before we go back to extensions — otherwise a
//       // fresh RCL (which re-opens extension slots) would abandon it half-built with no goal driving it.
//       const containerSite = room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === STRUCTURE_CONTAINER }).length > 0;
//       if (!BuildExtension.atCap(room) && !containerSite) out.push(new BuildExtension(room));
//       else if (!BuildContainer.atCap(room)) out.push(new BuildContainer(room)); // extensions done (or a container queued) → source containers

//       // Once the first container per source is built (container mode), defensive towers become available
//       // — if the controller level allows another. Competes with repeat-containers via urgency. Also keep
//       // emitting it while a tower site is mid-build (atCap counts that site) so a reload — which wipes the
//       // held economic goal — doesn't orphan the half-built tower with nothing driving it.
//       const towerSite = room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === STRUCTURE_TOWER }).length > 0;
//       if (towerSite || (BuildContainer.onePerSource(room) && !BuildTower.atCap(room))) out.push(new BuildTower(room));

//       // Once a tower is built, lay roads (low priority, so they never starve the economy): the haul-loop
//       // roads (spawn↔controller, spawn↔sources, source↔controller, spawn fill) plus a spawn→exit road per
//       // open side. Emit only the unfinished ones so completed roads don't churn the pick.
//       const tower = room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER }).length > 0;
//       const spawn0 = room.find(FIND_MY_SPAWNS)[0];
//       if (tower && spawn0) {
//         // Road toward each mined remote source — the WHOLE route (both rooms). NOT an economic goal: we
//         // place its sites DIRECTLY every tick (idempotent; home tiles right away, remote tiles whenever a
//         // creep gives vision there) and let the remote miners/haulers build them as they travel (buildAlong),
//         // converging onto the road via road-preferring travel. Driving it off the held-goal pick was too
//         // sporadic to ever finish.
//         for (const rem of remoteSources(room)) {
//           const road = BuildRoad.toward(room, `remote-${rem.id}`, spawn0.pos, new RoomPosition(rem.pos.x, rem.pos.y, rem.pos.roomName), ROAD_SOURCE_STRESS);
//           if (roadNeedsWork(road)) road.place(); // place while incomplete; memo skips a finished road's per-tile rescan
//         }
//       }

//       // If there's a worthwhile unowned room (and GCL allows), offer to settle it from here — but
//       // only if THIS room can actually afford the settler, so it's never an uncompletable goal.
//       const settle = settleTarget();
//       if (settle && room.energyCapacityAvailable >= SETTLER_COST) {
//         out.push(new BuildSettler(room, settle));
//         out.push(new SettleUnclaimed(room, settle));
//       }
//     } else {
//       // Just-claimed room with no spawn yet → building one is the whole job.
//       out.push(new BuildSpawn(room));
//     }

//     return out;
//   }

//   export abstract class Obj {
//     public name: string
//     constructor(public room: Room, name: string) { this.name = `[${room.name}] ${name}` }

//     abstract get stress(): number

//     // Overridable economic shape. Defaults are "nothing".
//     get content(): Partial<Record<ResourceConstant, Amount>> { return {} }
//     get costs(): Partial<Record<ResourceConstant | 'ticks', number>> { return {} }
//     get future(): Obj[] { return [] }
//     get previous(): Obj | undefined { return undefined }
//     get target(): RoomObject | string | undefined { return undefined }
//     get discountCostWithWorkers(): boolean { return true }

//     // Whether this goal is IGNORED when deciding if workers may upgrade the controller. Ongoing /
//     // optional goals (workers, scouting, mining, saturated containers) are ignored; infrastructure we
//     // must finish first (extensions, the first containers) override this to false to hold off upgrading.
//     get ignoredBeforeUpgrade(): boolean { return true }

//     get urgency(): number {
//       const future = this.future.length ? this.future.reduce((a, g) => a + g.urgency, 0) : 1;
//       const c = this.content[RESOURCE_ENERGY];
//       const income = c === undefined ? 0 : (typeof c === 'number' ? c : INCOME_WEIGHT * c.amount);

//       // Cost as a 0..1 affordability multiplier (uses the previous level's cost if present).
//       const cost = (this.previous?.costs ?? this.costs)[RESOURCE_ENERGY] ?? 0;
//       let affordability = cost <= 0 ? 1 : Math.min(1, this.room.energyCapacityAvailable / cost);
//       if (cost > 0) {
//         const workers = this.room.find(FIND_MY_CREEPS, { filter: isLocalWorker }).length;
//         // Few workers → exponent > 1 → cost matters MUCH more. Floored at 1.
//         const exponent = Math.max(1, WORKER_COST_SENSITIVITY / (workers * WORKER_COST_RELIEF + 1));
//         affordability = Math.pow(affordability, exponent);
//       }

//       return (future + income) * this.stress * affordability;
//     }
//   }

//   export abstract class Military extends Obj {
//     get defensive(): boolean { return false }
//     panicking() { return this.stress >= PANIC_AT; }
//   }
//   export abstract class Economy extends Obj { }

//   export class UpgradeController extends Economy {
//     constructor(room: Room, private level: number = room.controller!.level) { super(room, 'Controller Upgrade'); }
//     private get controller() { return this.room.controller!; }

//     get target() { return this.controller; }
//     get content() { return { [RESOURCE_ENERGY]: CONTROLLER_BASE_VALUE }; }
//     get previous() { return this.level > 1 ? new UpgradeController(this.room, this.level - 1) : undefined; }

//     get stress() {
//       const c = this.controller;
//       const max = CONTROLLER_DOWNGRADE[this.level];
//       return c.upgradeBlocked ? 0.2
//         : Math.max(UPGRADE_DEFAULT_STRESS, Math.min(1, 1 - (c.ticksToDowngrade ?? max) / max));
//     }
//     get costs() {
//       const c = this.controller;
//       // Remaining on the live level, else the full progress cost of an already-finished level.
//       const cost = this.level === c.level
//         ? (c.progressTotal ? c.progressTotal - c.progress : 0)
//         : (CONTROLLER_LEVELS[this.level] ?? 0);
//       return { [RESOURCE_ENERGY]: cost };
//     }
//   }

//   export class MineEnergy extends Economy {
//     constructor(room: Room, public source: Source) { super(room, 'Mine Energy'); }
//     get target() { return this.source; }
//     get stress() {
//       const s = this.source;
//       return (1 - INCOMING_REGEN_WEIGHT) * (s.energy / s.energyCapacity)
//         + INCOMING_REGEN_WEIGHT * ((ENERGY_REGEN_TIME - (s.ticksToRegeneration ?? 0)) / ENERGY_REGEN_TIME);
//     }
//     get content() {
//       return { [RESOURCE_ENERGY]: { type: 'income' as const, amount: this.source.energyCapacity / ENERGY_REGEN_TIME } };
//     }
//   }

//   export class MineMineral extends Economy {
//     constructor(room: Room, public mineral: Mineral) { super(room, 'Mine Mineral'); }
//     get target() { return this.mineral; }
//     get stress() {
//       const m = this.mineral;
//       return (m.ticksToRegeneration ? 1 - INCOMING_REGEN_WEIGHT : 1) * (m.density / DENSITY_ULTRA) * (m.mineralAmount === 0 ? 0 : 1)
//         + (m.ticksToRegeneration ? INCOMING_REGEN_WEIGHT * ((MINERAL_REGEN_TIME - m.ticksToRegeneration) / MINERAL_REGEN_TIME) : 0);
//     }
//     get content() { return { [this.mineral.mineralType]: this.mineral.mineralAmount }; }
//   }

//   // Shared "how saturated are workers per resource node" — drives worker income down, extension up.
//   function saturation(room: Room): number {
//     const workers = room.find(FIND_MY_CREEPS, { filter: isLocalWorker }).length;
//     const resources = room.find(FIND_SOURCES).length + room.find(FIND_MINERALS).length;
//     return Math.pow(workers / Math.max(1, resources) + 1, WORKER_SATURATION_DECAY);
//   }

//   export class SpawnWorker extends Economy {
//     constructor(room: Room, private budget: number = room.energyCapacityAvailable) { super(room, 'Spawn Worker/Transporter'); }
//     private get worker() { return Unit.bestAffordableWorker(this.budget); }

    
//     get stress() { return 1; }
//     get discountCostWithWorkers() { return false; } // a new worker's own cost always matters
//     get content() {
//       const workParts = this.worker.body.filter(p => p === WORK).length;
//       return { [RESOURCE_ENERGY]: { type: 'income' as const, amount: workParts * HARVEST_POWER / saturation(this.room) } };
//     }
//     get costs() {
//       const w = this.worker;
//       return { [RESOURCE_ENERGY]: w.cost, ticks: w.body.length * CREEP_SPAWN_TIME };
//     }
//   }

//   // Economy: spawn a CLAIM creep bound for `settle`. Required precursor of SettleUnclaimed — when this
//   // is the room's economic goal, the spawn loop builds the settler. High value (a whole new room).
//   export class BuildSettler extends Economy {
//     constructor(room: Room, public settle: string) { super(room, 'Build Settler'); }
//     get stress() { return 1; }
//     get content() { return { [RESOURCE_ENERGY]: SETTLE_VALUE }; }
//     get costs() { return { [RESOURCE_ENERGY]: SETTLER_BODY.reduce((a, p) => a + BODY_COSTS[p], 0) }; }
//   }

//   // Military: claim `settle`. Requires the settler to exist first (BuildSettler), so we don't send a
//   // claim order with nothing to fulfil it; the Settler unit does the actual claiming.
//   export class SettleUnclaimed extends Military {
//     constructor(room: Room, public settle: string) { super(room, 'Settle Unclaimed'); }
//     get target() { return this.settle; }
//     get stress() { return 1; }
//     get previous(): Obj { return new BuildSettler(this.room, this.settle); } // required precursor
//   }

//   // A goal that raises a structure; `target` is its construction site (built by workers in deliver()).
//   export abstract class Build extends Economy {
//     abstract get structureType(): BuildableStructureConstant;
//     get target() { return this.room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === this.structureType })[0]; }
//     abstract place(): void;
//   }

//   export class BuildExtension extends Build {
//     constructor(room: Room) { super(room, 'StructureExtension'); }
//     get structureType() { return STRUCTURE_EXTENSION; }
//     get ignoredBeforeUpgrade() { return false; } // finish extensions before diverting energy to the controller
//     // Smooth curve, no hardcoded count: 0 when workers are sparse, →1 as they saturate the sources.
//     get stress() { return 1 - 1 / saturation(this.room); }
//     get costs() { return { [RESOURCE_ENERGY]: CONSTRUCTION_COST[STRUCTURE_EXTENSION] }; }
//     get content() {
//       // Smooth magnitude: fraction of a [WORK,MOVE] worker pair this extension's capacity unlocks.
//       return { [RESOURCE_ENERGY]: { type: 'income' as const, amount: EXTENSION_ENERGY_CAPACITY[this.room.controller!.level] / (BODY_COSTS[WORK] + BODY_COSTS[MOVE]) * HARVEST_POWER } };
//     }

//     static atCap(room: Room): boolean {
//       return room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_EXTENSION }).length
//         >= CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][room.controller!.level];
//     }

//     // Simple placement: first free, buildable, checkerboard tile on a ring outward from a spawn.
//     place(): void {
//       if (BuildExtension.atCap(this.room)) return;
//       if (this.room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === STRUCTURE_EXTENSION }).length) return;

//       const spawn = this.room.find(FIND_MY_SPAWNS)[0];
//       if (!spawn) return;
//       const terrain = this.room.getTerrain();
//       const sources = this.room.find(FIND_SOURCES);

//       for (let r = 2; r <= 12; r++) { // reach further out so all RCL-allowed extensions can fit
//         for (let dx = -r; dx <= r; dx++) {
//           for (let dy = -r; dy <= r; dy++) {
//             if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
//             const x = spawn.pos.x + dx, y = spawn.pos.y + dy;
//             if (x < 2 || x > 47 || y < 2 || y > 47) continue;
//             if (!onCheckerboard(x, y)) continue;
//             if (terrain.get(x, y) & TERRAIN_MASK_WALL) continue;
//             if (sources.some(s => s.pos.inRangeTo(x, y, 1))) continue; // never block a source's mining tiles
//             if (this.room.lookForAt(LOOK_STRUCTURES, x, y).length) continue;
//             if (this.room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length) continue;
//             if (this.room.createConstructionSite(x, y, STRUCTURE_EXTENSION) === OK) return;
//           }
//         }
//       }
//     }

//   }

//   // Build source containers once extensions are done. One per source first (blocks upgrading), then more
//   // around each (optional). Placed in the extension-style checkerboard, ringed around each source.
//   export class BuildContainer extends Build {
//     constructor(room: Room) { super(room, 'StructureContainer'); }
//     get structureType() { return STRUCTURE_CONTAINER; }

//     // Containers (built + queued) within CONTAINER_RANGE of a source — for placement/cap, so we don't
//     // queue a duplicate while one is mid-build.
//     private static near(room: Room, src: Source): number {
//       return BuildContainer.builtNear(room, src)
//         + room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === STRUCTURE_CONTAINER && s.pos.inRangeTo(src, CONTAINER_RANGE) }).length;
//     }
//     // Only FINISHED containers within range of a source (sites don't count — they can't be mined into yet).
//     private static builtNear(room: Room, src: Source): number {
//       return room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER && s.pos.inRangeTo(src, CONTAINER_RANGE) }).length;
//     }
//     // Container mode hinges on this: true only once every source has a BUILT (not just queued) container.
//     static onePerSource(room: Room): boolean { return room.find(FIND_SOURCES).every(s => BuildContainer.builtNear(room, s) >= 1); }
//     static atCap(room: Room): boolean { return room.find(FIND_SOURCES).every(s => BuildContainer.near(room, s) >= CONTAINERS_PER_SOURCE); }

//     // Block upgrading only until every source has its first container; after that it's optional polish.
//     get ignoredBeforeUpgrade() { return BuildContainer.onePerSource(this.room); }
//     // High while a source still lacks its first container. Once one-per-source is reached, a further
//     // container is normally low priority — but its pressure rises with how FULL the existing containers
//     // are: backed-up energy means we can't store/haul fast enough, so more capacity is wanted.
//     get stress() {
//       if (!BuildContainer.onePerSource(this.room)) return 1;
//       const containers = this.room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER }) as StructureContainer[];
//       const cap = containers.reduce((a, c) => a + c.store.getCapacity(RESOURCE_ENERGY), 0);
//       const used = containers.reduce((a, c) => a + c.store[RESOURCE_ENERGY], 0);
//       const fullness = cap > 0 ? used / cap : 0;
//       return Math.max(CONTAINER_REPEAT_STRESS, fullness);
//     }
//     get content() { return { [RESOURCE_ENERGY]: CONTAINER_VALUE }; }
//     get costs() { return { [RESOURCE_ENERGY]: CONSTRUCTION_COST[STRUCTURE_CONTAINER] }; }
    
//     // Checkerboard tile ringed around the neediest source (alternates across sources), near it but not
//     // directly adjacent — so miners reach it fast.
//     place(): void {
//       if (this.target) return; // one container site at a time
//       const sources = this.room.find(FIND_SOURCES);
//       if (!sources.length) return;
//       const source = sources.reduce((a, b) => BuildContainer.near(this.room, a) <= BuildContainer.near(this.room, b) ? a : b);
//       if (BuildContainer.near(this.room, source) >= CONTAINERS_PER_SOURCE) return;

//       const terrain = this.room.getTerrain();
//       for (let dx = -CONTAINER_RANGE; dx <= CONTAINER_RANGE; dx++) {
//         for (let dy = -CONTAINER_RANGE; dy <= CONTAINER_RANGE; dy++) {
//           if (Math.max(Math.abs(dx), Math.abs(dy)) < 2) continue; // around it, not directly next to the source
//           const x = source.pos.x + dx, y = source.pos.y + dy;
//           if (x < 1 || x > 48 || y < 1 || y > 48) continue;
//           if (!onCheckerboard(x, y)) continue; // checkerboard, like extensions
//           if (terrain.get(x, y) & TERRAIN_MASK_WALL) continue;
//           if (this.room.lookForAt(LOOK_STRUCTURES, x, y).length) continue;
//           if (this.room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length) continue;
//           if (this.room.createConstructionSite(x, y, STRUCTURE_CONTAINER) === OK) return;
//         }
//       }
//     }
//   }

//   // Build a defensive tower once the first container per source exists (container mode) and the RCL allows
//   // one. Placed on a checkerboard tile directly adjacent to a spawn (the inner ring), same pattern as the
//   // extensions so it doesn't block the road grid. Prefer one tower per spawn first (high stress); extra
//   // towers are optional polish (low stress), like the repeat containers.
//   export class BuildTower extends Build {
//     constructor(room: Room) { super(room, 'StructureTower');}
//     get structureType() { return STRUCTURE_TOWER; }

//     // Finished towers adjacent (range 1) to a spawn.
//     private static builtNear(room: Room, spawn: StructureSpawn): number {
//       return room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER && s.pos.inRangeTo(spawn, 1) }).length;
//     }
//     // Built + queued towers adjacent to a spawn (so we don't double-queue while one is mid-build).
//     private static near(room: Room, spawn: StructureSpawn): number {
//       return BuildTower.builtNear(room, spawn)
//         + room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === STRUCTURE_TOWER && s.pos.inRangeTo(spawn, 1) }).length;
//     }
//     // Total towers (built + queued) in the room.
//     private static count(room: Room): number {
//       return room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER }).length
//         + room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === STRUCTURE_TOWER }).length;
//     }
//     static onePerSpawn(room: Room): boolean {
//       const spawns = room.find(FIND_MY_SPAWNS);
//       return spawns.length > 0 && spawns.every(sp => BuildTower.builtNear(room, sp) >= 1);
//     }
//     // No more towers allowed at this controller level → the goal can't progress, so don't offer it.
//     static atCap(room: Room): boolean {
//       return BuildTower.count(room) >= (CONTROLLER_STRUCTURES[STRUCTURE_TOWER][room.controller!.level] ?? 0);
//     }

//     // High until every spawn has its first tower; after that extra towers are low priority.
//     get stress() { return BuildTower.onePerSpawn(this.room) ? TOWER_REPEAT_STRESS : 1; }
//     get content() { return { [RESOURCE_ENERGY]: TOWER_VALUE }; }
//     get costs() { return { [RESOURCE_ENERGY]: CONSTRUCTION_COST[STRUCTURE_TOWER] }; }

//     // Checkerboard tile adjacent to the spawn that currently has the fewest towers — so we hand out the
//     // first tower per spawn before stacking extras on any one spawn.
//     place(): void {
//       if (this.target) return;             // one tower site at a time
//       if (BuildTower.atCap(this.room)) return;
//       const spawns = this.room.find(FIND_MY_SPAWNS).sort((a, b) => BuildTower.near(this.room, a) - BuildTower.near(this.room, b));
//       const terrain = this.room.getTerrain();
//       for (const spawn of spawns) {
//         for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
//           if (!dx && !dy) continue;
//           const x = spawn.pos.x + dx, y = spawn.pos.y + dy;
//           if (x < 2 || x > 47 || y < 2 || y > 47) continue;
//           if (!onCheckerboard(x, y)) continue; // checkerboard, like extensions → keeps the road grid open
//           if (terrain.get(x, y) & TERRAIN_MASK_WALL) continue;
//           if (this.room.lookForAt(LOOK_STRUCTURES, x, y).length) continue;
//           if (this.room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length) continue;
//           if (this.room.createConstructionSite(x, y, STRUCTURE_TOWER) === OK) return;
//         }
//       }
//     }
//   }

//   // Economy: keep a single roaming MOVE-creep scout out. No target (like SpawnWorker) so it competes
//   // in the pick without affecting the upgrade/build logic. Stress rises as frontier data goes stale or
//   // missing, and collapses to near-zero once a scout already exists (so we keep at most ~one).
//   export class Scout extends Economy {
//     constructor(room: Room) { super(room, 'Scout'); }
//     get content() { return { [RESOURCE_ENERGY]: SCOUT_VALUE }; }
//     get stress() {
//       if (scoutExists()) return SCOUT_REPEAT_STRESS;
//       const scout = scoutMemory();
//       const frontier = Unit.Scout.frontierRooms();
//       if (!frontier.length) return SCOUT_REPEAT_STRESS;
//       const oldest = Math.max(...frontier.map(n => scout[n] ? Game.time - scout[n].ts : Infinity));
//       return Math.min(1, oldest / SCOUT_STALE_TICKS); // older / missing ⇒ higher
//     }
//   }
// }

// namespace Unit {

//   export abstract class Obj {
//     constructor(public self: Creep) { }
//     abstract loop(): void
//   }
  
//   export class Worker extends Obj {


//     loop() {
//       if (this.goHome()) return;
//       if (this.remoteMine()) return; // before returnHome: a remote miner is in an unowned room on purpose
//       if (this.returnHome()) return;
//       this.gather();
//     }

//     // The built container next to our remote source (needs vision — i.e. we're in the room).
//     private remoteContainer(srcId: Id<Source>): StructureContainer | undefined {
//       const src = Game.getObjectById(srcId);
//       if (!src) return undefined;
//       return src.pos.findInRange(FIND_STRUCTURES, CONTAINER_RANGE, { filter: s => s.structureType === STRUCTURE_CONTAINER })[0] as StructureContainer | undefined;
//     }

//     // Once a road has reached the remote source, drop a container site next to it (the miners build it via
//     // buildAlong). After it's built, miners stop hauling home and just feed it; transporters drain it.
//     private ensureRemoteContainer(source: Source): void {
//       const room = source.room!;
//       if (source.pos.findInRange(FIND_STRUCTURES, CONTAINER_RANGE, { filter: s => s.structureType === STRUCTURE_CONTAINER }).length) return;
//       if (source.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, CONTAINER_RANGE, { filter: s => s.structureType === STRUCTURE_CONTAINER }).length) return;
//       if (!source.pos.findInRange(FIND_STRUCTURES, CONTAINER_RANGE + 1, { filter: s => s.structureType === STRUCTURE_ROAD }).length) return; // wait for the road
//       const terrain = room.getTerrain();
//       const wall = (x: number, y: number) => x < 0 || x > 49 || y < 0 || y > 49 || (terrain.get(x, y) & TERRAIN_MASK_WALL) !== 0;
//       const free = (x: number, y: number) => x >= 1 && x <= 48 && y >= 1 && y <= 48 && !wall(x, y)
//         && room.lookForAt(LOOK_STRUCTURES, x, y).length === 0 && room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length === 0;
//       // Pass 1 — a free tile directly adjacent to the source (miner stands on it). Pass 2 (hemmed-in source:
//       // its only adjacent tile is taken, e.g. by the road) — a free tile at range 2 that shares a walkable
//       // neighbour with the source, so a miner standing on that one tile can harvest AND feed the container.
//       for (let range = 1; range <= CONTAINER_RANGE; range++) {
//         for (let dx = -range; dx <= range; dx++) for (let dy = -range; dy <= range; dy++) {
//           if (Math.max(Math.abs(dx), Math.abs(dy)) !== range) continue;
//           const x = source.pos.x + dx, y = source.pos.y + dy;
//           if (!free(x, y)) continue;
//           // Reachable if a miner can stand on this tile itself (it's adjacent to the source → harvest + drop
//           // in place), OR there's a walkable tile adjacent to BOTH it and the source to stand on.
//           let standable = source.pos.isNearTo(x, y);
//           for (let sx = -1; sx <= 1 && !standable; sx++) for (let sy = -1; sy <= 1 && !standable; sy++) {
//             const mx = x + sx, my = y + sy;
//             standable = !(mx === x && my === y) && !wall(mx, my) && source.pos.isNearTo(mx, my);
//           }
//           if (standable && room.createConstructionSite(x, y, STRUCTURE_CONTAINER) === OK) return;
//         }
//       }
//     }

//     // Remote MINER: travel out, mine, and once a container exists feed it (static); before that (or when it's
//     // full) haul the load home ourselves. A transporter-bodied remote creep instead hauls (remoteHaul).
//     private remoteMine(): boolean {
//       const creep = this.self;
//       const r = creep.memory.remote;
//       if (!r) return false;
//       if (isTransporter(creep)) return this.remoteHaul(r);
//       if (this.buildAlong() === 'move') return true; // detouring to a road/container site → let it finish before mining

//       const inRoom = creep.room.name === r.room;
//       const container = inRoom ? this.remoteContainer(r.src) : undefined;
//       if (container) remoteContSeen()[r.src] = Game.time; // tell the spawn loop a container exists here

//       // Carrying a load and full (or mid-delivery) → feed the container if there's room, else haul home.
//       if ((creep.store[RESOURCE_ENERGY] ?? 0) > 0 && (creep.store.getFreeCapacity() === 0 || creep.memory.deliver_target)) {
//         if (container && container.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
//           if (creep.transfer(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.moveTo(container, { visualizePathStyle: { stroke: '#ffaa00' } });
//           return true;
//         }
//         if (creep.room.name !== r.home) { travel(creep, r.home); return true; }
//         this.remoteDeliver();
//         return true;
//       }
//       // Otherwise go mine the source.
//       creep.memory.deliver_target = undefined;
//       if (!inRoom) { travel(creep, r.room, '#ffaa00'); return true; }
//       const source = Game.getObjectById(r.src);
//       if (!source) return true;
//       this.ensureRemoteContainer(source);
//       if (creep.pos.isNearTo(source)) creep.harvest(source);
//       else creep.moveTo(source, { visualizePathStyle: { stroke: '#ffaa00' } });
//       return true;
//     }

//     // Remote HAULER: shuttle the remote container's energy home (prefers roads via travel()).
//     private remoteHaul(r: { src: Id<Source>; room: string; home: string }): boolean {
//       const creep = this.self;
//       // Haulers build AND repair the route as they pass — worst-off (lowest %) first, in one work-action.
//       if (this.maintain() === 'move') return true; // detouring to finish an off-path site → before hauling
//       if ((creep.store[RESOURCE_ENERGY] ?? 0) > 0 && (creep.store.getFreeCapacity() === 0 || creep.memory.deliver_target)) {
//         if (creep.room.name !== r.home) { travel(creep, r.home); return true; }
//         this.remoteDeliver();
//         return true;
//       }
//       creep.memory.deliver_target = undefined;
//       if (creep.room.name !== r.room) { travel(creep, r.room, '#ffaa00'); return true; }
//       const container = this.remoteContainer(r.src);
//       if (container) remoteContSeen()[r.src] = Game.time;
//       if (!container || (container.store[RESOURCE_ENERGY] ?? 0) === 0) return true; // nothing to haul yet → wait
//       if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.moveTo(container, { visualizePathStyle: { stroke: '#ffaa00' } });
//       return true;
//     }

//     // Deliver a remote load into the closest home container (else spawn/extension). NO gather() fallback —
//     // a remote miner must never start mining a HOME source (that local-mining moveTo fights the trip back
//     // to the remote room at the boundary and makes it bounce between rooms).
//     private remoteDeliver(): void {
//       const creep = this.self;
//       const sink = creep.pos.findClosestByPath(creep.room.find(FIND_STRUCTURES, {
//         filter: s => (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION)
//           && ((s as StructureContainer).store.getFreeCapacity(RESOURCE_ENERGY) ?? 0) > 0,
//       }) as (StructureContainer | StructureSpawn | StructureExtension)[]);
//       if (!sink) { creep.memory.deliver_target = undefined; return; } // nowhere to put it → hold
//       creep.memory.deliver_target = sink.id;
//       if (creep.transfer(sink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.moveTo(sink, { visualizePathStyle: { stroke: '#ffffff' } });
//     }

//     // While carrying a load, build a road OR container construction site we pass — UNLESS we're about to
//     // harvest (build and harvest are both work-actions, only one per tick). build is a separate intent from
//     // MOVE, so it doesn't slow the trip. This is what actually constructs the remote-room road and the
//     // source container (home transporters never go there). A one-off chunk of the load pays for it.
//     // 'move' = stepped toward a far site (caller yields), 'build' = built in place (used the tick's
//     // work-action — caller must NOT also repair), 'none' = nothing to build.
//     private buildAlong(): 'move' | 'build' | 'none' {
//       const creep = this.self;
//       if ((creep.store[RESOURCE_ENERGY] ?? 0) === 0) return 'none'; // need energy to build
//       const src = creep.memory.remote && Game.getObjectById(creep.memory.remote.src);
//       if (src && creep.pos.isNearTo(src) && creep.store.getFreeCapacity() > 0) return 'none'; // will harvest this tick → don't build
//       const site = creep.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 10, { // wide sight so a passing creep still reaches sites off its path
//         filter: s => s.structureType === STRUCTURE_ROAD || s.structureType === STRUCTURE_CONTAINER,
//       })[0];
//       if (!site) return 'none';
//       // Within build range (3) → build it while the trip continues (build is a separate intent from MOVE).
//       // Farther → step over to it to build (yields the tick's movement so the trip waits briefly).
//       if (creep.build(site) === ERR_NOT_IN_RANGE) { creep.moveTo(site, { visualizePathStyle: { stroke: '#0000ff' } }); return 'move'; }
//       return 'build';
//     }

//     // On the way back, maintain the route in ONE step: do the WORST-OFF road/container within work-range —
//     // a construction site scored by build %, a damaged structure by hits % — lowest % first (so an unbuilt
//     // gap, then the most-worn structure). build and repair are both work-actions, so this picks exactly one,
//     // which is why a separate repair pass kept losing to building. Only when nothing's in range does it
//     // detour to an off-path site to finish constructing the route.
//     // 'move' = detouring (caller yields), 'work' = built/repaired in place, 'none' = nothing to do.
//     private maintain(): 'move' | 'work' | 'none' {
//       const creep = this.self;
//       if ((creep.store[RESOURCE_ENERGY] ?? 0) === 0) return 'none'; // need energy to build/repair
//       const src = creep.memory.remote && Game.getObjectById(creep.memory.remote.src);
//       if (src && creep.pos.isNearTo(src) && creep.store.getFreeCapacity() > 0) return 'none'; // will harvest this tick
//       const isRC = (t: StructureConstant) => t === STRUCTURE_ROAD || t === STRUCTURE_CONTAINER;
//       let best: ConstructionSite | Structure | undefined, bestPct = Infinity, build = false;
//       for (const cs of creep.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 3, { filter: s => isRC(s.structureType) })) {
//         const p = cs.progress / cs.progressTotal; if (p < bestPct) { bestPct = p; best = cs; build = true; }
//       }
//       for (const st of creep.pos.findInRange(FIND_STRUCTURES, 3, { filter: s => isRC(s.structureType) && s.hits < s.hitsMax })) {
//         const p = st.hits / st.hitsMax; if (p < bestPct) { bestPct = p; best = st; build = false; }
//       }
//       if (best) { if (build) creep.build(best as ConstructionSite); else creep.repair(best as Structure); return 'work'; }
//       const site = creep.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 10, { filter: s => isRC(s.structureType) })[0];
//       if (site) { creep.moveTo(site, { visualizePathStyle: { stroke: '#0000ff' } }); return 'move'; }
//       return 'none';
//     }

//     // Remote builder: travel to and live in the claimed room we're assigned to, until it has a spawn
//     // (then we're released and just become a local worker there). In-room, normal gather→build applies.
//     private goHome(): boolean {
//       const creep = this.self;
//       const home = creep.memory.home;
//       if (!home) return false;
//       if (Game.rooms[home]?.find(FIND_MY_SPAWNS).length) { creep.memory.home = undefined; return false; } // spawn up → released
//       if (creep.room.name !== home) { travel(creep, home); return true; }
//       return false; // arrived → fall through to gather/deliver (mines local sources, builds the spawn)
//     }

//     // Stuck in a room we don't own → walk back to the nearest spawn.
//     private returnHome(): boolean {
//       const creep = this.self;
//       if (creep.room.controller?.my) return false;
//       const spawn = Object.values(Game.spawns).sort((a, b) =>
//         Game.map.getRoomLinearDistance(creep.room.name, a.room.name) - Game.map.getRoomLinearDistance(creep.room.name, b.room.name))[0];
//       if (spawn) creep.moveTo(spawn, { visualizePathStyle: { stroke: '#ffffff' }, reusePath: 20 });
//       return true;
//     }


//   // A hauler: withdraws from source containers and carries energy onward — building the current Build
//   // goal, topping up spawn/extensions/towers, or upgrading the controller (its single WORK part). It's a
//   // Worker that only differs in where it gets energy (containers, not mining) and that it never drops a
//   // load back into a container; everything else — including the whole deliver() decision — is shared.
//   export class Transporter extends Worker {
//     loop() {
//       // Decide stand-in for EVERY transporter, dedicated shuttles included: when real miners are short there's
//       // nothing feeding the containers, so a shuttle that just waits at its dry container would stall the whole
//       // economy. Only when NOT standing in does a dedicated shuttle run its ferry; everyone else uses the
//       // shared Worker loop (→ acquire → standInMine when mining, else withdraw-and-haul).
//       this.updateStandIn();
//       if (this.self.memory.dedicated && !this.self.memory.mining) return this.shuttle();
//       super.loop();
//     }

//     // Dedicated shuttle: ferry ONLY between this transporter's assigned source container and the closest
//     // spawn/extension that needs energy. Never upgrades, builds, mines, or wanders — when nothing needs
//     // filling it just holds its load and waits, so the spawn↔container loop is always covered.
//     private shuttle(): void {
//       const creep = this.self;
//       const source = Game.getObjectById(creep.memory.dedicated!);
//       if (!source) { creep.memory.dedicated = undefined; return; } // source gone → release

//       const container = source.pos.findInRange(FIND_STRUCTURES, CONTAINER_RANGE, {
//         filter: s => s.structureType === STRUCTURE_CONTAINER,
//       })[0] as StructureContainer | undefined;
//       const energy = creep.store[RESOURCE_ENERGY] ?? 0;
//       const containerEnergy = container ? (container.store[RESOURCE_ENERGY] ?? 0) : 0;

//       // Deliver when full, already mid-delivery (deliver_target), or carrying a load the now-dry container
//       // can't top up — so a partial load never just hoards at the container.
//       if (energy > 0 && (creep.store.getFreeCapacity() === 0 || creep.memory.deliver_target || containerEnergy === 0)) {
//         const sink = creep.pos.findClosestByPath(creep.room.find(FIND_MY_STRUCTURES, {
//           filter: s => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION)
//             && ((s as StructureSpawn).store.getFreeCapacity(RESOURCE_ENERGY) ?? 0) > 0,
//         }) as (StructureSpawn | StructureExtension)[]);
//         if (!sink) { creep.memory.deliver_target = undefined; return; } // all full → hold the load and wait
//         creep.memory.deliver_target = sink.id;
//         if (creep.transfer(sink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.moveTo(sink, { visualizePathStyle: { stroke: '#ffffff' } });
//         return;
//       }

//       // Otherwise refill from our source's container.
//       creep.memory.deliver_target = undefined;
//       if (!container || containerEnergy === 0) { if (container) creep.moveTo(container); return; } // wait at/for it
//       if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.moveTo(container, { visualizePathStyle: { stroke: '#ffaa00' } });
//     }

//   // A CLAIM creep: travels to its assigned room and claims the controller. Required quest of
//   // SettleUnclaimed — give it enough MOVE (and maybe TOUGH) so it survives the trip.
//   export class Settler extends Obj {
//     loop() {
//       const creep = this.self;
//       const room = creep.memory.claim;
//       if (!room) return; // unassigned until a SettleUnclaimed goal sets the target room

//       const controller = creep.room.controller;
//       if (creep.room.name !== room || !controller) { travel(creep, room, '#ff00ff'); return; } // multi-room route to the target
//       if (creep.claimController(controller) === ERR_NOT_IN_RANGE) {
//         creep.moveTo(controller, { visualizePathStyle: { stroke: '#ff00ff' } });
//       }
//     }
//   }

//   // Best tile to drop a new room's spawn: open & buildable, minimising distance to sources
//   // (primary) then minerals (secondary, weighted by SETTLE_MINERAL_WEIGHT). Close to them but not
//   // on top — run once at settle time (it scans the whole room, so it's expensive).
//   export function bestSpawnPos(room: Room): RoomPosition | undefined {
//     const sources = room.find(FIND_SOURCES);
//     const minerals = room.find(FIND_MINERALS);
//     const terrain = room.getTerrain();

//     let best: RoomPosition | undefined;
//     let bestScore = Infinity;
//     for (let x = 4; x <= 45; x++) {
//       for (let y = 4; y <= 45; y++) {
//         if (terrain.get(x, y) & TERRAIN_MASK_WALL) continue;
//         const pos = new RoomPosition(x, y, room.name);
//         if (sources.some(s => pos.getRangeTo(s) < 2)) continue; // close, but not jammed against a source

//         const toSources = sources.reduce((a, s) => a + pos.getRangeTo(s), 0) / Math.max(1, sources.length);
//         const toMinerals = minerals.reduce((a, m) => a + pos.getRangeTo(m), 0) / Math.max(1, minerals.length);
//         const score = toSources + toMinerals * SETTLE_MINERAL_WEIGHT;
//         if (score < bestScore) { bestScore = score; best = pos; }
//       }
//     }
//     return best;
//   }
// }
