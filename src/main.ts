import type _ from 'lodash'

// Economic Constants
const CREEP_LIFETIME = 1500;
const INCOME_WEIGHT = CREEP_LIFETIME / 4;
const INCOMING_REGEN_WEIGHT = 0.3;
const CONTROLLER_BASE_VALUE = 25;
const SCOUT_HORIZON = 1000 * 60 * 60 * 24;
const EXPAND_BETWEEN_ROOMS_WEIGHT = 3;
const UPGRADE_DEFAULT_STRESS = 0.3;
const UPGRADE_DEDICATION = 0.3;    // when not building, share of worker loads taken to the controller (rest fills spawn/extensions)
const WORK_VALUE_SCALING = 2;      // worker income ×this per extra WORK part → favours big workers (extensions)
const WORKER_SATURATION_DECAY = 2; // worker income drops by (workers per source/mineral + 1) ^ this
const WORKER_COST_RELIEF = 0.9;    // higher → a room's cost barrier fades faster as worker count grows
const WORKER_COST_SENSITIVITY = 3; // cost exponent at 0 workers (>1 ⇒ cost matters MUCH more when few workers)

const BODY_COSTS: Record<BodyPartConstant, number> = {
  [MOVE]: 50, [WORK]: 100, [CARRY]: 50, [ATTACK]: 80, [RANGED_ATTACK]: 150, [HEAL]: 250, [CLAIM]: 600, [TOUGH]: 10
};

const SETTLE_MINERAL_WEIGHT = 0.3; // how much a new spawn's distance-to-minerals matters vs distance-to-sources

// A creep counts as a "worker" (harvest/build/upgrade) if it has any WORK part.
const isWorker = (c: Creep) => c.body.some(p => p.type === WORK);

const SETTLE_VALUE = 1000;          // urgency weight of claiming a whole new room
const SETTLER_BODY: BodyPartConstant[] = [CLAIM, MOVE, MOVE]; // CLAIM creep; extra MOVE to survive the trip
const SETTLER_COST = SETTLER_BODY.reduce((a, p) => a + BODY_COSTS[p], 0); // energy needed to build a settler

type ScoutData = { sources: number; mineral?: MineralConstant; controller: boolean; owner?: string; ts: number };
const scoutMemory = (): Record<string, ScoutData> => ((Memory as any).scout ??= {});

// Record what's in a room we can currently see (drives settle scoring).
function recordScout(room: Room) {
  scoutMemory()[room.name] = {
    sources: room.find(FIND_SOURCES).length,
    mineral: room.find(FIND_MINERALS)[0]?.mineralType,
    controller: !!room.controller,
    owner: room.controller?.owner?.username,
    ts: Game.time,
  };
}

// Higher = better room to settle: sources (primary) + a mineral (secondary).
const roomScore = (d: ScoutData) => d.sources + (d.mineral ? SETTLE_MINERAL_WEIGHT : 0);

// Best unowned, claimable, scouted room — or undefined if GCL is maxed / nothing worth it.
function settleTarget(): string | undefined {
  if (Object.values(Game.rooms).filter(r => r.controller?.my).length >= Game.gcl.level) return undefined; // GCL cap
  let best: string | undefined, bestScore = 0;
  const scout = scoutMemory();
  for (const name in scout) {
    const d = scout[name];
    if (!d.controller || d.owner) continue;                       // need a free, unowned controller
    if (Game.map.getRoomStatus(name).status !== 'normal') continue;
    const s = roomScore(d);
    if (s > bestScore) { bestScore = s; best = name; }
  }
  return best;
}

const settlerExists = (room: string) => Object.values(Game.creeps).some(c => c.memory.claim === room);

// Could we claim another room at all? (GCL cap.) Gates scouting — no point looking for settle targets
// we couldn't act on.
const canClaim = () => Object.values(Game.rooms).filter(r => r.controller?.my).length < Game.gcl.level;

// Military Constants
const DEFENCE_TO_STRESS_RATIO = 2 // % Military stress is invested in defence.
const PANIC_AT = 1 / DEFENCE_TO_STRESS_RATIO; // Treshold for dedicating all resources to defence.

type CreepRole = 'harvest' | 'upgrade' | 'build'
interface CreepMemory {
  role: CreepRole
  target?: Id<Source>
  // Where a full creep takes its energy: a construction site (→ build), the controller (→ upgrade),
  // or a spawn/extension/tower (→ transfer). The object's type discerns the action.
  deliver_target?: Id<ConstructionSite | StructureController | StructureSpawn | StructureTower | StructureExtension>
  // Settler target: the name of the room whose controller it should travel to and claim.
  claim?: Room['name']
  // Scout target: a worker temporarily sent to this room to gain vision of it.
  scout?: Room['name']
  // Remote-build home: a worker sent to live in this (claimed, spawn-less) room and build its spawn.
  home?: Room['name']
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

  goals = [];
  for (const name in Game.rooms) {
    const room = Game.rooms[name];
    recordScout(room); // remember every room we can see, for settle scoring
    const room_goals = Goal.forRoom(room);
    goals.push(...room_goals);

    (economicGoal as any)[name] ??= {};

    // Drop a finished economic goal (worker spawned / extension built) so the next can be picked.
    const current = economicGoal[name][RESOURCE_ENERGY];
    if (current && Goal.achieved(current, room)) delete economicGoal[name][RESOURCE_ENERGY];

    if (economicGoal[name][RESOURCE_ENERGY]) continue;

    const goal = Goal.pick(
      room_goals.filter(g => g instanceof Goal.Economy).filter(g => !g.target || g instanceof Goal.Build)
    );
    if (goal) {
      economicGoal[name][RESOURCE_ENERGY] = goal;
      console.log(`Economic goal for: ${goal.name}`);
      if (goal instanceof Goal.Build) goal.place();
    }

    // A Scout goal's existence triggers it: send one free worker to gain vision of an unseen neighbour
    // (Scout goals only exist while a claim is possible, so this is gated already).
    const scoutTargets = room_goals.filter(g => g instanceof Goal.Scout).map(g => (g as Goal.Scout).toRoom);
    if (scoutTargets.length && !Object.values(Game.creeps).some(c => c.memory.scout && scoutTargets.includes(c.memory.scout))) {
      const free = room.find(FIND_MY_CREEPS, { filter: c => isWorker(c) && !c.memory.scout && !c.memory.home })[0];
      if (free) free.memory.scout = scoutTargets[0];
    }

    // A claimed room with no spawn → send one worker from here to go build its spawn.
    if (room.controller?.my && room.find(FIND_MY_SPAWNS).length === 0
        && !Object.values(Game.creeps).some(c => isWorker(c) && c.memory.home === name)) {
      const free = Object.values(Game.creeps).find(c =>
        isWorker(c) && !c.memory.home && !c.memory.scout && c.room.controller?.my && c.room.find(FIND_MY_SPAWNS).length > 0);
      if (free) free.memory.home = name;
    }
  }

  for (const name in Game.spawns) {
    const s = Game.spawns[name];
    if (s.spawning) continue;
    const econ = economicGoal[s.room.name]?.[RESOURCE_ENERGY];
    if (econ instanceof Goal.BuildSettler && !settlerExists(econ.settle)) {
      s.spawnCreep(SETTLER_BODY, 'Settler' + Game.time, { memory: { role: 'harvest', claim: econ.settle } });
    } else {
      s.spawnCreep(Unit.bestAffordableWorker(s.room.energyCapacityAvailable).body, 'Creep' + Game.time, { memory: { role: 'harvest' } });
    }
  }

  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    if (isWorker(creep)) new Unit.Worker(creep).loop();
    else if (creep.body.some(p => p.type === CLAIM)) new Unit.Settler(creep).loop();
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
    if (goal instanceof BuildSettler) return settlerExists(goal.settle); // the settler is on its way
    if (goal instanceof BuildSpawn) return room.find(FIND_MY_SPAWNS).length > 0; // spawn built → room is self-sufficient
    return false;
  }

  export function forRoom(room: Room): Obj[] {
    if (!room.controller?.my) return [];

    const out: Obj[] = [new UpgradeController(room)];

    // Scout unseen travelable neighbours — but only while we could actually claim a new room.
    if (canClaim()) {
      out.push(...Object.values(Game.map.describeExits(room.name) ?? {})
        .filter(name => !Game.rooms[name])
        .filter(name => Game.map.getRoomStatus(name).status !== 'closed')
        .map(name => new Scout(room, name)));
    }

    // Mine each source.
    out.push(...room.find(FIND_SOURCES).map(source => new MineEnergy(room, source)));

    if (room.find(FIND_MY_SPAWNS).length) {
      out.push(new SpawnWorker(room));
      if (!BuildExtension.atCap(room)) out.push(new BuildExtension(room));

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

    get urgency(): number {
      const future = this.future.length ? this.future.reduce((a, g) => a + g.urgency, 0) : 1;
      const c = this.content[RESOURCE_ENERGY];
      const income = c === undefined ? 0 : (typeof c === 'number' ? c : INCOME_WEIGHT * c.amount);

      // Cost as a 0..1 affordability multiplier (uses the previous level's cost if present).
      const cost = (this.previous?.costs ?? this.costs)[RESOURCE_ENERGY] ?? 0;
      let affordability = cost <= 0 ? 1 : Math.min(1, this.room.energyCapacityAvailable / cost);
      if (cost > 0) {
        const workers = this.room.find(FIND_MY_CREEPS, { filter: isWorker }).length;
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
    const workers = room.find(FIND_MY_CREEPS, { filter: isWorker }).length;
    const resources = room.find(FIND_SOURCES).length + room.find(FIND_MINERALS).length;
    return Math.pow(workers / Math.max(1, resources) + 1, WORKER_SATURATION_DECAY);
  }

  export class SpawnWorker extends Economy {
    constructor(room: Room, private budget: number = room.energyCapacityAvailable) { super(room, 'Spawn Worker'); }
    private get worker() { return Unit.bestAffordableWorker(this.budget); }

    get stress() { return 1; }
    get discountCostWithWorkers() { return false; } // a new worker's own cost always matters
    get content() {
      const workParts = this.worker.body.filter(p => p === WORK).length;
      return { [RESOURCE_ENERGY]: { type: 'income' as const, amount: workParts * HARVEST_POWER * Math.pow(WORK_VALUE_SCALING, workParts - 1) / saturation(this.room) } };
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

      for (let r = 2; r <= 6; r++) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = spawn.pos.x + dx, y = spawn.pos.y + dy;
            if (x < 2 || x > 47 || y < 2 || y > 47) continue;
            if ((x + y) % 2 !== 0) continue;
            if (terrain.get(x, y) & TERRAIN_MASK_WALL) continue;
            if (this.room.lookForAt(LOOK_STRUCTURES, x, y).length) continue;
            if (this.room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length) continue;
            if (this.room.createConstructionSite(x, y, STRUCTURE_EXTENSION) === OK) return;
          }
        }
      }
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

  export class Scout extends Military {
    constructor(room: Room, public toRoom: string) { super(room, 'Scout'); }
    get target() { return this.toRoom; }
    get stress() {
      const status = Game.map.getRoomStatus(this.toRoom);
      const mine = Game.map.getRoomStatus(this.room.name);
      const between = Object.values(Game.map.describeExits(this.toRoom) ?? {})
        .filter(adj => Game.rooms[adj]?.controller?.my).length >= 2;
      // Same access zone ⇒ reachable now; differing novice/respawn status ramps toward the wall opening.
      const base = status.status === mine.status ? 1
        : (status.timestamp ? Math.max(0, Math.min(1, 1 - (status.timestamp - Date.now()) / SCOUT_HORIZON)) : 1);
      return base * (between ? EXPAND_BETWEEN_ROOMS_WEIGHT : 1);
    }
  }
}

namespace Unit {
  // Robust multi-room travel: follow Game.map.findRoute room-by-room so creeps can reach rooms
  // several hops away (e.g. the frontier around a distant owned room), not just adjacent ones.
  export function travel(creep: Creep, roomName: string): void {
    if (creep.room.name === roomName) {
      creep.moveTo(new RoomPosition(25, 25, roomName), { range: 20, reusePath: 10 });
      return;
    }
    const route = Game.map.findRoute(creep.room.name, roomName);
    if (route === ERR_NO_PATH || route.length === 0) {
      creep.moveTo(new RoomPosition(25, 25, roomName), { reusePath: 20 }); // fallback
      return;
    }
    const exit = creep.pos.findClosestByPath(route[0].exit);
    creep.moveTo(exit ?? new RoomPosition(25, 25, route[0].room), { reusePath: 20, visualizePathStyle: { stroke: '#ffffff' } });
  }

  const WORKER_PAIR: BodyPartConstant[] = [WORK, MOVE];
  // 1×CARRY + as many [WORK,MOVE] pairs as the budget affords, capped at MAX_CREEP_SIZE parts.
  export function bestAffordableWorker(budget: number) {
    const pairCost = WORKER_PAIR.reduce((sum, part) => sum + BODY_COSTS[part], 0);
    const maxPairs = Math.floor((MAX_CREEP_SIZE - 1) / WORKER_PAIR.length);
    const pairs = Math.max(1, Math.min(maxPairs, Math.floor((budget - BODY_COSTS[CARRY]) / pairCost)));
    return {
      body: [CARRY, ...Array.from({ length: pairs }, () => WORKER_PAIR).flat()],
      cost: BODY_COSTS[CARRY] + pairs * pairCost,
    };
  }

  // --- shared selection helpers (operate over the module `goals`) ---

  function availableSpacesAround(target: { room: Room | undefined, pos: RoomPosition }): number {
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
      return !blocked && room.lookForAt(LOOK_CREEPS, t.x, t.y).length === 0;
    }).length;
  }

  function pickResource(room: Room, pos?: RoomPosition): Source | Mineral | undefined {
    // Among resources that still have stock AND room to mine, take the CLOSEST reachable one —
    // proximity beats urgency here, so a worker doesn't walk past a free source to a farther one.
    const candidates = goals
      .filter(g => g instanceof Goal.MineEnergy || g instanceof Goal.MineMineral)
      .map(g => g.target as Source | Mineral)
      .filter(t => availableSpacesAround(t) !== 0)
      .filter(t => t instanceof Source ? t.energy > 0 : (t as Mineral).mineralAmount > 0);

    if (!pos) return candidates[0];
    return pos.findClosestByPath(candidates, { ignoreCreeps: true }) ?? undefined;
  }

  export abstract class Obj {
    constructor(public self: Creep) { }
    abstract loop(): void
  }

  export class Worker extends Obj {
    private get carrying(): ResourceConstant | undefined {
      for (const r in this.self.store) if ((this.self.store as any)[r] !== 0) return r as ResourceConstant;
      return undefined;
    }

    loop() {
      if (this.scout()) return;
      if (this.goHome()) return;
      if (this.returnHome()) return;
      this.gather();
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

    // Temporarily assigned to scout a room: travel there; once inside, vision is gained (recordScout
    // captured it this tick) so clear the job and head back home.
    private scout(): boolean {
      const creep = this.self;
      if (!creep.memory.scout) return false;
      if (creep.room.name === creep.memory.scout) { creep.memory.scout = undefined; return false; }
      travel(creep, creep.memory.scout);
      return true;
    }

    // Stuck in a room we don't own (e.g. just finished scouting) → walk back to the nearest spawn.
    private returnHome(): boolean {
      const creep = this.self;
      if (creep.room.controller?.my) return false;
      const spawn = Object.values(Game.spawns).sort((a, b) =>
        Game.map.getRoomLinearDistance(creep.room.name, a.room.name) - Game.map.getRoomLinearDistance(creep.room.name, b.room.name))[0];
      if (spawn) creep.moveTo(spawn, { visualizePathStyle: { stroke: '#ffffff' }, reusePath: 20 });
      return true;
    }

    private gather() {
      const creep = this.self;
      const carrying = this.carrying;
      if (creep.store.getFreeCapacity(carrying) === 0) return this.deliver();
      // Mid-delivery (depositing or building) → stay in deliver() until empty.
      if (creep.memory.deliver_target) return this.deliver();

      // Already next to a source that still has energy? Just harvest it — don't re-pick.
      // (availableSpacesAround counts our own tile as taken and would otherwise push us off it.)
      const current = creep.memory.target && Game.getObjectById(creep.memory.target);
      if (current && current.energy > 0 && creep.pos.isNearTo(current)) { creep.harvest(current); return; }

      // Otherwise head to the closest source that has room.
      const source = pickResource(creep.room, creep.pos);
      creep.memory.target = source?.id as Id<Source> | undefined;
      if (!source) return;

      if (creep.harvest(source) === ERR_NOT_IN_RANGE) creep.moveTo(source, { visualizePathStyle: { stroke: '#ffaa00' } });
    }

    // Closest spawn / extension / tower that still needs energy.
    private closestFillable(): StructureSpawn | StructureExtension | StructureTower | null {
      return this.self.pos.findClosestByPath(this.self.room.find(FIND_MY_STRUCTURES, {
        filter: s => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION || s.structureType === STRUCTURE_TOWER)
          && ((s as StructureSpawn).store.getFreeCapacity(RESOURCE_ENERGY) ?? 0) > 0,
      }) as (StructureSpawn | StructureExtension | StructureTower)[]);
    }

    private deliver() {
      const creep = this.self;
      const carrying = this.carrying;
      if (carrying === undefined) { creep.memory.deliver_target = undefined; return this.gather(); }

      const controller = creep.room.controller?.my ? creep.room.controller : undefined;
      const econ = economicGoal[creep.room.name]?.[RESOURCE_ENERGY];

      let target: ConstructionSite | StructureController | StructureSpawn | StructureTower | StructureExtension | null = null;

      if (econ instanceof Goal.Build && econ.target) {
        target = econ.target; // the room wants a structure built → everyone builds it
      } else if (carrying === RESOURCE_ENERGY) {
        const held = creep.memory.deliver_target ? Game.getObjectById(creep.memory.deliver_target) : null;
        if (!held) creep.memory.deliver_target = undefined; // stale → re-decide

        if (Goal.BuildExtension.atCap(creep.room)) {
          // Nothing left to build → dedicate UPGRADE_DEDICATION of loads to the controller, the rest to
          // refills. The choice sticks for the whole load.
          if (held instanceof StructureController) target = held;
          else if (!creep.memory.deliver_target && Math.random() < UPGRADE_DEDICATION && controller) target = controller;
          else target = this.closestFillable() ?? controller ?? null;
        } else {
          // Extensions still buildable → always fill spawn/extensions (grow), never divert to upgrading.
          target = this.closestFillable();
        }
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

  // A CLAIM creep: travels to its assigned room and claims the controller. Required quest of
  // SettleUnclaimed — give it enough MOVE (and maybe TOUGH) so it survives the trip.
  export class Settler extends Obj {
    loop() {
      const creep = this.self;
      const room = creep.memory.claim;
      if (!room) return; // unassigned until a SettleUnclaimed goal sets the target room

      const controller = creep.room.controller;
      if (creep.room.name !== room || !controller) { travel(creep, room); return; } // multi-room route to the target
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

  export class Fighter extends Obj {
    loop() { }
  }
}
