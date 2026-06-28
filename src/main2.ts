import type _ from 'lodash'

// Economic Constants
const CREEP_LIFETIME = 1500;
const INCOME_WEIGHT = CREEP_LIFETIME / 4;
const INCOME_WINDOW = 60; // ticks to average energy income over for the map readout (~a minute)
const INCOMING_REGEN_WEIGHT = 0.3;
const CONTROLLER_BASE_VALUE = 25;
const UPGRADE_DEFAULT_STRESS = 0.3;
const UPGRADE_DEDICATION = 0.2;    // when not building, share of worker loads taken to the controller (rest fills spawn/extensions)
const BUILD_DEDICATION = 0.7;      // when there's a build goal, share of loads spent constructing it (rest fills/makes workers/upgrades)
const WORKER_FIRST_SPOTS = 3;       // ≥ this many free mining tiles around sources ⇒ always fill (make a worker) before any upgrade
const CONTAINER_RANGE = 2;          // place source containers within this range of a source (around it, not adjacent)
const CONTAINERS_PER_SOURCE = 2;    // target containers per source (1st blocks upgrading, rest is optional polish)
const CONTAINER_VALUE = 400;        // urgency weight of a container goal (× its stress)
const CONTAINER_REPEAT_STRESS = 0.1; // low stress for containers beyond the first-per-source
const TOWER_VALUE = 500;            // urgency weight of a tower goal (× its stress)
const TOWER_REPEAT_STRESS = 0.1;    // low stress for towers beyond the first-per-spawn
const TOWER_REPAIR_RESERVE = TOWER_CAPACITY / 2; // keep this much tower energy in hand for defence; repair only above it
const TOWER_BARRIER_TARGET = 30000; // don't sink tower energy into a rampart past this many hits
const ROAD_VALUE = 200;             // urgency weight of a road goal (× its stress)
const ROAD_CONTROLLER_STRESS = 0.6; // priority of the spawn→controller road
const ROAD_EXIT_STRESS = 0.3;       // priority of a spawn→exit road (lower)
const ROAD_SOURCE_STRESS = 0.5;     // priority of the source↔spawn and source↔controller haul roads
const ROAD_FILL_STRESS = 0.15;      // priority of paving the spawn's checkerboard movement lanes (lowest)
const ROAD_FILL_RADIUS = 5;         // how far around the spawn to pave the reverse-checkerboard road lanes
const REMOTE_SOURCE_RANGE = 45;     // path tiles from a spawn within which a (scouted) remote-room source is worth mining
const REMOTE_TRAVEL_WEIGHT = 1.35;   // effective round-trip multiplier on distance in the remote-miner count (<2 ⇒ slightly fewer per distance)
const WORKER_HAUL_CHANCE = 0.5;     // in container mode with no transporters, chance a worker hauls from a container instead of mining
const WORKER_SATURATION_DECAY = 2; // worker income drops by (workers per source/mineral + 1) ^ this
const WORKER_COST_RELIEF = 0.9;    // higher → a room's cost barrier fades faster as worker count grows
const WORKER_COST_SENSITIVITY = 3; // cost exponent at 0 workers (>1 ⇒ cost matters MUCH more when few workers)



const SETTLE_MINERAL_WEIGHT = 0.3; // how much a new spawn's distance-to-minerals matters vs distance-to-sources

const partCount = (c: Creep, t: BodyPartConstant) => c.body.filter(p => p.type === t).length;
// A creep counts as a "worker" (miner/builder/upgrader) if it has a WORK part but isn't a hauler.
// (Haulers carry a single WORK so they too can dump into the controller — see isTransporter.)
const isWorker = (c: Creep) => c.body.some(p => p.type === WORK) && !isTransporter(c);
// A worker that belongs to THIS room's local population (not off mining a remote room) — used for the
// local miner/transporter balance so remote miners don't inflate the count.
const isLocalWorker = (c: Creep) => isWorker(c) && !c.memory.remote;
const isLocalTransporter = (c: Creep) => isTransporter(c) && !c.memory.remote; // excludes remote haulers

// A real world-map room name (W/E + digits + N/S + digits). Anything else (e.g. the "sim" room) has no
// world position, so parseRoomName/toWorldPosition throws for it — guard before map.visual / PathFinder.
const isMapRoom = (n: string) => /^[WE]\d+[NS]\d+$/.test(n);

const SETTLE_VALUE = 1000;          // urgency weight of claiming a whole new room
const SETTLER_BODY: BodyPartConstant[] = [CLAIM, MOVE, MOVE]; // CLAIM creep; extra MOVE to survive the trip
const SETTLER_COST = SETTLER_BODY.reduce((a, p) => a + BODY_COSTS[p], 0); // energy needed to build a settler

// Serialized room intel. Field types are taken straight from the API objects (Pick<>), but stored as
// plain JSON — `pos` is flattened (a live RoomPosition doesn't survive Memory) and owner is just a name.
type ScoutPos = { x: number; y: number; roomName: string };
type Snap<T, K extends keyof T> = Pick<T, K> & { pos: ScoutPos }; // a serialized snapshot of an API object
type ScoutData = {
  ts: number;     // tick we last had vision
  status: string; // normal / novice / respawn / closed
  sources: (Snap<Source, 'id' | 'energyCapacity'> & { spaces: number })[]; // spaces = free mining tiles around it
  minerals: Snap<Mineral, 'id' | 'mineralType' | 'density' | 'mineralAmount'>[];
  controller?: Snap<StructureController, 'id' | 'level' | 'safeMode' | 'ticksToDowngrade'>
    & { my: boolean; owner?: string; reservation?: { username: string; ticksToEnd: number } };
  hostiles: (Snap<Creep, 'hits'> & { owner: string; body: BodyPartConstant[] })[];
  structures: (Snap<Structure, 'id' | 'structureType'> & { owner?: string })[];
};
const scoutMemory = (): Record<string, ScoutData> => ((Memory as any).scout ??= {});

const scoutPos = (p: RoomPosition): ScoutPos => ({ x: p.x, y: p.y, roomName: p.roomName });
const NOTABLE: StructureConstant[] = [STRUCTURE_TOWER, STRUCTURE_KEEPER_LAIR, STRUCTURE_INVADER_CORE, STRUCTURE_SPAWN];

// Record everything visible about a room (drives settle scoring + intel).
function recordScout(room: Room) {
  const ctrl = room.controller;
  scoutMemory()[room.name] = {
    ts: Game.time,
    status: Game.map.getRoomStatus(room.name).status,
    sources: room.find(FIND_SOURCES).map(s => ({ id: s.id, pos: scoutPos(s.pos), energyCapacity: s.energyCapacity, spaces: staticSpacesAround(s.pos) })),
    minerals: room.find(FIND_MINERALS).map(m => ({ id: m.id, pos: scoutPos(m.pos), mineralType: m.mineralType, density: m.density, mineralAmount: m.mineralAmount })),
    controller: ctrl && {
      id: ctrl.id, pos: scoutPos(ctrl.pos), level: ctrl.level, my: !!ctrl.my,
      owner: ctrl.owner?.username,
      reservation: ctrl.reservation && { username: ctrl.reservation.username, ticksToEnd: ctrl.reservation.ticksToEnd },
      safeMode: ctrl.safeMode,
      ticksToDowngrade: ctrl.ticksToDowngrade,
    },
    hostiles: room.find(FIND_HOSTILE_CREEPS).map(c => ({ owner: c.owner.username, pos: scoutPos(c.pos), hits: c.hits, body: c.body.map(b => b.type) })),
    structures: room.find(FIND_STRUCTURES).filter(s => NOTABLE.includes(s.structureType))
      .map(s => ({ id: s.id, structureType: s.structureType, pos: scoutPos(s.pos), owner: (s as AnyOwnedStructure).owner?.username })),
  };
}

// Higher = better room to settle: sources (primary) + a mineral (secondary).
const roomScore = (d: ScoutData) => d.sources.length + (d.minerals.length ? SETTLE_MINERAL_WEIGHT : 0);

// Best unowned, claimable, scouted room — or undefined if GCL is maxed / nothing worth it.
function settleTarget(): string | undefined {
  if (Object.values(Game.rooms).filter(r => r.controller?.my).length >= Game.gcl.level) return undefined; // GCL cap
  let best: string | undefined, bestScore = 0;
  const scout = scoutMemory();
  for (const name in scout) {
    const d = scout[name];
    if (!d.controller || d.controller.owner || d.controller.reservation) continue; // need a free, unclaimed controller
    if (Game.map.getRoomStatus(name).status !== 'normal') continue;
    const s = roomScore(d);
    if (s > bestScore) { bestScore = s; best = name; }
  }
  return best;
}

const settlerExists = (room: string) => Object.values(Game.creeps).some(c => c.memory.claim === room);

// Could we claim another room at all? (GCL cap.) Gates settling — no point sending a settler we
// couldn't act on. (Scouting is NOT gated on this — we always want fresh frontier intel.)
const canClaim = () => Object.values(Game.rooms).filter(r => r.controller?.my).length < Game.gcl.level;

const SCOUT_VALUE = 400;            // urgency weight of getting a scout out, so it competes in the pick
const SCOUT_REPEAT_STRESS = 0.01;   // once a scout already exists, almost never want another
const SCOUT_STALE_TICKS = 3000;     // frontier data this old (or missing) → maximum scouting stress

const isScout = (c: Creep) => c.body.every(p => p.type === MOVE); // a scout is a MOVE-only creep
const scoutExists = () => Object.values(Game.creeps).some(isScout);
// A hauler: carry-heavy (≥2 CARRY). Workers always carry exactly 1 CARRY (a single CARRY lead + WORK/MOVE
// pairs), so ≥2 CARRY is what cleanly separates a transporter from a miner — regardless of WORK count.
const isTransporter = (c: Creep) => partCount(c, CARRY) >= 2;

// "Container logistics" mode: once every source has a container, miners drop into them and transporters
// haul, instead of every worker ferrying its own energy.
const containerMode = (room: Room) => Goal.BuildContainer.onePerSource(room);

// Walkable tiles around a position, IGNORING creeps (so it's a stable capacity, not a live count).
function staticSpacesAround(pos: RoomPosition): number {
  const room = Game.rooms[pos.roomName];
  if (!room) return 0;
  const terrain = room.getTerrain();
  let n = 0;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    if (!dx && !dy) continue;
    const x = pos.x + dx, y = pos.y + dy;
    if (terrain.get(x, y) & TERRAIN_MASK_WALL) continue;
    const blocked = room.lookForAt(LOOK_STRUCTURES, x, y).some(s =>
      s.structureType !== STRUCTURE_CONTAINER && s.structureType !== STRUCTURE_ROAD &&
      (s.structureType !== STRUCTURE_RAMPART || !(s as StructureRampart).my));
    if (!blocked) n++;
  }
  return n;
}

// Miners to FULLY mine a source within its regen window, rather than just "every free tile". Each
// best-affordable worker mines HARVEST_POWER (2) per WORK part per tick, so we need enough total WORK to
// clear `capacity` energy in ENERGY_REGEN_TIME — capped by the physical free tiles (`spaces`). As workers
// grow (more extensions ⇒ more WORK), this drops, so we don't over-spawn miners (≈2/source at RCL3, often 1
// from RCL4). `room` is where the workers are built (so its energyCapacity sizes the worker).
function minersNeeded(room: Room, capacity: number, spaces: number): number {
  const work = Unit.bestAffordableWorker(room.energyCapacityAvailable).body.filter(p => p === WORK).length;
  if (!work) return spaces;
  return Math.min(spaces, Math.ceil(capacity / (ENERGY_REGEN_TIME * HARVEST_POWER * work))) + 1;
}

// Target miners = sum over sources of the miners needed to fully mine each (capped by its free tiles).
const workerTarget = (room: Room) => room.find(FIND_SOURCES).reduce((n, s) => n + minersNeeded(room, s.energyCapacity, staticSpacesAround(s.pos)), 0);

// --- per-source stand-in coverage (in WORK parts) ---
// WORK parts to fully mine a source within its regen window. Measured in WORK (not creep count) because a
// full miner stacks many WORK on one tile, while a stand-in transporter has only ≈1 — so several transporters
// substitute for one miner. Not capped by tiles: the stand-in COUNT is naturally bounded by free tiles.
function sourceWorkNeeded(source: Source): number {
  return Math.ceil(source.energyCapacity / (ENERGY_REGEN_TIME * HARVEST_POWER));
}
// WORK parts of stand-in transporters currently assigned to a source (excluding `ignore`, e.g. the asker).
function standInWork(source: Source, ignore?: Creep): number {
  return Object.values(Game.creeps)
    .filter(c => c.id !== ignore?.id && isTransporter(c) && !!c.memory.mining && c.memory.target === source.id)
    .reduce((n, c) => n + c.body.filter(p => p.type === WORK).length, 0);
}
// Is a real miner already assigned to this source? Once one is, stand-ins leave it to them ("until a miner
// shows up") — and a real miner can reclaim the tile because it ignores yielding stand-ins when picking.
const sourceHasRealMiner = (source: Source): boolean =>
  Object.values(Game.creeps).some(c => isLocalWorker(c) && c.memory.target === source.id);

// Target transporters = enough to keep up with each source's throughput over the round-trip to its
// farthest sink — whichever of the controller or the spawn is further from that source — so a more
// spread-out room ⇒ more haulers.
function transporterTarget(room: Room): number {
  const carry = Unit.bestTransporter(room.energyCapacityAvailable, haulRoadsComplete(room)).body.filter(p => p === CARRY).length * CARRY_CAPACITY;
  if (!carry) return 0;
  const sinks: RoomPosition[] = [];
  if (room.controller) sinks.push(room.controller.pos);
  const spawn = room.find(FIND_MY_SPAWNS)[0];
  if (spawn) sinks.push(spawn.pos);
  if (!sinks.length) return 0;
  return room.find(FIND_SOURCES).reduce((n, s) => {
    const dist = Math.max(...sinks.map(p => s.pos.getRangeTo(p)));
    return n + Math.ceil((s.energyCapacity / ENERGY_REGEN_TIME) * 2 * dist / carry);
  }, 0);
}

// Run every tower in a room each tick. Defence first, then upkeep:
//   1. heal our wounded front-line fighters (ATTACK/RANGED with no self-heal) — they're the most fragile
//   2. else attack the enemy (closest ⇒ least falloff ⇒ most damage)
//   3. else heal our other wounded creeps (the healers themselves, and anyone else hurt)
//   4. else repair the closest damaged road / container / rampart / … — keeping an energy reserve for defence
function runTowers(room: Room) {
  const towers = room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER }) as StructureTower[];
  if (!towers.length) return;

  const hostiles = room.find(FIND_HOSTILE_CREEPS);
  const healers = hostiles.filter(c => c.body.some(p => p.type === HEAL)); // kill the enemy's healers first
  const wounded = room.find(FIND_MY_CREEPS, { filter: c => c.hits < c.hitsMax });
  const frontline = wounded.filter(c =>
    c.body.some(p => p.type === ATTACK || p.type === RANGED_ATTACK) && !c.body.some(p => p.type === HEAL));
  const otherWounded = wounded.filter(c => !frontline.includes(c));

  for (const tower of towers) {
    const frontHurt = tower.pos.findClosestByRange(frontline);
    if (frontHurt) { tower.heal(frontHurt); continue; }                        // 1: front-liners first
    const enemy = tower.pos.findClosestByRange(healers.length ? healers : hostiles);
    if (enemy) { tower.attack(enemy); continue; }                              // 2: defend — healers first, then the rest
    const hurt = tower.pos.findClosestByRange(otherWounded);
    if (hurt) { tower.heal(hurt); continue; }                                  // 3: heal healers / others
    if ((tower.store[RESOURCE_ENERGY] ?? 0) <= TOWER_REPAIR_RESERVE) continue; // keep a reserve for defence
    const damaged = room.find(FIND_STRUCTURES, {                               // 4: repair infrastructure
      filter: s => s.hits < s.hitsMax && s.structureType !== STRUCTURE_WALL
        && (s.structureType !== STRUCTURE_RAMPART || s.hits < TOWER_BARRIER_TARGET),
    });
    const fix = tower.pos.findClosestByRange(damaged);
    if (fix) tower.repair(fix);
  }
}

// Cache of computed road tile-lists (a route's positions don't change tick to tick — only their build
// state does). Keyed by `${room}|${label}`, rebuilt on a global reset. Avoids re-pathing every tick.
const roadTilesCache: Record<string, { x: number; y: number; roomName: string }[]> = {};
function cachedRoadTiles(key: string, compute: () => RoomPosition[]): RoomPosition[] {
  // Store roomName per tile so a cross-room (remote) road keeps its tiles in the right rooms.
  if (!roadTilesCache[key]) roadTilesCache[key] = compute().map(p => ({ x: p.x, y: p.y, roomName: p.roomName }));
  return roadTilesCache[key].map(t => new RoomPosition(t.x, t.y, t.roomName));
}

// Memo so a finished road isn't re-scanned tile-by-tile every tick. Re-verified every so often so a road
// that has since decayed away gets rebuilt.
const roadDoneUntil: Record<string, number> = {};
function roadNeedsWork(road: { name: string; isComplete(): boolean }): boolean {
  if ((roadDoneUntil[road.name] ?? 0) > Game.time) return false; // recently verified complete
  if (road.isComplete()) { roadDoneUntil[road.name] = Game.time + 500; return false; }
  return true;
}

// Path tiles between two points, preferring plains over swamp and REUSING existing roads (cost 1), but
// routing AROUND containers (they're walkable, so findPath would otherwise cut straight through one and
// leave a gap). Stays in-room and stops one tile short so we don't try to pave the structure/edge at the
// end. Existing roads being cost 1 means a roundabout reuse of them wins only when it's actually shorter —
// otherwise a fresh straight path over plains is taken, as you'd want on open maps.
function roadPath(room: Room, from: RoomPosition, to: RoomPosition): RoomPosition[] {
  return room.findPath(from, to, {
    ignoreCreeps: true, plainCost: 2, swampCost: 10, range: 1, maxRooms: 1,
    costCallback: (roomName, cm) => {
      if (roomName !== room.name) return cm;
      for (const s of room.find(FIND_STRUCTURES)) {
        if (s.structureType === STRUCTURE_ROAD) cm.set(s.pos.x, s.pos.y, 1);          // reuse roads
        else if (s.structureType === STRUCTURE_CONTAINER) cm.set(s.pos.x, s.pos.y, 255); // go around containers
      }
      for (const cs of room.find(FIND_CONSTRUCTION_SITES)) {
        if (cs.structureType === STRUCTURE_ROAD) cm.set(cs.pos.x, cs.pos.y, 1);        // planned roads too
        else if (cs.structureType === STRUCTURE_CONTAINER) cm.set(cs.pos.x, cs.pos.y, 255);
      }
      return cm;
    },
  }).map(s => new RoomPosition(s.x, s.y, room.name));
}

// Reverse-checkerboard tiles around the spawn — the movement lanes between the (x+y)%2===0 structure
// tiles. Paving these lets creeps cross the extension field at road speed.
function fillRoadTiles(room: Room, spawn: RoomPosition): RoomPosition[] {
  const tiles: RoomPosition[] = [];
  const terrain = room.getTerrain();
  const ctrl = room.controller?.pos;
  for (let dx = -ROAD_FILL_RADIUS; dx <= ROAD_FILL_RADIUS; dx++) for (let dy = -ROAD_FILL_RADIUS; dy <= ROAD_FILL_RADIUS; dy++) {
    const x = spawn.x + dx, y = spawn.y + dy;
    if (x < 1 || x > 48 || y < 1 || y > 48) continue;
    if ((x + y) % 2 !== 1) continue; // reverse of the extension/structure checkerboard
    if (terrain.get(x, y) & TERRAIN_MASK_WALL) continue;
    // Tiles that can never host a road (a source/mineral/controller sits there) would stay 'todo' forever
    // and stall the goal — leave them out of the route entirely.
    if (room.lookForAt(LOOK_SOURCES, x, y).length || room.lookForAt(LOOK_MINERALS, x, y).length) continue;
    if (ctrl && ctrl.x === x && ctrl.y === y) continue;
    tiles.push(new RoomPosition(x, y, room.name));
  }
  return tiles;
}

// The "haul-loop" roads: spawn↔controller, spawn↔each source, source↔controller, plus the spawn's
// checkerboard fill. These are what the reduced-MOVE transporter body depends on (the loaded haul route
// must be roaded before we drop a MOVE). Exit roads are NOT part of this set. Keyed by source id so the
// tile cache stays stable regardless of find() ordering.
function haulRoads(room: Room): Goal.BuildRoad[] {
  const spawn = room.find(FIND_MY_SPAWNS)[0];
  if (!spawn) return [];
  const ctrl = room.controller;
  const roads: Goal.BuildRoad[] = [];
  if (ctrl) roads.push(Goal.BuildRoad.path(room, 'controller', spawn.pos, ctrl.pos, ROAD_CONTROLLER_STRESS));
  for (const src of room.find(FIND_SOURCES)) {
    roads.push(Goal.BuildRoad.path(room, `src-${src.id}-spawn`, spawn.pos, src.pos, ROAD_SOURCE_STRESS));
    if (ctrl) roads.push(Goal.BuildRoad.path(room, `src-${src.id}-ctrl`, src.pos, ctrl.pos, ROAD_SOURCE_STRESS));
  }
  roads.push(Goal.BuildRoad.fill(room, spawn.pos, ROAD_FILL_STRESS));
  return roads;
}

// True once every haul-loop road is fully built — gates the reduced-MOVE transporter body. Uses the
// roadNeedsWork memo so a completed network is a cheap check.
function haulRoadsComplete(room: Room): boolean {
  const roads = haulRoads(room);
  return roads.length > 0 && roads.every(r => !roadNeedsWork(r));
}

// Path-tile distance from a position to a (possibly remote) point — cached, computed via PathFinder so it
// works across rooms from scouted terrain. -1 if unreachable.
const remoteDistCache: Record<string, number> = {};
function remoteDist(from: RoomPosition, to: ScoutPos): number {
  const key = `${from.roomName}:${from.x},${from.y}->${to.roomName}:${to.x},${to.y}`;
  if (remoteDistCache[key] === undefined) {
    if (!isMapRoom(to.roomName)) return (remoteDistCache[key] = -1); // bad name → unreachable (don't throw in PathFinder)
    const res = PathFinder.search(from, { pos: new RoomPosition(to.x, to.y, to.roomName), range: 1 }, { plainCost: 2, swampCost: 10, maxOps: 4000 });
    remoteDistCache[key] = res.incomplete ? -1 : res.path.length;
  }
  return remoteDistCache[key];
}

// Nearby remote-room sources worth mining: in a scouted, same-status, unowned adjacent room and within
// REMOTE_SOURCE_RANGE path tiles of our spawn. Carries the scout-recorded free-space count.
function remoteSources(room: Room): { id: Id<Source>; pos: ScoutPos; room: string; spaces: number; cap: number; dist: number }[] {
  const spawn = room.find(FIND_MY_SPAWNS)[0];
  if (!spawn) return [];
  const out: { id: Id<Source>; pos: ScoutPos; room: string; spaces: number; cap: number; dist: number }[] = [];
  const scout = scoutMemory();
  const myStatus = Game.map.getRoomStatus(room.name).status;
  for (const adj of Object.values(Game.map.describeExits(room.name) ?? {})) {
    if (!isMapRoom(adj)) continue;                                       // guard against a malformed name
    if (Game.map.getRoomStatus(adj).status !== myStatus) continue;       // walled-off zone boundary
    const data = scout[adj];
    if (!data || data.controller?.owner) continue;                       // unscouted / someone owns it
    for (const src of data.sources) {
      const dist = remoteDist(spawn.pos, src.pos);
      if (dist < 0 || dist >= REMOTE_SOURCE_RANGE) continue;             // unreachable or too far
      out.push({ id: src.id, pos: src.pos, room: adj, spaces: src.spaces, cap: src.energyCapacity, dist });
    }
  }
  return out;
}

// How many remote miners to keep for a source. A miner only mines for `fillTime` ticks of each round trip
// (travel there + fill the tank + travel back), so to keep each free spot covered we need that many copies
// in the pipeline: spaces × roundTrip/fillTime. (≈2-3 for a one-space source a short hop away.)
function remoteMinerTarget(room: Room, r: { spaces: number; cap: number; dist: number }): number {
  const body = Unit.bestAffordableWorker(room.energyCapacityAvailable).body;
  const work = body.filter(p => p === WORK).length;
  const carry = body.filter(p => p === CARRY).length * CARRY_CAPACITY;
  if (!work || !carry) return r.spaces;
  const fillTime = carry / (work * HARVEST_POWER);            // ticks to fill the tank at full harvest
  const pipeline = Math.ceil((REMOTE_TRAVEL_WEIGHT * r.dist + fillTime) / fillTime); // copies to keep a spot covered
  return minersNeeded(room, r.cap, r.spaces) * pipeline;      // miners needed to fully mine it (not just every tile)
}

// Remote creeps report (in Memory) when they see a container at their source, so the spawn loop — which has
// no vision there — can switch that source to container mode (fewer static miners + dedicated haulers).
const remoteContSeen = (): Record<string, number> => ((Memory as any).remoteCont ??= {});
const remoteContainerKnown = (srcId: Id<Source>): boolean => {
  const t = remoteContSeen()[srcId];
  return t !== undefined && Game.time - t < CREEP_LIFETIME; // seen within a creep's lifetime
};

// How many remote haulers to keep once a source has a container: enough transporter capacity to clear the
// source's throughput over the road round-trip.
function remoteHaulerTarget(room: Room, r: { dist: number }): number {
  const carry = Unit.bestTransporter(room.energyCapacityAvailable, true).body.filter(p => p === CARRY).length * CARRY_CAPACITY;
  if (!carry) return 1;
  // Neutral-room sources hold SOURCE_ENERGY_NEUTRAL_CAPACITY (1500) ⇒ ~5/tick throughput to clear over the round trip.
  return Math.max(1, Math.ceil((SOURCE_ENERGY_NEUTRAL_CAPACITY / ENERGY_REGEN_TIME) * REMOTE_TRAVEL_WEIGHT * r.dist / carry));
}

// What a nearby remote source still needs spawned, if anything. Before its container is built we run combined
// miner-haulers (the pipeline); after, static miners (one per spot) plus dedicated haulers.
function remoteNeed(room: Room, r: { id: Id<Source>; spaces: number; cap: number; dist: number }): 'miner' | 'hauler' | undefined {
  const mine = Object.values(Game.creeps).filter(c => c.memory.remote?.src === r.id);
  const miners = mine.filter(c => !isTransporter(c)).length;
  const haulers = mine.filter(c => isTransporter(c)).length;
  const hasCont = remoteContainerKnown(r.id);
  if (miners < (hasCont ? minersNeeded(room, r.cap, r.spaces) : remoteMinerTarget(room, r))) return 'miner';
  if (hasCont && haulers < remoteHaulerTarget(room, r)) return 'hauler';
  return undefined;
}

// Full road path toward a (possibly remote) destination — both rooms. The remote-room tiles only get sites
// when we have vision there (a miner is present); BuildRoad.state/place handle per-tile rooms.
function remoteRoadTiles(from: RoomPosition, to: RoomPosition): RoomPosition[] {
  // range 2: stop two tiles short of the destination (the source), so the road never paves the source's
  // adjacent mining ring — those tiles are left free for the source container.
  return PathFinder.search(from, { pos: to, range: 2 }, { plainCost: 2, swampCost: 10, maxOps: 4000 }).path;
}

// Track gross energy income — the per-tick depletion summed across every visible source — and return the
// average over the last INCOME_WINDOW ticks. State lives in Memory so it survives a code reload.
function incomeRate(): number {
  const m = (Memory as any).income;
  if (!m || !Array.isArray(m.samples) || typeof m.prev !== 'object') (Memory as any).income = { samples: [], prev: {} };
  const mem = (Memory as any).income as { samples: number[]; prev: Record<string, number> };
  let harvested = 0;
  const prev: Record<string, number> = {};
  for (const name in Game.rooms) for (const src of Game.rooms[name].find(FIND_SOURCES)) {
    const before = mem.prev[src.id];
    if (before !== undefined && before > src.energy) harvested += before - src.energy; // a drop = mined (ignore regen jumps)
    prev[src.id] = src.energy;
  }
  mem.prev = prev;
  mem.samples.push(harvested);
  while (mem.samples.length > INCOME_WINDOW) mem.samples.shift();
  return (mem.samples.reduce((a, b) => a + b, 0) / Math.max(1, mem.samples.length)) * 60;
}

// Military Constants
const DEFENCE_TO_STRESS_RATIO = 2 // % Military stress is invested in defence.
const PANIC_AT = 1 / DEFENCE_TO_STRESS_RATIO; // Treshold for dedicating all resources to defence.

type CreepRole = 'harvest' | 'upgrade' | 'build'
interface CreepMemory {
  role: CreepRole
  target?: Id<Source>
  // Where a full creep takes its energy: a construction site (→ build), the controller (→ upgrade),
  // or a spawn/extension/tower (→ transfer). The object's type discerns the action.
  deliver_target?: Id<ConstructionSite | StructureController | StructureSpawn | StructureTower | StructureExtension | StructureContainer>
  // Settler target: the name of the room whose controller it should travel to and claim.
  claim?: Room['name']
  // Scout target: a worker temporarily sent to this room to gain vision of it.
  scout?: Room['name']
  // Remote-build home: a worker sent to live in this (claimed, spawn-less) room and build its spawn.
  home?: Room['name']
  // Container mode, no transporters yet: this worker is standing in as a hauler for the current trip
  // (withdraw from a container → carry to the economic goal), instead of mining. Re-rolled each trip.
  hauling?: boolean
  // The reverse: a transporter temporarily mining like a worker to cover a miner shortfall. Cleared once
  // real workers fill the spots back in.
  mining?: boolean
  // This load is dedicated to construction (vs filling/worker-creation) — decided once per load by the
  // BUILD_DEDICATION roll so it doesn't flip-flop mid-trip.
  building?: boolean
  // A dedicated shuttle transporter: shuttles only between THIS source's container and the spawn/extensions
  // and never does anything else (no upgrading/building/mining). One per source.
  dedicated?: Id<Source>
  // A remote miner: travels to `room`, mines source `src`, hauls the load back to `home` to deliver.
  remote?: { src: Id<Source>; room: string; home: string }
}
interface SpawnMemory { role: 'economy' }
interface PowerCreepMemory { [name: string]: any }
interface FlagMemory { [name: string]: any }
interface RoomMemory { [name: string]: any }

// Module state, rebuilt each tick.
let goals: Goal.Obj[] = [];
// Sticky "what do we purchase next" choice per room+resource (cleared once achieved).
const economicGoal: Record<Room['name'], Partial<Record<ResourceConstant, Goal.Obj>>> = {};

export function loop() {
  // Clear dead creeps.
  for (const name in Memory.creeps) if (!Game.creeps[name]) delete Memory.creeps[name];

  // Map readout: average energy income/sec (over the last minute), yellow, bottom-right of each owned room.
  // Drawn FIRST so it always renders even if something later in the tick throws.
  const rate = incomeRate();
  const label = `${rate.toFixed(1)} E/m`;
  for (const name in Game.rooms) {
    const room = Game.rooms[name];
    if (!room.controller?.my) continue;

    room.visual.text(label, 48, 48, { color: '#cccc00', align: 'right', font: 0.8 });
  }

  goals = [];
  for (const name in Game.rooms) {
    const room = Game.rooms[name];
    recordScout(room); // remember every room we can see, for settle scoring
    runTowers(room);   // operate any towers (defence + upkeep) every tick, independent of the goal logic
    const room_goals = Goal.forRoom(room);
    goals.push(...room_goals);

    (economicGoal as any)[name] ??= {};

    // Drop a finished economic goal (worker spawned / extension built) so the next can be picked.
    const current = economicGoal[name][RESOURCE_ENERGY];
    if (current && Goal.achieved(current, room)) delete economicGoal[name][RESOURCE_ENERGY];

    const held = economicGoal[name][RESOURCE_ENERGY];
    if (held) {
      // Keep laying construction sites for a held Build goal every tick — multi-tile roads can't place
      // their whole route at once (site cap), and it's idempotent for single-structure builds.
      if (held instanceof Goal.Build) held.place();
      continue; // still pursuing a goal that isn't done
    }

    // Don't pick a NEW economic goal while a creep is still spawning. The goal we just cleared (e.g. a
    // SpawnWorker, whose `achieved` stays true for the whole spawn) is still being acted out, and
    // re-rolling every tick of a long spawn would churn the goal — and keep re-placing build sites
    // (that's how a low-stress container kept winning). Wait for the spawn to finish, then pick afresh
    // (which may well be a spawn again — that's fine).
    if (room.find(FIND_MY_SPAWNS).some(sp => !!sp.spawning)) continue;

    const goal = Goal.pick(
      room_goals.filter(g => g instanceof Goal.Economy).filter(g => !g.target || g instanceof Goal.Build)
    );
    if (goal) {
      economicGoal[name][RESOURCE_ENERGY] = goal;
      console.log(`Economic goal for: ${goal.name}`);
      if (goal instanceof Goal.Build) goal.place();
    }

    // A claimed room with no spawn → send one worker from here to go build its spawn.
    if (room.controller?.my && room.find(FIND_MY_SPAWNS).length === 0
        && !Object.values(Game.creeps).some(c => isWorker(c) && c.memory.home === name)) {
      const free = Object.values(Game.creeps).find(c =>
        isWorker(c) && !c.memory.home && !c.memory.scout && !c.memory.remote && c.room.controller?.my && c.room.find(FIND_MY_SPAWNS).length > 0);
      if (free) free.memory.home = name;
    }
  }

  let haveScout = scoutExists(); // tick-local guard: a just-queued scout isn't in Game.creeps yet
  const spawnHauler = (s: StructureSpawn, dedicated?: Id<Source>) =>
    s.spawnCreep(Unit.bestTransporter(s.room.energyCapacityAvailable, haulRoadsComplete(s.room)).body, 'Haul' + Game.time, { memory: { role: 'harvest', dedicated } });
  const spawnWorker = (s: StructureSpawn) =>
    s.spawnCreep(Unit.bestAffordableWorker(s.room.energyCapacityAvailable).body, 'Creep' + Game.time, { memory: { role: 'harvest' } });
  const spawnRemoteMiner = (s: StructureSpawn, r: { id: Id<Source>; room: string }) =>
    s.spawnCreep(Unit.bestAffordableWorker(s.room.energyCapacityAvailable).body, 'Creep' + Game.time, { memory: { role: 'harvest', remote: { src: r.id, room: r.room, home: s.room.name } } });
  const spawnRemoteHauler = (s: StructureSpawn, r: { id: Id<Source>; room: string }) =>
    s.spawnCreep(Unit.bestTransporter(s.room.energyCapacityAvailable, haulRoadsComplete(s.room)).body, 'Haul' + Game.time, { memory: { role: 'harvest', remote: { src: r.id, room: r.room, home: s.room.name } } });
  for (const name in Game.spawns) {
    const s = Game.spawns[name];
    if (s.spawning) continue;
    const econ = economicGoal[s.room.name]?.[RESOURCE_ENERGY];
    if (econ instanceof Goal.BuildSettler && !settlerExists(econ.settle)) {
      s.spawnCreep(SETTLER_BODY, 'Settler' + Game.time, { memory: { role: 'harvest', claim: econ.settle } });
    } else if (econ instanceof Goal.Scout && !haveScout) {
      if (s.spawnCreep([MOVE], 'Scout' + Game.time, { memory: { role: 'harvest' } }) === OK) haveScout = true; // at most one scout
    } else if (containerMode(s.room)) {
      // Container mode: maintain a population of miners (= mining tiles) and haulers (= haul distance).
      // The two targets differ a lot in size (many mining tiles, few haulers), so balance by FILL RATIO
      // — spawn whichever population is proportionally more under target — rather than raw need, else the
      // big worker target would always win and transporters would never get spawned.
      const workers = s.room.find(FIND_MY_CREEPS, { filter: isLocalWorker }).length;
      const transporters = s.room.find(FIND_MY_CREEPS, { filter: isLocalTransporter }).length;
      const wTarget = workerTarget(s.room), tTarget = transporterTarget(s.room);
      const wNeed = wTarget - workers, tNeed = tTarget - transporters;
      const wRatio = workers / Math.max(1, wTarget), tRatio = transporters / Math.max(1, tTarget);
      // Guarantee one dedicated spawn↔container shuttle per source before balancing the general pool.
      const undedicated = s.room.find(FIND_SOURCES).find(src => !Object.values(Game.creeps).some(c => c.memory.dedicated === src.id));
      // A nearby remote source still needing a creep — a miner (combined, or static once its container is
      // built) or a dedicated hauler. Staffed only with spare capacity.
      const remote = remoteSources(s.room).find(r => remoteNeed(s.room, r) !== undefined);
      if (undedicated) spawnHauler(s, undedicated.id);
      else if (tNeed > 0 && (wNeed <= 0 || tRatio < wRatio)) spawnHauler(s); // tie → spawn the worker (miners are foundational)
      else if (wNeed > 0) spawnWorker(s);
      else if (remote) (remoteNeed(s.room, remote) === 'hauler' ? spawnRemoteHauler : spawnRemoteMiner)(s, remote);
      else spawnHauler(s); // nothing else needed but energy to spare → another hauler
    } else {
      spawnWorker(s);
    }
  }

  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    try {
      if (isWorker(creep)) new Unit.Worker(creep).loop();
      else if (creep.body.some(p => p.type === CLAIM)) new Unit.Settler(creep).loop();
      else if (isTransporter(creep)) new Unit.Transporter(creep).loop(); // CARRY-only hauler
      else if (isScout(creep)) new Unit.Scout(creep).loop(); // MOVE-only scout
    } catch (e) {
      console.log(`creep ${name} error: ${(e as Error).stack ?? e}`); // one bad creep shouldn't abort the tick
    }
  }
}

namespace Goal {
  export type Amount = number | { type: 'income', amount: number };

  // Roulette-wheel pick weighted by (clamped) urgency.
  export function pick(candidates: Obj[]): Obj | undefined {
    const weights = candidates.map(g => Math.max(0, g.urgency));
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return undefined;

    let r = Math.random() * total;
    for (let i = 0; i < candidates.length; i++) {
      r -= weights[i];
      if (r < 0) return candidates[i];
    }
    return candidates[candidates.length - 1];
  }

  // Deterministic highest-urgency pick — used for per-creep targeting so re-evaluating each
  // tick is stable (no random jitter). Distribution comes from candidates dropping out (e.g.
  // a source whose tiles are all taken), not from randomness.
  export function best(candidates: Obj[]): Obj | undefined {
    let winner: Obj | undefined;
    let top = 0;
    for (const g of candidates) {
      const u = g.urgency;
      if (u > top) { top = u; winner = g; }
    }
    return winner;
  }

  // Has an economic goal been fulfilled, so we can move on to the next purchase?
  export function achieved(goal: Obj, room: Room): boolean {
    if (goal instanceof SpawnWorker) return room.find(FIND_MY_SPAWNS).some(s => !!s.spawning); // a worker is being made
    if (goal instanceof BuildExtension) return room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === STRUCTURE_EXTENSION }).length === 0; // site finished
    if (goal instanceof BuildContainer) return room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === STRUCTURE_CONTAINER }).length === 0; // container built → pick next (incl. next source)
    if (goal instanceof BuildTower) return room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === STRUCTURE_TOWER }).length === 0; // tower built → pick next
    if (goal instanceof BuildRoad) return goal.isComplete(); // every tile on this road's route carries a road
    if (goal instanceof Scout) return scoutExists(); // a scout is out
    if (goal instanceof BuildSettler) return settlerExists(goal.settle); // the settler is on its way
    if (goal instanceof BuildSpawn) return room.find(FIND_MY_SPAWNS).length > 0; // spawn built → room is self-sufficient
    return false;
  }

  export function forRoom(room: Room): Obj[] {
    if (!room.controller?.my) return [];

    const out: Obj[] = [new UpgradeController(room)];

    // Mine each source.
    out.push(...room.find(FIND_SOURCES).map(source => new MineEnergy(room, source)));

    if (room.find(FIND_MY_SPAWNS).length) {
      out.push(new SpawnWorker(room));
      out.push(new Scout(room)); // keep frontier intel fresh (gated by stress, not by canClaim)
      // A container site already placed must be finished before we go back to extensions — otherwise a
      // fresh RCL (which re-opens extension slots) would abandon it half-built with no goal driving it.
      const containerSite = room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === STRUCTURE_CONTAINER }).length > 0;
      if (!BuildExtension.atCap(room) && !containerSite) out.push(new BuildExtension(room));
      else if (!BuildContainer.atCap(room)) out.push(new BuildContainer(room)); // extensions done (or a container queued) → source containers

      // Once the first container per source is built (container mode), defensive towers become available
      // — if the controller level allows another. Competes with repeat-containers via urgency. Also keep
      // emitting it while a tower site is mid-build (atCap counts that site) so a reload — which wipes the
      // held economic goal — doesn't orphan the half-built tower with nothing driving it.
      const towerSite = room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === STRUCTURE_TOWER }).length > 0;
      if (towerSite || (BuildContainer.onePerSource(room) && !BuildTower.atCap(room))) out.push(new BuildTower(room));

      // Once a tower is built, lay roads (low priority, so they never starve the economy): the haul-loop
      // roads (spawn↔controller, spawn↔sources, source↔controller, spawn fill) plus a spawn→exit road per
      // open side. Emit only the unfinished ones so completed roads don't churn the pick.
      const tower = room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER }).length > 0;
      const spawn0 = room.find(FIND_MY_SPAWNS)[0];
      if (tower && spawn0) {
        const roads = haulRoads(room);
        // Exit roads only to sides that actually lead somewhere reachable: there must be a neighbouring
        // room AND it must share our map status — a different status means a novice/respawn-zone wall seals
        // that edge, so a road to it would just dead-end.
        const myStatus = Game.map.getRoomStatus(room.name).status;
        const exitDirs = Game.map.describeExits(room.name) as Record<number, string | undefined>;
        const exitFinds: [string, FindConstant][] = [['top', FIND_EXIT_TOP], ['bottom', FIND_EXIT_BOTTOM], ['left', FIND_EXIT_LEFT], ['right', FIND_EXIT_RIGHT]];
        for (const [nm, f] of exitFinds) {
          const neighbour = exitDirs[f as number]; // FIND_EXIT_* values match the direction keys describeExits uses
          if (!neighbour || Game.map.getRoomStatus(neighbour).status !== myStatus) continue;
          const exits = room.find(f) as RoomPosition[];
          if (exits.length) roads.push(BuildRoad.path(room, `exit-${nm}`, spawn0.pos, exits[Math.floor(exits.length / 2)], ROAD_EXIT_STRESS));
        }
        for (const r of roads) if (roadNeedsWork(r)) out.push(r);

        // Road toward each mined remote source — the WHOLE route (both rooms). NOT an economic goal: we
        // place its sites DIRECTLY every tick (idempotent; home tiles right away, remote tiles whenever a
        // creep gives vision there) and let the remote miners/haulers build them as they travel (buildAlong),
        // converging onto the road via road-preferring travel. Driving it off the held-goal pick was too
        // sporadic to ever finish.
        for (const rem of remoteSources(room)) {
          const road = BuildRoad.toward(room, `remote-${rem.id}`, spawn0.pos, new RoomPosition(rem.pos.x, rem.pos.y, rem.pos.roomName), ROAD_SOURCE_STRESS);
          if (roadNeedsWork(road)) road.place(); // place while incomplete; memo skips a finished road's per-tile rescan
        }
      }

      // If there's a worthwhile unowned room (and GCL allows), offer to settle it from here — but
      // only if THIS room can actually afford the settler, so it's never an uncompletable goal.
      const settle = settleTarget();
      if (settle && room.energyCapacityAvailable >= SETTLER_COST) {
        out.push(new BuildSettler(room, settle));
        out.push(new SettleUnclaimed(room, settle));
      }
    } else {
      // Just-claimed room with no spawn yet → building one is the whole job.
      out.push(new BuildSpawn(room));
    }

    return out;
  }

  export abstract class Obj {
    public name: string
    constructor(public room: Room, name: string) { this.name = `[${room.name}] ${name}` }

    abstract get stress(): number

    // Overridable economic shape. Defaults are "nothing".
    get content(): Partial<Record<ResourceConstant, Amount>> { return {} }
    get costs(): Partial<Record<ResourceConstant | 'ticks', number>> { return {} }
    get future(): Obj[] { return [] }
    get previous(): Obj | undefined { return undefined }
    get target(): RoomObject | string | undefined { return undefined }
    get discountCostWithWorkers(): boolean { return true }

    // Whether this goal is IGNORED when deciding if workers may upgrade the controller. Ongoing /
    // optional goals (workers, scouting, mining, saturated containers) are ignored; infrastructure we
    // must finish first (extensions, the first containers) override this to false to hold off upgrading.
    get ignoredBeforeUpgrade(): boolean { return true }

    get urgency(): number {
      const future = this.future.length ? this.future.reduce((a, g) => a + g.urgency, 0) : 1;
      const c = this.content[RESOURCE_ENERGY];
      const income = c === undefined ? 0 : (typeof c === 'number' ? c : INCOME_WEIGHT * c.amount);

      // Cost as a 0..1 affordability multiplier (uses the previous level's cost if present).
      const cost = (this.previous?.costs ?? this.costs)[RESOURCE_ENERGY] ?? 0;
      let affordability = cost <= 0 ? 1 : Math.min(1, this.room.energyCapacityAvailable / cost);
      if (cost > 0) {
        const workers = this.room.find(FIND_MY_CREEPS, { filter: isLocalWorker }).length;
        // Few workers → exponent > 1 → cost matters MUCH more. Floored at 1.
        const exponent = Math.max(1, WORKER_COST_SENSITIVITY / (workers * WORKER_COST_RELIEF + 1));
        affordability = Math.pow(affordability, exponent);
      }

      return (future + income) * this.stress * affordability;
    }
  }

  export abstract class Military extends Obj {
    get defensive(): boolean { return false }
    panicking() { return this.stress >= PANIC_AT; }
  }
  export abstract class Economy extends Obj { }

  export class UpgradeController extends Economy {
    constructor(room: Room, private level: number = room.controller!.level) { super(room, 'Controller Upgrade'); }
    private get controller() { return this.room.controller!; }

    get target() { return this.controller; }
    get content() { return { [RESOURCE_ENERGY]: CONTROLLER_BASE_VALUE }; }
    get previous() { return this.level > 1 ? new UpgradeController(this.room, this.level - 1) : undefined; }

    get stress() {
      const c = this.controller;
      const max = CONTROLLER_DOWNGRADE[this.level];
      return c.upgradeBlocked ? 0.2
        : Math.max(UPGRADE_DEFAULT_STRESS, Math.min(1, 1 - (c.ticksToDowngrade ?? max) / max));
    }
    get costs() {
      const c = this.controller;
      // Remaining on the live level, else the full progress cost of an already-finished level.
      const cost = this.level === c.level
        ? (c.progressTotal ? c.progressTotal - c.progress : 0)
        : (CONTROLLER_LEVELS[this.level] ?? 0);
      return { [RESOURCE_ENERGY]: cost };
    }
  }

  export class MineEnergy extends Economy {
    constructor(room: Room, public source: Source) { super(room, 'Mine Energy'); }
    get target() { return this.source; }
    get stress() {
      const s = this.source;
      return (1 - INCOMING_REGEN_WEIGHT) * (s.energy / s.energyCapacity)
        + INCOMING_REGEN_WEIGHT * ((ENERGY_REGEN_TIME - (s.ticksToRegeneration ?? 0)) / ENERGY_REGEN_TIME);
    }
    get content() {
      return { [RESOURCE_ENERGY]: { type: 'income' as const, amount: this.source.energyCapacity / ENERGY_REGEN_TIME } };
    }
  }

  export class MineMineral extends Economy {
    constructor(room: Room, public mineral: Mineral) { super(room, 'Mine Mineral'); }
    get target() { return this.mineral; }
    get stress() {
      const m = this.mineral;
      return (m.ticksToRegeneration ? 1 - INCOMING_REGEN_WEIGHT : 1) * (m.density / DENSITY_ULTRA) * (m.mineralAmount === 0 ? 0 : 1)
        + (m.ticksToRegeneration ? INCOMING_REGEN_WEIGHT * ((MINERAL_REGEN_TIME - m.ticksToRegeneration) / MINERAL_REGEN_TIME) : 0);
    }
    get content() { return { [this.mineral.mineralType]: this.mineral.mineralAmount }; }
  }

  // Shared "how saturated are workers per resource node" — drives worker income down, extension up.
  function saturation(room: Room): number {
    const workers = room.find(FIND_MY_CREEPS, { filter: isLocalWorker }).length;
    const resources = room.find(FIND_SOURCES).length + room.find(FIND_MINERALS).length;
    return Math.pow(workers / Math.max(1, resources) + 1, WORKER_SATURATION_DECAY);
  }

  export class SpawnWorker extends Economy {
    constructor(room: Room, private budget: number = room.energyCapacityAvailable) { super(room, 'Spawn Worker/Transporter'); }
    private get worker() { return Unit.bestAffordableWorker(this.budget); }

    
    get stress() { return 1; }
    get discountCostWithWorkers() { return false; } // a new worker's own cost always matters
    get content() {
      const workParts = this.worker.body.filter(p => p === WORK).length;
      return { [RESOURCE_ENERGY]: { type: 'income' as const, amount: workParts * HARVEST_POWER / saturation(this.room) } };
    }
    get costs() {
      const w = this.worker;
      return { [RESOURCE_ENERGY]: w.cost, ticks: w.body.length * CREEP_SPAWN_TIME };
    }
  }

  // Economy: spawn a CLAIM creep bound for `settle`. Required precursor of SettleUnclaimed — when this
  // is the room's economic goal, the spawn loop builds the settler. High value (a whole new room).
  export class BuildSettler extends Economy {
    constructor(room: Room, public settle: string) { super(room, 'Build Settler'); }
    get stress() { return 1; }
    get content() { return { [RESOURCE_ENERGY]: SETTLE_VALUE }; }
    get costs() { return { [RESOURCE_ENERGY]: SETTLER_BODY.reduce((a, p) => a + BODY_COSTS[p], 0) }; }
  }

  // Military: claim `settle`. Requires the settler to exist first (BuildSettler), so we don't send a
  // claim order with nothing to fulfil it; the Settler unit does the actual claiming.
  export class SettleUnclaimed extends Military {
    constructor(room: Room, public settle: string) { super(room, 'Settle Unclaimed'); }
    get target() { return this.settle; }
    get stress() { return 1; }
    get previous(): Obj { return new BuildSettler(this.room, this.settle); } // required precursor
  }

  // A goal that raises a structure; `target` is its construction site (built by workers in deliver()).
  export abstract class Build extends Economy {
    abstract get structureType(): BuildableStructureConstant;
    get target() { return this.room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === this.structureType })[0]; }
    abstract place(): void;
  }

  export class BuildExtension extends Build {
    constructor(room: Room) { super(room, 'StructureExtension'); }
    get structureType() { return STRUCTURE_EXTENSION; }
    get ignoredBeforeUpgrade() { return false; } // finish extensions before diverting energy to the controller
    // Smooth curve, no hardcoded count: 0 when workers are sparse, →1 as they saturate the sources.
    get stress() { return 1 - 1 / saturation(this.room); }
    get costs() { return { [RESOURCE_ENERGY]: CONSTRUCTION_COST[STRUCTURE_EXTENSION] }; }
    get content() {
      // Smooth magnitude: fraction of a [WORK,MOVE] worker pair this extension's capacity unlocks.
      return { [RESOURCE_ENERGY]: { type: 'income' as const, amount: EXTENSION_ENERGY_CAPACITY[this.room.controller!.level] / (BODY_COSTS[WORK] + BODY_COSTS[MOVE]) * HARVEST_POWER } };
    }

    static atCap(room: Room): boolean {
      return room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_EXTENSION }).length
        >= CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][room.controller!.level];
    }

    // Simple placement: first free, buildable, checkerboard tile on a ring outward from a spawn.
    place(): void {
      if (BuildExtension.atCap(this.room)) return;
      if (this.room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === STRUCTURE_EXTENSION }).length) return;

      const spawn = this.room.find(FIND_MY_SPAWNS)[0];
      if (!spawn) return;
      const terrain = this.room.getTerrain();
      const sources = this.room.find(FIND_SOURCES);

      for (let r = 2; r <= 12; r++) { // reach further out so all RCL-allowed extensions can fit
        for (let dx = -r; dx <= r; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = spawn.pos.x + dx, y = spawn.pos.y + dy;
            if (x < 2 || x > 47 || y < 2 || y > 47) continue;
            if ((x + y) % 2 !== 0) continue;
            if (terrain.get(x, y) & TERRAIN_MASK_WALL) continue;
            if (sources.some(s => s.pos.inRangeTo(x, y, 1))) continue; // never block a source's mining tiles
            if (this.room.lookForAt(LOOK_STRUCTURES, x, y).length) continue;
            if (this.room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length) continue;
            if (this.room.createConstructionSite(x, y, STRUCTURE_EXTENSION) === OK) return;
          }
        }
      }
    }

  }

  // Build source containers once extensions are done. One per source first (blocks upgrading), then more
  // around each (optional). Placed in the extension-style checkerboard, ringed around each source.
  export class BuildContainer extends Build {
    constructor(room: Room) { super(room, 'StructureContainer'); }
    get structureType() { return STRUCTURE_CONTAINER; }

    // Containers (built + queued) within CONTAINER_RANGE of a source — for placement/cap, so we don't
    // queue a duplicate while one is mid-build.
    private static near(room: Room, src: Source): number {
      return BuildContainer.builtNear(room, src)
        + room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === STRUCTURE_CONTAINER && s.pos.inRangeTo(src, CONTAINER_RANGE) }).length;
    }
    // Only FINISHED containers within range of a source (sites don't count — they can't be mined into yet).
    private static builtNear(room: Room, src: Source): number {
      return room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER && s.pos.inRangeTo(src, CONTAINER_RANGE) }).length;
    }
    // Container mode hinges on this: true only once every source has a BUILT (not just queued) container.
    static onePerSource(room: Room): boolean { return room.find(FIND_SOURCES).every(s => BuildContainer.builtNear(room, s) >= 1); }
    static atCap(room: Room): boolean { return room.find(FIND_SOURCES).every(s => BuildContainer.near(room, s) >= CONTAINERS_PER_SOURCE); }

    // Block upgrading only until every source has its first container; after that it's optional polish.
    get ignoredBeforeUpgrade() { return BuildContainer.onePerSource(this.room); }
    // High while a source still lacks its first container. Once one-per-source is reached, a further
    // container is normally low priority — but its pressure rises with how FULL the existing containers
    // are: backed-up energy means we can't store/haul fast enough, so more capacity is wanted.
    get stress() {
      if (!BuildContainer.onePerSource(this.room)) return 1;
      const containers = this.room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER }) as StructureContainer[];
      const cap = containers.reduce((a, c) => a + c.store.getCapacity(RESOURCE_ENERGY), 0);
      const used = containers.reduce((a, c) => a + c.store[RESOURCE_ENERGY], 0);
      const fullness = cap > 0 ? used / cap : 0;
      return Math.max(CONTAINER_REPEAT_STRESS, fullness);
    }
    get content() { return { [RESOURCE_ENERGY]: CONTAINER_VALUE }; }
    get costs() { return { [RESOURCE_ENERGY]: CONSTRUCTION_COST[STRUCTURE_CONTAINER] }; }
    
    // Checkerboard tile ringed around the neediest source (alternates across sources), near it but not
    // directly adjacent — so miners reach it fast.
    place(): void {
      if (this.target) return; // one container site at a time
      const sources = this.room.find(FIND_SOURCES);
      if (!sources.length) return;
      const source = sources.reduce((a, b) => BuildContainer.near(this.room, a) <= BuildContainer.near(this.room, b) ? a : b);
      if (BuildContainer.near(this.room, source) >= CONTAINERS_PER_SOURCE) return;

      const terrain = this.room.getTerrain();
      for (let dx = -CONTAINER_RANGE; dx <= CONTAINER_RANGE; dx++) {
        for (let dy = -CONTAINER_RANGE; dy <= CONTAINER_RANGE; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) < 2) continue; // around it, not directly next to the source
          const x = source.pos.x + dx, y = source.pos.y + dy;
          if (x < 1 || x > 48 || y < 1 || y > 48) continue;
          if ((x + y) % 2 !== 0) continue; // checkerboard, like extensions
          if (terrain.get(x, y) & TERRAIN_MASK_WALL) continue;
          if (this.room.lookForAt(LOOK_STRUCTURES, x, y).length) continue;
          if (this.room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length) continue;
          if (this.room.createConstructionSite(x, y, STRUCTURE_CONTAINER) === OK) return;
        }
      }
    }
  }

  // Build a defensive tower once the first container per source exists (container mode) and the RCL allows
  // one. Placed on a checkerboard tile directly adjacent to a spawn (the inner ring), same pattern as the
  // extensions so it doesn't block the road grid. Prefer one tower per spawn first (high stress); extra
  // towers are optional polish (low stress), like the repeat containers.
  export class BuildTower extends Build {
    constructor(room: Room) { super(room, 'StructureTower');}
    get structureType() { return STRUCTURE_TOWER; }

    // Finished towers adjacent (range 1) to a spawn.
    private static builtNear(room: Room, spawn: StructureSpawn): number {
      return room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER && s.pos.inRangeTo(spawn, 1) }).length;
    }
    // Built + queued towers adjacent to a spawn (so we don't double-queue while one is mid-build).
    private static near(room: Room, spawn: StructureSpawn): number {
      return BuildTower.builtNear(room, spawn)
        + room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === STRUCTURE_TOWER && s.pos.inRangeTo(spawn, 1) }).length;
    }
    // Total towers (built + queued) in the room.
    private static count(room: Room): number {
      return room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER }).length
        + room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === STRUCTURE_TOWER }).length;
    }
    static onePerSpawn(room: Room): boolean {
      const spawns = room.find(FIND_MY_SPAWNS);
      return spawns.length > 0 && spawns.every(sp => BuildTower.builtNear(room, sp) >= 1);
    }
    // No more towers allowed at this controller level → the goal can't progress, so don't offer it.
    static atCap(room: Room): boolean {
      return BuildTower.count(room) >= (CONTROLLER_STRUCTURES[STRUCTURE_TOWER][room.controller!.level] ?? 0);
    }

    // High until every spawn has its first tower; after that extra towers are low priority.
    get stress() { return BuildTower.onePerSpawn(this.room) ? TOWER_REPEAT_STRESS : 1; }
    get content() { return { [RESOURCE_ENERGY]: TOWER_VALUE }; }
    get costs() { return { [RESOURCE_ENERGY]: CONSTRUCTION_COST[STRUCTURE_TOWER] }; }

    // Checkerboard tile adjacent to the spawn that currently has the fewest towers — so we hand out the
    // first tower per spawn before stacking extras on any one spawn.
    place(): void {
      if (this.target) return;             // one tower site at a time
      if (BuildTower.atCap(this.room)) return;
      const spawns = this.room.find(FIND_MY_SPAWNS).sort((a, b) => BuildTower.near(this.room, a) - BuildTower.near(this.room, b));
      const terrain = this.room.getTerrain();
      for (const spawn of spawns) {
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          const x = spawn.pos.x + dx, y = spawn.pos.y + dy;
          if (x < 2 || x > 47 || y < 2 || y > 47) continue;
          if ((x + y) % 2 !== 0) continue; // checkerboard, like extensions → keeps the road grid open
          if (terrain.get(x, y) & TERRAIN_MASK_WALL) continue;
          if (this.room.lookForAt(LOOK_STRUCTURES, x, y).length) continue;
          if (this.room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length) continue;
          if (this.room.createConstructionSite(x, y, STRUCTURE_TOWER) === OK) return;
        }
      }
    }
  }

  // Build a road network once towers are up. Each instance covers a tile-set — a spawn→target path (built
  // along plains where possible) or the spawn's checkerboard movement lanes — and is complete when every
  // buildable tile on it carries a road. Low priority, so it never starves the economy.
  export class BuildRoad extends Build {
    private constructor(room: Room, private label: string, private compute: () => RoomPosition[], private priority: number) {
      super(room, `Road ${label}`);
    }
    // A road along the (plains-preferring) path from `from` to `to`.
    static path(room: Room, label: string, from: RoomPosition, to: RoomPosition, priority: number) {
      return new BuildRoad(room, label, () => roadPath(room, from, to), priority);
    }
    // Pave the spawn's reverse-checkerboard movement lanes, so creeps cross the structure field faster.
    static fill(room: Room, spawn: RoomPosition, priority: number) {
      return new BuildRoad(room, 'fill', () => fillRoadTiles(room, spawn), priority);
    }
    // A road toward a point that may be in another room — paves the whole route, both rooms (remote tiles
    // only get sites while we have vision there).
    static toward(room: Room, label: string, from: RoomPosition, to: RoomPosition, priority: number) {
      return new BuildRoad(room, label, () => remoteRoadTiles(from, to), priority);
    }

    get structureType() { return STRUCTURE_ROAD; }
    private get tiles() { return cachedRoadTiles(`${this.room.name}|${this.label}`, this.compute); }
    get stress() { return this.priority; }
    get content() { return { [RESOURCE_ENERGY]: ROAD_VALUE }; }
    get costs() { return { [RESOURCE_ENERGY]: CONSTRUCTION_COST[STRUCTURE_ROAD] }; }

    // Per-tile status — works across rooms (a remote tile we can't currently see is 'skip', since we can't
    // verify or build it): 'done' a road is built, 'pending' a road site is queued, 'todo' empty & buildable,
    // 'skip' a wall / non-road structure or site / no-vision.
    private state(p: RoomPosition): 'done' | 'pending' | 'todo' | 'skip' {
      if (Game.map.getRoomTerrain(p.roomName).get(p.x, p.y) & TERRAIN_MASK_WALL) return 'skip';
      const room = Game.rooms[p.roomName];
      if (!room) return 'skip'; // no vision → can't see/build it right now
      const structs = room.lookForAt(LOOK_STRUCTURES, p);
      if (structs.some(s => s.structureType === STRUCTURE_ROAD)) return 'done';
      if (structs.length) return 'skip';
      const sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, p);
      if (sites.some(s => s.structureType === STRUCTURE_ROAD)) return 'pending';
      if (sites.length) return 'skip';
      return 'todo';
    }

    isComplete(): boolean {
      return this.tiles.every(p => { const s = this.state(p); return s === 'done' || s === 'skip'; });
    }
    // Queue road sites on every still-empty tile of the route, in that tile's room (idempotent; re-run each
    // tick so the rest get placed as the site cap frees and as remote rooms come into vision).
    place(): void {
      for (const p of this.tiles) if (this.state(p) === 'todo') Game.rooms[p.roomName]?.createConstructionSite(p, STRUCTURE_ROAD);
    }
  }

  // Build a spawn in a freshly-claimed room (optional but high-stress: a room is inert until it has one).
  // Placed at the best resource-adjacent tile; built by a remote worker we send over.
  export class BuildSpawn extends Build {
    constructor(room: Room) { super(room, 'StructureSpawn'); }
    get structureType() { return STRUCTURE_SPAWN; }
    get stress() { return 1; }
    get content() { return { [RESOURCE_ENERGY]: SETTLE_VALUE }; } // makes the whole room productive
    get costs() { return { [RESOURCE_ENERGY]: CONSTRUCTION_COST[STRUCTURE_SPAWN] }; }
    place(): void {
      if (this.room.find(FIND_MY_SPAWNS).length || this.target) return; // already have one / site placed
      const pos = Unit.bestSpawnPos(this.room);
      if (pos) this.room.createConstructionSite(pos, STRUCTURE_SPAWN);
    }
  }

  // Economy: keep a single roaming MOVE-creep scout out. No target (like SpawnWorker) so it competes
  // in the pick without affecting the upgrade/build logic. Stress rises as frontier data goes stale or
  // missing, and collapses to near-zero once a scout already exists (so we keep at most ~one).
  export class Scout extends Economy {
    constructor(room: Room) { super(room, 'Scout'); }
    get content() { return { [RESOURCE_ENERGY]: SCOUT_VALUE }; }
    get stress() {
      if (scoutExists()) return SCOUT_REPEAT_STRESS;
      const scout = scoutMemory();
      const frontier = Unit.Scout.frontierRooms();
      if (!frontier.length) return SCOUT_REPEAT_STRESS;
      const oldest = Math.max(...frontier.map(n => scout[n] ? Game.time - scout[n].ts : Infinity));
      return Math.min(1, oldest / SCOUT_STALE_TICKS); // older / missing ⇒ higher
    }
  }
}

namespace Unit {
  // Robust multi-room travel: follow Game.map.findRoute room-by-room so creeps can reach rooms
  // several hops away (e.g. the frontier around a distant owned room), not just adjacent ones.
  // Road-preferring cost matrix per room (cached per tick): roads cost 1 so travel hugs them where they
  // exist, impassable structures are blocked. Only sees roads in rooms we currently have vision of.
  const roadCmCache: Record<string, { tick: number; cm: CostMatrix }> = {};
  function roadCostMatrix(roomName: string): CostMatrix {
    const c = roadCmCache[roomName];
    if (c && c.tick === Game.time) return c.cm;
    const cm = new PathFinder.CostMatrix();
    const room = Game.rooms[roomName];
    if (room) for (const s of room.find(FIND_STRUCTURES)) {
      if (s.structureType === STRUCTURE_ROAD) cm.set(s.pos.x, s.pos.y, 1);
      else if (s.structureType !== STRUCTURE_CONTAINER && s.structureType !== STRUCTURE_RAMPART) cm.set(s.pos.x, s.pos.y, 255);
    }
    roadCmCache[roomName] = { tick: Game.time, cm };
    return cm;
  }
  const ROAD_MOVE = { reusePath: 20, costCallback: (rn: string, _cm: CostMatrix) => roadCostMatrix(rn) };

  export function travel(creep: Creep, roomName: string, color: string = '#ffffff'): void {
    if (creep.room.name === roomName) {
      creep.moveTo(new RoomPosition(25, 25, roomName), { range: 20, reusePath: 10, costCallback: (rn) => roadCostMatrix(rn) });
      return;
    }
    const route = Game.map.findRoute(creep.room.name, roomName);
    if (route === ERR_NO_PATH || route.length === 0) {
      creep.moveTo(new RoomPosition(25, 25, roomName), { reusePath: 20 }); // fallback
      return;
    }
    const exit = creep.pos.findClosestByPath(route[0].exit);
    creep.moveTo(exit ?? new RoomPosition(25, 25, route[0].room), { ...ROAD_MOVE, visualizePathStyle: { stroke: color } });
  }

  // The largest body the budget affords: a one-off `lead` followed by as many copies of the repeating
  // `unit` (the "combo") as fit, never below `min` units and never past MAX_CREEP_SIZE parts.
  export function bestAffordable(lead: BodyPartConstant[], unit: BodyPartConstant[], budget: number, min = 1) {
    const cost = (parts: BodyPartConstant[]) => parts.reduce((sum, p) => sum + BODY_COSTS[p], 0);
    const leadCost = cost(lead), unitCost = cost(unit);
    const maxUnits = Math.floor((MAX_CREEP_SIZE - lead.length) / unit.length);
    const units = Math.max(min, Math.min(maxUnits, Math.floor((budget - leadCost) / unitCost)));
    return { body: [...lead, ...Array.from({ length: units }, () => unit).flat()], cost: leadCost + units * unitCost };
  }

  // Miner/builder: a single CARRY (so it always has exactly 1 — that's what marks it a worker, not a
  // hauler) plus as many [WORK,MOVE] as the budget affords.
  export const bestAffordableWorker = (budget: number) => bestAffordable([CARRY], [WORK, MOVE], budget);
  // Hauler. Off-road it needs 1 MOVE per [WORK,CARRY] (no fatigue when full) → [WORK,CARRY,MOVE,MOVE].
  // But on a road the per-part cost halves (2→1), so one MOVE per unit ([WORK,CARRY,MOVE]) already moves
  // it every tick when loaded — half the MOVE, more CARRY for the same energy. `roaded` switches to that
  // body once the haul-loop roads are built. Either way min 2 units ⇒ ≥2 CARRY, so isTransporter holds.
  export const bestTransporter = (budget: number, roaded = false) =>
    bestAffordable([], roaded ? [WORK, CARRY, MOVE] : [WORK, CARRY, MOVE, MOVE], budget, 2);

  // --- shared selection helpers (operate over the module `goals`) ---

  // `ignore`: treat that creep's own tile as free — so a creep already standing on a mining tile doesn't see
  // its own body as blocking the source (which would make it think the spot is taken and leave it unmined).
  // `ignoreStandins`: also treat tiles held by stand-in transporters as free — a real miner uses this to
  // reclaim a tile from a stand-in (which yields the moment a miner targets its source).
  function availableSpacesAround(target: { room: Room | undefined, pos: RoomPosition }, ignore?: Creep, ignoreStandins = false): number {
    const room = target.room;
    if (!room) return 0;
    const { x, y } = target.pos;
    const tiles = room.lookForAtArea(LOOK_TERRAIN, y - 1, x - 1, y + 1, x + 1, true);
    return tiles.filter(t => {
      if (t.terrain === 'wall') return false;
      if (t.x === x && t.y === y) return false;
      const blocked = room.lookForAt(LOOK_STRUCTURES, t.x, t.y).some(s =>
        s.structureType !== STRUCTURE_CONTAINER && s.structureType !== STRUCTURE_ROAD &&
        (s.structureType !== STRUCTURE_RAMPART || !(s as StructureRampart).my));
      if (blocked) return false;
      const here = room.lookForAt(LOOK_CREEPS, t.x, t.y);
      return here.every(c => c.id === ignore?.id || (ignoreStandins && isTransporter(c) && !!c.memory.mining));
    }).length;
  }

  function pickResource(room: Room, pos?: RoomPosition, includeEmpty = false, ignore?: Creep, ignoreStandins = false): Source | Mineral | undefined {
    // Among resources with room to mine, take the CLOSEST reachable one — proximity beats urgency here,
    // so a worker doesn't walk past a free source to a farther one. Normally only stocked resources
    // qualify; `includeEmpty` (container mode) also lets a miner head to a depleted source to wait there,
    // primed for when it regenerates.
    const candidates = goals
      .filter(g => g instanceof Goal.MineEnergy || g instanceof Goal.MineMineral)
      .map(g => g.target as Source | Mineral)
      .filter(t => availableSpacesAround(t, ignore, ignoreStandins) !== 0)
      .filter(t => includeEmpty || (t instanceof Source ? t.energy > 0 : (t as Mineral).mineralAmount > 0));

    if (!pos) return candidates[0];
    return pos.findClosestByPath(candidates, { ignoreCreeps: true }) ?? undefined;
  }

  export abstract class Obj {
    constructor(public self: Creep) { }
    abstract loop(): void
  }
  
  export class Worker extends Obj {
    protected get carrying(): ResourceConstant | undefined {
      for (const r in this.self.store) if ((this.self.store as any)[r] !== 0) return r as ResourceConstant;
      return undefined;
    }

    loop() {
      if (this.goHome()) return;
      if (this.remoteMine()) return; // before returnHome: a remote miner is in an unowned room on purpose
      if (this.returnHome()) return;
      this.gather();
    }

    // The built container next to our remote source (needs vision — i.e. we're in the room).
    private remoteContainer(srcId: Id<Source>): StructureContainer | undefined {
      const src = Game.getObjectById(srcId);
      if (!src) return undefined;
      return src.pos.findInRange(FIND_STRUCTURES, CONTAINER_RANGE, { filter: s => s.structureType === STRUCTURE_CONTAINER })[0] as StructureContainer | undefined;
    }

    // Once a road has reached the remote source, drop a container site next to it (the miners build it via
    // buildAlong). After it's built, miners stop hauling home and just feed it; transporters drain it.
    private ensureRemoteContainer(source: Source): void {
      const room = source.room!;
      if (source.pos.findInRange(FIND_STRUCTURES, CONTAINER_RANGE, { filter: s => s.structureType === STRUCTURE_CONTAINER }).length) return;
      if (source.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, CONTAINER_RANGE, { filter: s => s.structureType === STRUCTURE_CONTAINER }).length) return;
      if (!source.pos.findInRange(FIND_STRUCTURES, CONTAINER_RANGE + 1, { filter: s => s.structureType === STRUCTURE_ROAD }).length) return; // wait for the road
      const terrain = room.getTerrain();
      const wall = (x: number, y: number) => x < 0 || x > 49 || y < 0 || y > 49 || (terrain.get(x, y) & TERRAIN_MASK_WALL) !== 0;
      const free = (x: number, y: number) => x >= 1 && x <= 48 && y >= 1 && y <= 48 && !wall(x, y)
        && room.lookForAt(LOOK_STRUCTURES, x, y).length === 0 && room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length === 0;
      // Pass 1 — a free tile directly adjacent to the source (miner stands on it). Pass 2 (hemmed-in source:
      // its only adjacent tile is taken, e.g. by the road) — a free tile at range 2 that shares a walkable
      // neighbour with the source, so a miner standing on that one tile can harvest AND feed the container.
      for (let range = 1; range <= CONTAINER_RANGE; range++) {
        for (let dx = -range; dx <= range; dx++) for (let dy = -range; dy <= range; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== range) continue;
          const x = source.pos.x + dx, y = source.pos.y + dy;
          if (!free(x, y)) continue;
          // Reachable if a miner can stand on this tile itself (it's adjacent to the source → harvest + drop
          // in place), OR there's a walkable tile adjacent to BOTH it and the source to stand on.
          let standable = source.pos.isNearTo(x, y);
          for (let sx = -1; sx <= 1 && !standable; sx++) for (let sy = -1; sy <= 1 && !standable; sy++) {
            const mx = x + sx, my = y + sy;
            standable = !(mx === x && my === y) && !wall(mx, my) && source.pos.isNearTo(mx, my);
          }
          if (standable && room.createConstructionSite(x, y, STRUCTURE_CONTAINER) === OK) return;
        }
      }
    }

    // Remote MINER: travel out, mine, and once a container exists feed it (static); before that (or when it's
    // full) haul the load home ourselves. A transporter-bodied remote creep instead hauls (remoteHaul).
    private remoteMine(): boolean {
      const creep = this.self;
      const r = creep.memory.remote;
      if (!r) return false;
      if (isTransporter(creep)) return this.remoteHaul(r);
      if (this.buildAlong() === 'move') return true; // detouring to a road/container site → let it finish before mining

      const inRoom = creep.room.name === r.room;
      const container = inRoom ? this.remoteContainer(r.src) : undefined;
      if (container) remoteContSeen()[r.src] = Game.time; // tell the spawn loop a container exists here

      // Carrying a load and full (or mid-delivery) → feed the container if there's room, else haul home.
      if ((creep.store[RESOURCE_ENERGY] ?? 0) > 0 && (creep.store.getFreeCapacity() === 0 || creep.memory.deliver_target)) {
        if (container && container.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
          if (creep.transfer(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.moveTo(container, { visualizePathStyle: { stroke: '#ffaa00' } });
          return true;
        }
        if (creep.room.name !== r.home) { travel(creep, r.home); return true; }
        this.remoteDeliver();
        return true;
      }
      // Otherwise go mine the source.
      creep.memory.deliver_target = undefined;
      if (!inRoom) { travel(creep, r.room, '#ffaa00'); return true; }
      const source = Game.getObjectById(r.src);
      if (!source) return true;
      this.ensureRemoteContainer(source);
      if (creep.pos.isNearTo(source)) creep.harvest(source);
      else creep.moveTo(source, { visualizePathStyle: { stroke: '#ffaa00' } });
      return true;
    }

    // Remote HAULER: shuttle the remote container's energy home (prefers roads via travel()).
    private remoteHaul(r: { src: Id<Source>; room: string; home: string }): boolean {
      const creep = this.self;
      // Haulers build AND repair the route as they pass — worst-off (lowest %) first, in one work-action.
      if (this.maintain() === 'move') return true; // detouring to finish an off-path site → before hauling
      if ((creep.store[RESOURCE_ENERGY] ?? 0) > 0 && (creep.store.getFreeCapacity() === 0 || creep.memory.deliver_target)) {
        if (creep.room.name !== r.home) { travel(creep, r.home); return true; }
        this.remoteDeliver();
        return true;
      }
      creep.memory.deliver_target = undefined;
      if (creep.room.name !== r.room) { travel(creep, r.room, '#ffaa00'); return true; }
      const container = this.remoteContainer(r.src);
      if (container) remoteContSeen()[r.src] = Game.time;
      if (!container || (container.store[RESOURCE_ENERGY] ?? 0) === 0) return true; // nothing to haul yet → wait
      if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.moveTo(container, { visualizePathStyle: { stroke: '#ffaa00' } });
      return true;
    }

    // Deliver a remote load into the closest home container (else spawn/extension). NO gather() fallback —
    // a remote miner must never start mining a HOME source (that local-mining moveTo fights the trip back
    // to the remote room at the boundary and makes it bounce between rooms).
    private remoteDeliver(): void {
      const creep = this.self;
      const sink = creep.pos.findClosestByPath(creep.room.find(FIND_STRUCTURES, {
        filter: s => (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION)
          && ((s as StructureContainer).store.getFreeCapacity(RESOURCE_ENERGY) ?? 0) > 0,
      }) as (StructureContainer | StructureSpawn | StructureExtension)[]);
      if (!sink) { creep.memory.deliver_target = undefined; return; } // nowhere to put it → hold
      creep.memory.deliver_target = sink.id;
      if (creep.transfer(sink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.moveTo(sink, { visualizePathStyle: { stroke: '#ffffff' } });
    }

    // While carrying a load, build a road OR container construction site we pass — UNLESS we're about to
    // harvest (build and harvest are both work-actions, only one per tick). build is a separate intent from
    // MOVE, so it doesn't slow the trip. This is what actually constructs the remote-room road and the
    // source container (home transporters never go there). A one-off chunk of the load pays for it.
    // 'move' = stepped toward a far site (caller yields), 'build' = built in place (used the tick's
    // work-action — caller must NOT also repair), 'none' = nothing to build.
    private buildAlong(): 'move' | 'build' | 'none' {
      const creep = this.self;
      if ((creep.store[RESOURCE_ENERGY] ?? 0) === 0) return 'none'; // need energy to build
      const src = creep.memory.remote && Game.getObjectById(creep.memory.remote.src);
      if (src && creep.pos.isNearTo(src) && creep.store.getFreeCapacity() > 0) return 'none'; // will harvest this tick → don't build
      const site = creep.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 10, { // wide sight so a passing creep still reaches sites off its path
        filter: s => s.structureType === STRUCTURE_ROAD || s.structureType === STRUCTURE_CONTAINER,
      })[0];
      if (!site) return 'none';
      // Within build range (3) → build it while the trip continues (build is a separate intent from MOVE).
      // Farther → step over to it to build (yields the tick's movement so the trip waits briefly).
      if (creep.build(site) === ERR_NOT_IN_RANGE) { creep.moveTo(site, { visualizePathStyle: { stroke: '#0000ff' } }); return 'move'; }
      return 'build';
    }

    // On the way back, maintain the route in ONE step: do the WORST-OFF road/container within work-range —
    // a construction site scored by build %, a damaged structure by hits % — lowest % first (so an unbuilt
    // gap, then the most-worn structure). build and repair are both work-actions, so this picks exactly one,
    // which is why a separate repair pass kept losing to building. Only when nothing's in range does it
    // detour to an off-path site to finish constructing the route.
    // 'move' = detouring (caller yields), 'work' = built/repaired in place, 'none' = nothing to do.
    private maintain(): 'move' | 'work' | 'none' {
      const creep = this.self;
      if ((creep.store[RESOURCE_ENERGY] ?? 0) === 0) return 'none'; // need energy to build/repair
      const src = creep.memory.remote && Game.getObjectById(creep.memory.remote.src);
      if (src && creep.pos.isNearTo(src) && creep.store.getFreeCapacity() > 0) return 'none'; // will harvest this tick
      const isRC = (t: StructureConstant) => t === STRUCTURE_ROAD || t === STRUCTURE_CONTAINER;
      let best: ConstructionSite | Structure | undefined, bestPct = Infinity, build = false;
      for (const cs of creep.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 3, { filter: s => isRC(s.structureType) })) {
        const p = cs.progress / cs.progressTotal; if (p < bestPct) { bestPct = p; best = cs; build = true; }
      }
      for (const st of creep.pos.findInRange(FIND_STRUCTURES, 3, { filter: s => isRC(s.structureType) && s.hits < s.hitsMax })) {
        const p = st.hits / st.hitsMax; if (p < bestPct) { bestPct = p; best = st; build = false; }
      }
      if (best) { if (build) creep.build(best as ConstructionSite); else creep.repair(best as Structure); return 'work'; }
      const site = creep.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 10, { filter: s => isRC(s.structureType) })[0];
      if (site) { creep.moveTo(site, { visualizePathStyle: { stroke: '#0000ff' } }); return 'move'; }
      return 'none';
    }

    // Remote builder: travel to and live in the claimed room we're assigned to, until it has a spawn
    // (then we're released and just become a local worker there). In-room, normal gather→build applies.
    private goHome(): boolean {
      const creep = this.self;
      const home = creep.memory.home;
      if (!home) return false;
      if (Game.rooms[home]?.find(FIND_MY_SPAWNS).length) { creep.memory.home = undefined; return false; } // spawn up → released
      if (creep.room.name !== home) { travel(creep, home); return true; }
      return false; // arrived → fall through to gather/deliver (mines local sources, builds the spawn)
    }

    // Stuck in a room we don't own → walk back to the nearest spawn.
    private returnHome(): boolean {
      const creep = this.self;
      if (creep.room.controller?.my) return false;
      const spawn = Object.values(Game.spawns).sort((a, b) =>
        Game.map.getRoomLinearDistance(creep.room.name, a.room.name) - Game.map.getRoomLinearDistance(creep.room.name, b.room.name))[0];
      if (spawn) creep.moveTo(spawn, { visualizePathStyle: { stroke: '#ffffff' }, reusePath: 20 });
      return true;
    }

    // Container mode with no transporters: a worker may stand in as a hauler — withdraw from a source
    // container and (in deliver()) carry it to the economic goal instead of mining. The choice is rolled
    // once per empty trip and committed via memory.hauling so we don't flip-flop mid-approach. Returns
    // true if it took over the creep's action this tick.
    private tryHaul(): boolean {
      const creep = this.self;
      if (!containerMode(creep.room)) return false;
      if (creep.room.find(FIND_MY_CREEPS, { filter: isTransporter }).length > 0) return false; // real haulers exist

      if (!creep.memory.hauling) {
        if (this.carrying !== undefined) return false; // only decide while empty
        if (Math.random() >= WORKER_HAUL_CHANCE) return false; // this trip we mine
        creep.memory.hauling = true;
      }

      const container = creep.pos.findClosestByPath(creep.room.find(FIND_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_CONTAINER && (s as StructureContainer).store[RESOURCE_ENERGY] > 0,
      }) as StructureContainer[]);
      if (container) {
        if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.moveTo(container, { visualizePathStyle: { stroke: '#ffaa00' } });
        return true;
      }
      // No container has energy: deliver whatever we already grabbed; if empty, abort and go mine.
      if (this.carrying !== undefined) { this.deliver(); return true; }
      creep.memory.hauling = undefined;
      return false;
    }

    private gather() {
      const creep = this.self;
      const carrying = this.carrying;
      if (creep.store.getFreeCapacity(carrying) === 0) return this.deliver();
      // Mid-delivery (depositing or building) → stay in deliver() until empty.
      if (creep.memory.deliver_target) return this.deliver();

      this.acquire(); // how we get energy (mine, or — for a Transporter — withdraw from a container)
    }

    // A miner gets energy by harvesting the closest source (optionally standing in as a hauler first).
    // Transporter overrides this to withdraw from a container instead.
    protected acquire() {
      const creep = this.self;

      // Container mode but no transporters yet → a worker may stand in as a hauler this trip.
      if (this.tryHaul()) return;
      creep.memory.hauling = undefined; // not hauling → we mine this trip

      // In container mode miners are static: a miner keeps its assigned source even when it's momentarily
      // empty, staying parked beside it so it's primed to harvest the instant it regenerates (rather than
      // wandering off to another source and leaving this one — and its container — uncovered).
      const sticky = containerMode(creep.room);

      // Carrying a load while our source is empty → ferry it out now (deliver() routes it to a
      // non-container) rather than trekking back to the dead source to stand on it.
      const assigned = creep.memory.target && Game.getObjectById(creep.memory.target);
      if (this.carrying === RESOURCE_ENERGY && sticky && assigned instanceof Source && assigned.energy === 0) return this.deliver();

      // Already next to our source? Just harvest it — don't re-pick. We stay while it has energy, or
      // (container mode) even while it's empty, so we don't get pushed off our spot.
      // (availableSpacesAround counts our own tile as taken and would otherwise push us off it.)
      const current = creep.memory.target && Game.getObjectById(creep.memory.target);
      if (current && creep.pos.isNearTo(current) && (current.energy > 0 || sticky)) { this.mineOrFerry(current); return; }

      // Otherwise pick a source: in container mode keep our (possibly empty) assignment — but only while
      // it still has a free mining tile; if it's boxed in (all spots taken), re-pick like normal. Else
      // take the closest source that still has energy and room.
      // ignoreStandins: a real miner outranks stand-in transporters for a tile — it can target a source a
      // stand-in is sitting on, and that stand-in yields the moment we're assigned (sourceHasRealMiner).
      const source = sticky && current instanceof Source && availableSpacesAround(current, creep, true) > 0
        ? current
        : pickResource(creep.room, creep.pos, sticky, creep, true); // container mode → may target an empty source to wait at it
      creep.memory.target = source?.id as Id<Source> | undefined;
      if (!source) return;

      // Move on an explicit range check, NOT harvest()'s return code: an empty source returns
      // ERR_NOT_ENOUGH_RESOURCES (not ERR_NOT_IN_RANGE), so relying on that would leave the miner
      // standing short of it. Approaching anyway makes it occupy a mining tile, so availableSpacesAround
      // counts the source as taken and other miners head to a different (e.g. just-regenerated) source.
      if (creep.pos.isNearTo(source)) this.mineOrFerry(source);
      else creep.moveTo(source, { visualizePathStyle: { stroke: '#ffaa00' } });
    }

    // Harvest the target if it has stock. If it's an EMPTY source, rather than idle, ferry energy from a
    // container to a non-container (handled below) instead — falling back to just parking, primed for the
    // source's regen, when there's no ferry work to do.
    private mineOrFerry(target: Source | Mineral) {
      const empty = target instanceof Source ? target.energy === 0 : (target as Mineral).mineralAmount === 0;
      if (empty && target instanceof Source && this.ferryWhileIdle()) return;
      this.self.harvest(target);
    }

    // Idle at an empty source → be productive: pick up energy from a container so we can ferry it to a
    // spawn / extension / tower (the delivery itself — never to a container or the controller — happens
    // in deliver()'s source-empty branch). Only bother when there's somewhere non-container to deliver
    // and a container with energy to take. Returns true if it found ferry work; false → just park.
    private ferryWhileIdle(): boolean {
      const creep = this.self;
      if (!this.closestFillable(false)) return false; // nowhere to deliver → just park, primed for regen

      const container = creep.pos.findClosestByPath(creep.room.find(FIND_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_CONTAINER && (s as StructureContainer).store[RESOURCE_ENERGY] > 0,
      }) as StructureContainer[]);
      if (!container) return false; // nothing to ferry → park
      if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.moveTo(container, { visualizePathStyle: { stroke: '#ffaa00' } });
      return true;
    }

    // Whether a full creep should drop its load into a source container (miner behaviour). A Transporter
    // overrides this to false — it withdrew FROM a container, so it carries the energy onward instead.
    protected wantsContainerDrop(): boolean { return containerMode(this.self.room) && !this.self.memory.hauling; }

    // Closest thing that still needs energy: spawn / extension / tower, plus (with includeContainers — for
    // a container-mode miner just dumping its load) containers. The source container is normally adjacent,
    // so it wins; if it's full, the next-closest sink is used.
    protected closestFillable(includeContainers = false): StructureSpawn | StructureExtension | StructureTower | StructureContainer | null {
      // FIND_STRUCTURES (not MY) so unowned containers are visible; spawn/ext/tower in our room are ours.
      return this.self.pos.findClosestByPath(this.self.room.find(FIND_STRUCTURES, {
        filter: s => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION || s.structureType === STRUCTURE_TOWER
          || (includeContainers && s.structureType === STRUCTURE_CONTAINER))
          && ((s as StructureContainer).store.getFreeCapacity(RESOURCE_ENERGY) ?? 0) > 0,
      }) as (StructureSpawn | StructureExtension | StructureTower | StructureContainer)[]);
    }

    // Where a plain energy load goes (no build goal, not a container drop). Worker = miner economics:
    // fill spawn/extensions to enable more miners while the sources still have room, divert to the
    // controller only once they're saturated (UPGRADE_DEDICATION), and never idle a load. A Transporter
    // overrides this — it should NOT run the worker-first dance (that's why haulers kept going "home" to
    // a spawn instead of upgrading); it just fills then upgrades.
    protected energyTarget(controller: StructureController | undefined): StructureController | StructureSpawn | StructureTower | StructureExtension | StructureContainer | null {
      const creep = this.self;
      const held = creep.memory.deliver_target ? Game.getObjectById(creep.memory.deliver_target) : null;
      if (!held) creep.memory.deliver_target = undefined; // stale → re-decide

      // Upgrading is held off while any economic goal still wants energy first (extensions to build,
      // first containers, …) — i.e. any non-ignored Economy goal for this room.
      const blocked = goals.some(g => g.room.name === creep.room.name && g instanceof Goal.Economy && !g.ignoredBeforeUpgrade);

      let target: StructureController | StructureSpawn | StructureTower | StructureExtension | StructureContainer | null = null;
      if (!blocked) {
        // Workers first: while we're still ≥WORKER_FIRST_SPOTS miners short of fully mining the sources
        // (room for another harvester to be worthwhile), always fill so a worker can be made. Only once the
        // sources are saturated does the UPGRADE_DEDICATION roll divert a load to the controller.
        const spots = workerTarget(creep.room) - creep.room.find(FIND_MY_CREEPS, { filter: isLocalWorker }).length;

        if (held instanceof StructureController) target = held;
        else if (spots >= WORKER_FIRST_SPOTS) target = this.closestFillable();
        else if (!creep.memory.deliver_target && Math.random() < UPGRADE_DEDICATION && controller) target = controller;
        else target = this.closestFillable() ?? controller ?? null;
      } else {
        // Something still wants energy first → always fill spawn/extensions (grow), never upgrade.
        target = this.closestFillable();
      }
      // Never idle a load → default to upgrading the controller.
      return target ?? controller ?? null;
    }

    private deliver() {
      const creep = this.self;
      const carrying = this.carrying;
      if (carrying === undefined) { creep.memory.deliver_target = undefined; creep.memory.hauling = undefined; creep.memory.building = undefined; return this.gather(); }

      const controller = creep.room.controller?.my ? creep.room.controller : undefined;
      const econ = economicGoal[creep.room.name]?.[RESOURCE_ENERGY];

      let target: ConstructionSite | StructureController | StructureSpawn | StructureTower | StructureExtension | StructureContainer | null = null;

      // What this creep COULD build: the room's current Build goal — except a container-mode miner only
      // builds its own further containers (transporters/stand-in haulers do the rest of the construction).
      const buildTarget = econ instanceof Goal.Build && econ.target && (!this.wantsContainerDrop() || econ instanceof Goal.BuildContainer)
        ? econ.target : null;
      // Decide once per fresh load whether to spend it building: BUILD_DEDICATION of loads go to
      // construction, the rest to filling / worker-creation / upgrading — so building never monopolises the
      // builders (and a long road can't stall the economy). Sticky for the load via memory.building.
      if (!creep.memory.deliver_target) creep.memory.building = !!buildTarget && Math.random() < BUILD_DEDICATION;

      if (buildTarget && creep.memory.building) {
        target = buildTarget;
      } else if (carrying === RESOURCE_ENERGY && this.wantsContainerDrop()) {
        const src = creep.memory.target && Game.getObjectById(creep.memory.target);
        const sourceEmpty = src instanceof Source && src.energy === 0;
        // Container-mode miner. Normally: just drop into the CLOSEST sink (the adjacent source container
        // usually wins; if full, the nearest container/spawn/extension/tower), or upgrade if all full.
        // But while OUR source is empty we're in "idle ferry" mode: move energy OUT to the closest
        // non-container (spawn/extension/tower) — never back into a container, never the controller.
        target = sourceEmpty
          ? this.closestFillable(false)
          : (this.closestFillable(true) ?? controller ?? null);
      } else if (carrying === RESOURCE_ENERGY) {
        target = this.energyTarget(controller);
      }

      if (!target) { creep.memory.deliver_target = undefined; return; }
      creep.memory.deliver_target = target.id;

      // The target's type discerns the action.
      if (target instanceof ConstructionSite) {
        if (creep.build(target) === ERR_NOT_IN_RANGE) creep.moveTo(target, { visualizePathStyle: { stroke: '#0000ff' } });
      } else if (target instanceof StructureController) {
        if (creep.upgradeController(target) === ERR_NOT_IN_RANGE) creep.moveTo(target, { visualizePathStyle: { stroke: '#00CC00' } });
      } else {
        if (creep.transfer(target, carrying) === ERR_NOT_IN_RANGE) creep.moveTo(target, { visualizePathStyle: { stroke: '#ffffff' } });
      }
    }
  }

  // A hauler: withdraws from source containers and carries energy onward — building the current Build
  // goal, topping up spawn/extensions/towers, or upgrading the controller (its single WORK part). It's a
  // Worker that only differs in where it gets energy (containers, not mining) and that it never drops a
  // load back into a container; everything else — including the whole deliver() decision — is shared.
  export class Transporter extends Worker {
    loop() {
      // Decide stand-in for EVERY transporter, dedicated shuttles included: when real miners are short there's
      // nothing feeding the containers, so a shuttle that just waits at its dry container would stall the whole
      // economy. Only when NOT standing in does a dedicated shuttle run its ferry; everyone else uses the
      // shared Worker loop (→ acquire → standInMine when mining, else withdraw-and-haul).
      this.updateStandIn();
      if (this.self.memory.dedicated && !this.self.memory.mining) return this.shuttle();
      super.loop();
    }

    // Dedicated shuttle: ferry ONLY between this transporter's assigned source container and the closest
    // spawn/extension that needs energy. Never upgrades, builds, mines, or wanders — when nothing needs
    // filling it just holds its load and waits, so the spawn↔container loop is always covered.
    private shuttle(): void {
      const creep = this.self;
      const source = Game.getObjectById(creep.memory.dedicated!);
      if (!source) { creep.memory.dedicated = undefined; return; } // source gone → release

      const container = source.pos.findInRange(FIND_STRUCTURES, CONTAINER_RANGE, {
        filter: s => s.structureType === STRUCTURE_CONTAINER,
      })[0] as StructureContainer | undefined;
      const energy = creep.store[RESOURCE_ENERGY] ?? 0;
      const containerEnergy = container ? (container.store[RESOURCE_ENERGY] ?? 0) : 0;

      // Deliver when full, already mid-delivery (deliver_target), or carrying a load the now-dry container
      // can't top up — so a partial load never just hoards at the container.
      if (energy > 0 && (creep.store.getFreeCapacity() === 0 || creep.memory.deliver_target || containerEnergy === 0)) {
        const sink = creep.pos.findClosestByPath(creep.room.find(FIND_MY_STRUCTURES, {
          filter: s => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION)
            && ((s as StructureSpawn).store.getFreeCapacity(RESOURCE_ENERGY) ?? 0) > 0,
        }) as (StructureSpawn | StructureExtension)[]);
        if (!sink) { creep.memory.deliver_target = undefined; return; } // all full → hold the load and wait
        creep.memory.deliver_target = sink.id;
        if (creep.transfer(sink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.moveTo(sink, { visualizePathStyle: { stroke: '#ffffff' } });
        return;
      }

      // Otherwise refill from our source's container.
      creep.memory.deliver_target = undefined;
      if (!container || containerEnergy === 0) { if (container) creep.moveTo(container); return; } // wait at/for it
      if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.moveTo(container, { visualizePathStyle: { stroke: '#ffaa00' } });
    }

    // Temporarily replace missing miners, PER SOURCE: a transporter stands in for any source that still lacks
    // mining WORK (no real miner, or its miners don't supply enough), until a real miner shows up. Coverage is
    // measured in WORK parts (sourceWorkNeeded), so several weak ≈1-WORK transporters substitute for one full
    // miner — the count self-caps on the source's free tiles. Re-decided each empty trip; the moment a real
    // miner is assigned, sourceHasRealMiner flips and we release the source (the miner reclaims the tile).
    private updateStandIn(): void {
      const creep = this.self;
      if (this.carrying !== undefined) return; // mid-load → finish the current job before re-deciding
      // Keep our current source while it still needs us (no real miner, short of WORK counting the OTHER
      // stand-ins, and a tile free for us — our own body doesn't count against it). Else pick another.
      const current = creep.memory.target && Game.getObjectById(creep.memory.target as Id<Source>);
      if (creep.memory.mining && current instanceof Source && current.energy > 0
          && !sourceHasRealMiner(current)
          && standInWork(current, creep) < sourceWorkNeeded(current)
          && availableSpacesAround(current, creep) > 0) return;
      const src = this.pickUndermined();
      if (src) { creep.memory.mining = true; creep.memory.target = src.id; }
      else creep.memory.mining = undefined;
    }

    // The closest source with no real miner that still needs more stand-in WORK than it has, and a free tile.
    private pickUndermined(): Source | undefined {
      const creep = this.self;
      const sources = creep.room.find(FIND_SOURCES).filter(s =>
        s.energy > 0 && !sourceHasRealMiner(s)
        && standInWork(s, creep) < sourceWorkNeeded(s)
        && availableSpacesAround(s, creep) > 0);
      return creep.pos.findClosestByPath(sources) ?? undefined;
    }

    // Mine while standing in for a missing miner; otherwise withdraw from a container to haul.
    // (updateStandIn already ran in loop(), so memory.mining is current.)
    protected acquire() {
      if (this.self.memory.mining) return this.standInMine(); // covering a miner shortfall → mine like one

      const creep = this.self;
      const container = creep.pos.findClosestByPath(creep.room.find(FIND_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_CONTAINER && (s as StructureContainer).store[RESOURCE_ENERGY] > 0,
      }) as StructureContainer[]);
      if (!container) return; // nothing to haul yet
      if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.moveTo(container, { visualizePathStyle: { stroke: '#ffaa00' } });
    }

    // Stand-in mining: go to the source updateStandIn assigned us and harvest it. The mined load is carried
    // straight to a sink in deliver() (wantsContainerDrop is false).
    private standInMine(): void {
      const creep = this.self;
      const source = creep.memory.target && Game.getObjectById(creep.memory.target as Id<Source>);
      if (!(source instanceof Source)) { if ((creep.store[RESOURCE_ENERGY] ?? 0) > 0) this.deliver(); return; } // nothing to mine → deliver what we hold
      if (creep.pos.isNearTo(source)) creep.harvest(source);
      else creep.moveTo(source, { visualizePathStyle: { stroke: '#ffaa00' } });
    }

    // A transporter never puts energy back into a container — even standing in as a miner it carries its
    // load straight to a sink (spawn/extension/controller). That keeps a stand-in self-sufficient: a room
    // full of mining shuttles still refills the spawn directly instead of all dropping into containers that
    // nobody is left to haul (which would deadlock the restart).
    protected wantsContainerDrop(): boolean { return false; }

    // Haulers skip the worker-first "fill to enable more miners" rule, but keep the UPGRADE_DEDICATION
    // split so they don't get stuck perpetually topping off a near-full spawn/tower instead of upgrading:
    // commit each load to the controller most of the time, otherwise top up the closest spawn/ext/tower.
    protected energyTarget(controller: StructureController | undefined): StructureController | StructureSpawn | StructureTower | StructureExtension | StructureContainer | null {
      const creep = this.self;
      const held = creep.memory.deliver_target ? Game.getObjectById(creep.memory.deliver_target) : null;
      if (!held) creep.memory.deliver_target = undefined; // stale → re-decide
      if (held instanceof StructureController) return held; // already committed this load to upgrading
      if (!creep.memory.deliver_target && controller && Math.random() < UPGRADE_DEDICATION) return controller;
      return this.closestFillable() ?? controller ?? null;
    }
  }

  // A CLAIM creep: travels to its assigned room and claims the controller. Required quest of
  // SettleUnclaimed — give it enough MOVE (and maybe TOUGH) so it survives the trip.
  export class Settler extends Obj {
    loop() {
      const creep = this.self;
      const room = creep.memory.claim;
      if (!room) return; // unassigned until a SettleUnclaimed goal sets the target room

      const controller = creep.room.controller;
      if (creep.room.name !== room || !controller) { travel(creep, room, '#ff00ff'); return; } // multi-room route to the target
      if (creep.claimController(controller) === ERR_NOT_IN_RANGE) {
        creep.moveTo(controller, { visualizePathStyle: { stroke: '#ff00ff' } });
      }
    }
  }

  // Best tile to drop a new room's spawn: open & buildable, minimising distance to sources
  // (primary) then minerals (secondary, weighted by SETTLE_MINERAL_WEIGHT). Close to them but not
  // on top — run once at settle time (it scans the whole room, so it's expensive).
  export function bestSpawnPos(room: Room): RoomPosition | undefined {
    const sources = room.find(FIND_SOURCES);
    const minerals = room.find(FIND_MINERALS);
    const terrain = room.getTerrain();

    let best: RoomPosition | undefined;
    let bestScore = Infinity;
    for (let x = 4; x <= 45; x++) {
      for (let y = 4; y <= 45; y++) {
        if (terrain.get(x, y) & TERRAIN_MASK_WALL) continue;
        const pos = new RoomPosition(x, y, room.name);
        if (sources.some(s => pos.getRangeTo(s) < 2)) continue; // close, but not jammed against a source

        const toSources = sources.reduce((a, s) => a + pos.getRangeTo(s), 0) / Math.max(1, sources.length);
        const toMinerals = minerals.reduce((a, m) => a + pos.getRangeTo(m), 0) / Math.max(1, minerals.length);
        const score = toSources + toMinerals * SETTLE_MINERAL_WEIGHT;
        if (score < bestScore) { bestScore = score; best = pos; }
      }
    }
    return best;
  }

  // A single roaming MOVE-only creep that keeps frontier scout data fresh. Heads to the stalest
  // unseen/old frontier room; arriving there gives vision (recordScout captured it), then it picks
  // the next stalest — cycling the frontier for its whole life.
  export class Scout extends Obj {
    static frontierRooms(): string[] {
      const set = new Set<string>();
      const scout = scoutMemory();
      const knownNeutral = (n: string) => { const d = scout[n]; return !!d && !d.controller?.owner; }; // scouted & unowned
      for (const r of Object.values(Game.rooms)) {
        if (!r.controller?.my) continue;
        const myStatus = Game.map.getRoomStatus(r.name).status;
        const reachable = (n: string) => isMapRoom(n) && !Game.rooms[n]?.controller?.my && Game.map.getRoomStatus(n).status === myStatus;
        for (const adj of Object.values(Game.map.describeExits(r.name) ?? {})) {
          if (!reachable(adj)) continue;                                  // walled off / our own
          set.add(adj);
          // If that adjacent room is a known-neutral room (passable, not enemy-owned), reach one room
          // further out and scout those too.
          if (knownNeutral(adj)) {
            for (const adj2 of Object.values(Game.map.describeExits(adj) ?? {})) {
              if (reachable(adj2)) set.add(adj2);
            }
          }
        }
      }
      return [...set];
    }

    loop() {
      const creep = this.self;
      if (!creep.memory.scout || creep.room.name === creep.memory.scout) creep.memory.scout = this.pickScoutRoom();
      if (creep.memory.scout) travel(creep, creep.memory.scout, '#00CCCC');
    }

    pickScoutRoom(): string | undefined {
      const scout = scoutMemory();
      const from = this.self.room.name;
      const frontier = Scout.frontierRooms().filter(n => n !== from); // never re-pick where we already are
      if (!frontier.length) return undefined;
      // Prefer rooms that actually want a visit (unseen / stale); otherwise just keep roaming so the
      // scout never stands still — either way pick the CLOSEST of the chosen pool.
      const needs = frontier.filter(n => !scout[n] || Game.time - scout[n].ts >= SCOUT_STALE_TICKS);
      const pool = needs.length ? needs : frontier;
      return pool.reduce((best, n) =>
        Game.map.getRoomLinearDistance(from, n) < Game.map.getRoomLinearDistance(from, best) ? n : best);
    }
  }

  export class Fighter extends Obj {
    loop() { }
  }
}
