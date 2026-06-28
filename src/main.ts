const BUILD_DEDICATION = 0.5;
const UPGRADE_DEDICATION = 0.3;

const FRIENDLY_PLAYERS = ['nvim']

const TOWER_REPAIR_RESERVE = TOWER_CAPACITY / 2;
const TOWER_BARRIER_TARGET = 30000;

const ROOM_CACHE_LIFETIME = 50000;

const REMOTE_SOURCE_RANGE = 45;

// Per-tick chance an idle hauler dedicates itself to a remote source whose container has banked energy. Keeps them
// trickling out to remotes instead of the whole idle fleet stampeding the moment a container fills.
const REMOTE_CLAIM_CHANCE = 0.1;

// Self-renewal: a dying creep heads to a spawn and tops its life back up (only worth it for full-spec creeps).
const RENEW_MARGIN = 100;    // aim to reach the spawn with ~this many ticks of life to spare
const RENEW_TARGET = CREEP_LIFE_TIME - 1;   // top the creep back up to this TTL before sending it back to work
const MAX_RENEW_ETA = 150;   // cheap pre-filter — only run the precise PathFinder renew check this close to death

// Re-send a settler once a room's reservation drops below this (a 2-CLAIM settler tops it back up over its life).
const RESERVE_FLOOR = 1000;

// How many times the raw production rate the haulers should be able to move before we stop spawning more.
// Higher = more transporters (the nominal per-hauler throughput is never fully realized in practice).
const TRANSPORTER_HEADROOM = 25;

const ROAD_FILL_RADIUS = 5;

interface CreepMemory {
  target?: Id<Source> | Id<Creep>
  reserve_target?: string // settler: name of the claimable room it claims/reserves
  deliver_target?: Id<ConstructionSite | AnyStructure>
  collect_target?: Id<AnyStructure | Resource>
  delivering?: boolean
  scout?: string
  renewing?: boolean
  _stuck?: string
}
type RoomMemory = Serialized<_Room_> & { timestamp: number }
interface Memory {
  creeps: { [name: string]: CreepMemory };
  powerCreeps: { [name: string]: PowerCreepMemory };
  flags: { [name: string]: FlagMemory };
  rooms: { [name: string]: RoomMemory };
  spawns: { [name: string]: SpawnMemory };
}
declare const Memory: Memory;

const ROOM_SIZE = 50;

declare global {}

(global as any).wipe_creep_memory = () => {
  for (const name in Game.creeps) { Game.creeps[name].memory = undefined; }
}

export function loop() {
  // Clear dead creeps.
  for (const name in Memory.creeps) if (!Game.creeps[name]) delete Memory.creeps[name];
  for (const name in Memory.powerCreeps) if (!Game.creeps[name]) delete Memory.powerCreeps[name];

  // Index scouted remote rooms before anything else.
  _Room_.REMOTE = [];
  _Room_.ALL = Object.values(Game.rooms).map(x => new _Room_(x));

  for (const name in Memory.rooms) { if(!Game.rooms[name]) { _Room_.remote_loop(Memory.rooms[name]) } }

  for (const name in Game.rooms) { new _Room_(Game.rooms[name]).loop(); }

  for (const name in Game.spawns) { new Structures.Spawn(Game.spawns[name]).loop(); }
  for (const name in Game.creeps) { 
    const creep = Game.creeps[name];
    if (creep.body.filter(x => x.type === CARRY).length >= 2) new Unit.Transporter(creep).loop();
    else if (creep.body.some(x => x.type === WORK)) new Unit.Worker(creep).loop();
    else if (creep.body.length === 1 && creep.body[0].type === MOVE) new Unit.Scout(creep).loop();
    else if (creep.body.some(x => x.type === CLAIM)) new Unit.Settler(creep).loop();
    else if (creep.body.some(x => x.type === RANGED_ATTACK)) new Unit.Ranged(creep).loop();
    else if (creep.body.some(x => x.type === HEAL)) new Unit.Healer(creep).loop();
    else if (creep.body.some(x => x.type === ATTACK) && creep.body.some(x => x.type === TOUGH)) new Unit.Tank(creep).loop();
    else if (creep.body.some(x => x.type === ATTACK)) new Unit.Infantry(creep).loop();
    else console.error(`Unknown creep type with ${creep.body.map(x => x.type).join(', ')}`)
  }
}

namespace Goal {
  export abstract class Obj {
    // target: RoomPosition

    // roaded(from: RoomPosition): boolean {

    // }
  }
}

namespace Unit {

  export type Configuration = [base: BodyPartConstant[], repeated: BodyPartConstant[]]
  export const BODY_COSTS: Record<BodyPartConstant, number> = {
    [MOVE]: 50, [WORK]: 100, [CARRY]: 50, [ATTACK]: 80, [RANGED_ATTACK]: 150, [HEAL]: 250, [CLAIM]: 600, [TOUGH]: 10
  };
  export function cost(parts: BodyPartConstant[]) { return parts.reduce((sum, x) => sum + Unit.BODY_COSTS[x], 0); }

  export abstract class Obj {
    constructor(public self: Creep) { }
    abstract loop(): void

    get room() { return new _Room_(this.self.room) }
    get pos() { return new _Position_(this.self) }

    // Head home to renew before dying — but only creeps built to the current best-affordable WORK count (don't prop up
    // stunted emergency builds). Aim to reach the spawn with ~RENEW_MARGIN ticks to spare, then top up to RENEW_TARGET.
    // Returns true if it claimed the creep's action this tick (caller should stop). The `renewing` memory latch lets the
    // cheap ttl pre-filter skip the PathFinder cost for everyone who isn't actually near death.
    renew(config: Configuration): boolean {
      const ttl = this.self.ticksToLive ?? CREEP_LIFE_TIME;

      if (!this.self.memory.renewing) {
        if (ttl > RENEW_MARGIN + MAX_RENEW_ETA) return false;                // nowhere near death → cheap exit (no PathFinder)
        const spawn = this.pos.closestSpawn();
        if (!spawn || !this.worthRenewing(spawn, config)) return false;
        if (ttl > this.pos.travelTimeTo(spawn) + RENEW_MARGIN) return false; // still time to work AND get back
        this.self.memory.renewing = true;
      }

      if (ttl >= RENEW_TARGET) { this.self.memory.renewing = false; return false; } // topped up → back to work

      const spawn = this.pos.closestSpawn();
      if (!spawn) { this.self.memory.renewing = false; return false; }
      if (!this.self.pos.isNearTo(spawn)) { this.travel(spawn, { visualizePathStyle: { stroke: '#000000' } }); return true; }
      const code = spawn.renewCreep(this.self);
      if (code !== OK && code !== ERR_BUSY) { this.self.memory.renewing = false; return false; } // full / no energy → back to work; only wait out a busy spawn
      return true;
    }

    // Only renew creeps with as many WORK parts as a fresh spawn would give them — skips undersized stubs and any
    // non-working body (scouts/claimers have no WORK). Measured against energyAvailable, the SAME budget the spawner
    // builds from: comparing against full capacity wrongly rejected every worker spawned while the spawn wasn't full.
    private worthRenewing(spawn: StructureSpawn, config: Configuration): boolean {
      if (config[0].includes(CLAIM) || config[1].includes(CLAIM)) return false;
      const room = new _Room_(spawn.room);
      const want = room.bestAffordableUnit(config, room.self.energyAvailable);
      const work = (parts: ({ type: BodyPartConstant } | BodyPartConstant)[]) =>
        parts.filter(p => ((p as any).type ?? p) === WORK).length;
      return work(this.self.body) > 0 && work(this.self.body) >= work(want);
    }

    travel(
      target: RoomPosition | { pos: RoomPosition },
      opts?: MoveToOpts,
    ):  CreepMoveReturnCode | ERR_NO_PATH | ERR_INVALID_TARGET | ERR_NOT_FOUND {
      //TODO Different pathing for military units if engaged in combat.
      //TODO Park in the area instead of going around.

      const roomName = 'pos' in target ? target.pos.roomName : target.roomName;

      // One matrix per room per tick, shared across all creeps (PathFinder exempts the origin tile, so blocking our
      // own position is harmless). Rebuilding this per creep per repath was a major CPU sink.
      const costCallback = (rn: string) => memo('cm:' + rn, () => {
        const cm = new PathFinder.CostMatrix();
        const room = Game.rooms[rn];
        if (room) {
          for (const s of room.find(FIND_STRUCTURES)) {
            if (s.structureType === STRUCTURE_ROAD) cm.set(s.pos.x, s.pos.y, 1);
            else if (s.structureType !== STRUCTURE_CONTAINER && s.structureType !== STRUCTURE_RAMPART) cm.set(s.pos.x, s.pos.y, 255);
          }
          for (const c of room.find(FIND_CREEPS)) cm.set(c.pos.x, c.pos.y, 255); // route around creeps (cross-room hops use PathFinder, which ignores them)
        }
        return cm;
      });

      // Stuck detection: if we didn't move since our last travel call, a creep is parked on our cached path.
      // Force a fresh path this tick (reusePath 0) so moveTo routes around it instead of waiting it out.
      const here = `${this.self.pos.roomName}:${this.self.pos.x}:${this.self.pos.y}`;
      const reusePath = this.self.memory._stuck === here ? 0 : 20; // repath only when genuinely blocked; otherwise reuse
      this.self.memory._stuck = here;

      opts = { swampCost: 10, plainCost: 2, reusePath, ...opts }

      // Same room: go straight to the target.
      if (this.self.room.name === roomName) return this.self.moveTo(target, { costCallback, ...opts });

      // Different room: hop one room at a time. moveTo straight to a target several rooms away does a long
      // multi-room search that hits its op cap (or sticks at the border) and the creep stops moving. Aim at the
      // next room on the route instead — a single-hop move moveTo handles reliably, picking the border crossing.
      const route = Game.map.findRoute(this.self.room.name, roomName);
      if (route === ERR_NO_PATH || route.length === 0) return this.self.moveTo(target, { costCallback, ...opts });
      return this.self.moveTo(new RoomPosition(25, 25, route[0].room), { range: 22, costCallback, ...opts });
    }

  }
  export class Worker extends Obj {
    static count() { return Object.values(Game.creeps).filter(x => x.body.some(p => p.type === WORK) && x.body.filter(p => p.type === CARRY).length < 2).length; }
    static configuration: Configuration = [[CARRY], [MOVE, WORK]]

    get carrying(): ResourceConstant | undefined {
      for (const r in this.self.store) if ((this.self.store as any)[r] !== 0) return r as ResourceConstant;
      return undefined;
    }

    get target(): _Source_ | Serialized<_Source_> | undefined {
      if (this.self.memory.target === undefined) {
        // Re-acquire from ANY of our rooms that needs a worker (its needsWorker already folds in remote sources) — not
        // just the room we're standing in. Otherwise a worker whose memory was wiped while in a spawn-less remote room
        // evaluates that room's needsWorker (always false) and can never find its way back to an assignment.
        const targets = _Room_.ALL.filter(r => r.my_controller).flatMap(r => r.needsWorker() || []);
        if (!targets.length) return undefined;

        const refs = targets.map(x => ({ id: (x as any).self.id as Id<Source>, pos: roomPosOf((x as any).self.pos) }));
        const best = this.pos.closestByRoute(refs);
        if (!best) return undefined;
        this.self.memory.target = best.id;
      }

      const live = Game.getObjectById(this.self.memory.target);
      if (live instanceof Source) return new _Source_(live);
      if (live) { console.error('Memory target is not valid.'); this.self.memory.target = undefined; return undefined; }

      const cached = _Room_.find_remote_source(this.self.memory.target as Id<Source>);
      if (cached) return cached;
      this.self.memory.target = undefined;
      return undefined;
    }

    get efficiency(): number { return this.self.body.filter(x => x.type === WORK).length * HARVEST_POWER; }
    get load(): number { return this.self.body.filter(x => x.type === CARRY).length * CARRY_CAPACITY; }
    get load_time(): number { return Math.ceil(this.load / this.efficiency); }
    get revenue(): number {
      return this.lifetime_trips * this.load;
    }
    get lifetime_trips(): number {
      if (this.trip_downtime === Infinity) return 0;
      return CREEP_LIFE_TIME / (this.load_time + this.trip_downtime); // TODO - Initial travel time from spawn
    }
    get trip_downtime(): number {
      const target = this.target;
      if (!target) return Infinity;
      const at = new _Position_({ pos: roomPosOf((target.self as any).pos) } as RoomObject);
      // Container-miner: the load goes into the source's own container (a short hop), so the trip is mining-bound —
      // this is what makes WORK count (more WORK fills/drains faster → fewer workers per source). Only with no
      // container do we fall back to the weighted self-delivery trip (spawn/build/controller), which is travel-bound.
      const container = at.closestFillable({ ignore_capacity: true }, [STRUCTURE_CONTAINER]);
      return container ? at.travelTimeTo(container) * 2 : this.delivery_downtime(at);
    }

    // Where a load of energy can go, and the structure types that count as a "top up the room" sink.
    get sinks(): StructureConstant[] { return [STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_TOWER, STRUCTURE_CONTAINER]; }

    // Round trip from a load position to wherever this energy ends up — build site, controller, or nearest
    // sink — averaged by the same odds energyDeliveryTarget rolls (BUILD_DEDICATION / UPGRADE_DEDICATION).
    delivery_downtime(at: _Position_): number {
      const build = this.room.construction_goal;
      const controller = this.may_upgrade() ? (this.room.my_controller ?? undefined) : undefined;
      const fill = at.closestFillable({ ignore_capacity: true }, this.sinks);

      let total = 0, weight = 0;
      const remaining = build ? 1 - BUILD_DEDICATION : 1;
      if (build) { total += BUILD_DEDICATION * at.travelTimeTo(build); weight += BUILD_DEDICATION; }
      if (controller && fill) {
        total += remaining * UPGRADE_DEDICATION * at.travelTimeTo(controller);
        total += remaining * (1 - UPGRADE_DEDICATION) * at.travelTimeTo(fill);
        weight += remaining;
      } else if (controller) {
        total += remaining * at.travelTimeTo(controller); weight += remaining;
      } else if (fill) {
        total += remaining * at.travelTimeTo(fill); weight += remaining;
      }

      if (weight === 0) return Infinity;
      return (total / weight) * 2;
    }
    get downtime(): number { return this.lifetime_trips * this.trip_downtime }

    loop(): void { if (this.renew(Worker.configuration)) return; this.gather(); }

    gather(): void {
      // Full, or already committed to a delivery → keep delivering until empty (don't go back to mining mid-load).
      if (this.self.store.getFreeCapacity(this.carrying) === 0 || this.self.memory.deliver_target) return this.offload();

      const target = this.target;
      if (!target) { return this.idle(); }

      const self = target.self as { id: Id<Source>; pos: RoomPosition | { x: number; y: number; roomName: string } };
      const source = Game.getObjectById(self.id);
      // Source is dry and we're holding a partial load → don't loiter waiting for regen; take it to a delivery target.
      if (source && source.energy === 0 && this.carrying) return this.offload();
      if (source && this.self.harvest(source) === OK) { this.relocate_mining(source); return; }
      // Travelling to the source (not in harvest range): grab loose energy we pass, and repair as we go. Skip pickups
      // near the source so a drop-miner doesn't re-collect its own drop pile (that's left there for the haulers).
      const sourcePos = roomPosOf(self.pos);
      const nearSource = this.self.pos.roomName === sourcePos.roomName && this.self.pos.getRangeTo(sourcePos) <= 3;
      const drop = nearSource ? undefined : this.self.pos.findInRange(FIND_DROPPED_RESOURCES, 1, { filter: r => r.resourceType === RESOURCE_ENERGY })[0];
      if (drop && this.self.store.getFreeCapacity() > 0) this.self.pickup(drop);
      this.maintain();
      this.travel(sourcePos, { visualizePathStyle: { stroke: '#ffaa00' } });
    }

    // Top up the worst-off broken structure within work range — a free work-action (separate intent from MOVE), so a
    // remote miner mends the road on its trip. Barriers are left to the towers. Returns whether it issued a repair, so
    // a caller about to transfer/drop its load can stop for the tick (transfer would otherwise drain the repair energy).
    maintain(): boolean {
      if ((this.self.store[RESOURCE_ENERGY] ?? 0) === 0) return false; // need a bit of energy to repair with
      const damaged = this.self.pos.findInRange(FIND_STRUCTURES, 3, {
        filter: s => s.hits < s.hitsMax && s.structureType !== STRUCTURE_WALL && s.structureType !== STRUCTURE_RAMPART,
      });
      if (!damaged.length) return false;
      const worst = damaged.reduce((a, b) => b.hits / b.hitsMax < a.hits / a.hitsMax ? b : a);
      return this.self.repair(worst) === OK;
    }

    // While mining, if we're standing on a road (a through-lane right by the source), shuffle onto another tile that's
    // still adjacent to the source but isn't a road — we still harvest this tick, we just stop blocking the lane.
    relocate_mining(source: Source): void {
      const here = this.self.pos;
      if (!here.lookFor(LOOK_STRUCTURES).some(s => s.structureType === STRUCTURE_ROAD)) return;
      const terrain = this.self.room.getTerrain();
      let best: RoomPosition | undefined, bestOpen = -1;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const x = here.x + dx, y = here.y + dy;
        if (x < 1 || x > 48 || y < 1 || y > 48 || (terrain.get(x, y) & TERRAIN_MASK_WALL)) continue;
        if (source.pos.getRangeTo(x, y) > 1) continue;                                 // must stay next to the source
        const tile = new RoomPosition(x, y, here.roomName);
        if (tile.lookFor(LOOK_CREEPS).length) continue;
        if (tile.lookFor(LOOK_STRUCTURES).some(s => s.structureType !== STRUCTURE_CONTAINER && s.structureType !== STRUCTURE_RAMPART)) continue; // skip roads & blockers
        let open = 0;                                                                  // prefer the roomiest spot
        for (let ax = -1; ax <= 1; ax++) for (let ay = -1; ay <= 1; ay++) if ((ax || ay) && !(terrain.get(x + ax, y + ay) & TERRAIN_MASK_WALL)) open++;
        if (open > bestOpen) { bestOpen = open; best = tile; }
      }
      if (best) this.self.move(here.getDirectionTo(best));
    }

    // Hand off the load: a remote miner with haulers around banks it at the source for them; everyone else delivers.
    offload(): void {
      if (this.carrying && !this.room.my_controller && Transporter.count() > 0) {
        this.self.memory.deliver_target = undefined;
        // Mend our own patch first (container, nearby road) and STOP for the tick if we did — the transfer below would
        // otherwise drain the very energy the repair needs. We keep the load and resume banking once nothing's broken.
        if (this.maintain()) return;
        // Into the source container if one's in reach (no decay, haulers withdraw cleanly); only drop if there's none with room.
        const container = this.self.pos.findInRange(FIND_STRUCTURES, 1, {
          filter: s => s.structureType === STRUCTURE_CONTAINER && (s as StructureContainer).store.getFreeCapacity() > 0,
        })[0] as StructureContainer | undefined;

        if (container) this.self.transfer(container, this.carrying);
      }
      this.deliver();
    }

    idle(): void {
      // No haulers in the colony → an idle (unassigned) worker moonlights as one: haul containers/drops to sinks,
      // building/upgrading as the fallback. Keeps energy moving until a real transporter is spawned again.
      if (!(this instanceof Transporter) && Transporter.count() === 0) new Transporter(this.self).gather();
    }

    energyDeliveryTarget(): ConstructionSite | StructureController | StructureSpawn | StructureTower | StructureExtension | StructureContainer | null {
      const fill = this.fillable();

      // With haulers around, just drop the load into the nearest container (the source container we're standing
      // by) and let the transporters distribute it — don't ferry it across the room ourselves.
      if (!(this instanceof Transporter) && Transporter.count() > 0) {
        if (fill) return fill;
      }

      if (fill && (this.room.needsWorker() || (this.room.needsTransporter() && Transporter.count() < this.room.sources.length))) return fill;

      const build = this.room.construction_goal;
      if (build && Math.random() < BUILD_DEDICATION) return build;

      const controller = this.room.my_controller ?? null;
      if (controller && this.may_upgrade() && (!fill || Math.random() < UPGRADE_DEDICATION)) return controller;
      return fill ?? controller;
    }
    fillable(): StructureSpawn | StructureTower | StructureExtension | StructureContainer | null {
      // Closest fillable by REAL in-room path. closestByRoute runs a terrain-only PathFinder that walks straight
      // through buildings, so it can rank a far container ahead of a near sink. findClosestByPath respects them.
      const reserveForSpawn = this.self.room.energyAvailable < this.self.room.energyCapacityAvailable; // still filling spawn/extensions → skip towers
      const candidates = this.self.room.find(FIND_STRUCTURES, {
        filter: s => (
          s.structureType === STRUCTURE_CONTAINER ||
          (([STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_TOWER] as string[]).includes(s.structureType) && (s as OwnedStructure).my)
        ) && !(reserveForSpawn && s.structureType === STRUCTURE_TOWER)
          && (((s as any).store?.getFreeCapacity(RESOURCE_ENERGY) ?? 0) > 0),
      }) as (StructureSpawn | StructureExtension | StructureTower | StructureContainer)[];
      return this.self.pos.findClosestByPath(candidates, { ignoreCreeps: true }) ?? this.pos.closestFillable();
    }
    may_upgrade(): boolean { return Transporter.count() === 0; }

    deliver(): void {
      if (!this.carrying) { this.self.memory.deliver_target = undefined; return this.gather(); }

      let target = this.self.memory.deliver_target ? Game.getObjectById(this.self.memory.deliver_target) : null;
      if (!target) {
        target = this.carrying === RESOURCE_ENERGY ? this.energyDeliveryTarget() : null;
        this.self.memory.deliver_target = target?.id as Id<ConstructionSite | AnyStructure> | undefined;
      }
      if (!target) return this.idle();

      const code = target instanceof ConstructionSite ? this.self.build(target)
        : target instanceof StructureController ? this.self.upgradeController(target)
        : this.self.transfer(target, this.carrying);

      if (code === ERR_NOT_IN_RANGE) {
        if (!(this instanceof Transporter)) this.maintain(); // workers mend the road on the loaded trip home (transporters do it in their loop)
        return void this.travel(target, { visualizePathStyle: { stroke: target instanceof ConstructionSite ? '#0000FF' : target instanceof StructureController ? '#00FF00' : '#ffffff' } });
      }
      if (code !== OK) this.self.memory.deliver_target = undefined; // full / can't deliver here (e.g. no WORK) → re-pick next tick

      // In range and carrying energy → top up the structure we're feeding if it's worn. This is how a source
      // container gets maintained: the worker delivering into it is the one standing there with energy to spare.
      // (transfer is a separate intent from the repair work-action, so it costs no extra tick.)
      if (target instanceof Structure && target.hits < target.hitsMax
        && target.structureType !== STRUCTURE_WALL && target.structureType !== STRUCTURE_RAMPART) this.self.repair(target);
    }

  }
  
  export class Transporter extends Worker {
    static count() { return Object.values(Game.creeps).filter(x => x.body.filter(p => p.type === CARRY).length >= 2).length; }
    static configuration: Configuration = [[MOVE, MOVE, CARRY, WORK], [MOVE, MOVE, CARRY, WORK]]

    // Once the spawn's extension + controller roads are built, haulers run on roads (fatigue halved) so they can
    // spare a MOVE — drop one from base and repeated. Falls back to the full body until those roads are done.
    static roaded_configuration(room: _Room_): Configuration {
      const spawn = room.spawners[0];
      if (!spawn || !spawn.road_to_extensions.completed() || !spawn.road_to_controller.completed()) return Transporter.configuration;
      const drop_move = (parts: BodyPartConstant[]): BodyPartConstant[] => {
        const i = parts.indexOf(MOVE);
        return i < 0 ? [...parts] : [...parts.slice(0, i), ...parts.slice(i + 1)];
      };
      const [base, repeated] = Transporter.configuration;
      return [drop_move(base), drop_move(repeated)];
    }

    loop(): void { if (this.renew(Transporter.configuration)) return; this.maintain(); this.gather(); }


    gather(): void {
      // Latch into deliver mode when full and stay there until empty — drop off the whole load before collecting
      // again (a sink filling up mid-delivery must not send us back to the source half-loaded).
      if (this.self.store.getUsedCapacity() === 0) this.self.memory.delivering = false;
      else if (this.self.store.getFreeCapacity() === 0) this.self.memory.delivering = true;
      if (this.self.memory.delivering) return this.deliver();

      // Dedicated remote hauler → only ever shuttle our claimed remote source's drops home.
      if (this.self.memory.target) return this.gather_remote();

      // Stick to a chosen pickup until it's drained (or gone), instead of chasing the closest collectable each tick.
      let source: Structure | Resource | null = this.self.memory.collect_target ? Game.getObjectById(this.self.memory.collect_target) : null;
      const drained = !source || (!(source instanceof Resource) && (((source as any).store?.getUsedCapacity(RESOURCE_ENERGY) ?? 0) === 0));
      if (drained) {
        source = this.pos.closestCollectable();
        this.self.memory.collect_target = source?.id as Id<AnyStructure | Resource> | undefined;
      }
      if (!source) {
        if (this.self.store.getUsedCapacity() > 0) return this.deliver();   // hold a load → go deliver it
        if (this.claim_remote()) return this.gather_remote();               // no local work → dedicate to a remote source
        return this.idle();
      }
      const code = source instanceof Resource ? this.self.pickup(source) : this.self.withdraw(source, RESOURCE_ENERGY);
      if (code === ERR_NOT_IN_RANGE) this.travel(source, { visualizePathStyle: { stroke: '#ffaa00' } });
    }

    // Shuttle our claimed remote source: head out, collect the miner's drops, then (full) deliver home.
    gather_remote(): void {
      const pos = this.remote_target_pos();
      if (!pos) { this.self.memory.target = undefined; return this.gather(); } // source gone → release and go local
      if (this.self.room.name === pos.roomName) {
        const drop = this.pos.closestCollectable();
        if (drop) {
          const code = drop instanceof Resource ? this.self.pickup(drop) : this.self.withdraw(drop, RESOURCE_ENERGY);
          if (code === ERR_NOT_IN_RANGE) this.travel(drop, { visualizePathStyle: { stroke: '#ffaa00' } });
          return;
        }
        // Nothing dropped: wait if a miner (other than us) is still working it, otherwise the source is abandoned → release.
        if (!Object.values(Game.creeps).some(c => c.id !== this.self.id && c.memory.target === this.self.memory.target && c.body.some(p => p.type === WORK) && c.body.filter(p => p.type === CARRY).length < 2)) {
          this.self.memory.target = undefined;
          return this.gather();
        }
        return void this.travel(pos, { visualizePathStyle: { stroke: '#ffaa00' } });
      }
      this.travel(pos, { visualizePathStyle: { stroke: '#ffaa00' } });               // head to the remote room
    }

    remote_target_pos(): RoomPosition | undefined {
      const live = Game.getObjectById(this.self.memory.target as Id<Source>);
      if (live instanceof Source) return live.pos;
      const cached = _Room_.find_remote_source(this.self.memory.target as Id<Source>);
      return cached ? roomPosOf((cached as any).self.pos) : undefined;
    }

    // Maybe dedicate to a logged remote source that has energy banked in its container. Probabilistic (REMOTE_CLAIM_CHANCE)
    // so idle haulers trickle out instead of stampeding, and never doubles up on a source another hauler already holds.
    claim_remote(): boolean {
      const isT = (c: Creep) => c.body.filter(p => p.type === CARRY).length >= 2;
      if (!isT(this.self)) return false;        // real haulers only — a moonlighting 1-CARRY miner must stay put
      if (Math.random() > REMOTE_CLAIM_CHANCE) return false;

      const hauled = new Set(Object.values(Game.creeps).filter(isT).map(c => c.memory.target).filter(Boolean));

      // Energy sitting in the source's container right now — needs vision (a remote miner there gives us that).
      const stored = (id: Id<Source>): number => {
        const src = Game.getObjectById(id);
        if (!(src instanceof Source)) return 0;
        const container = src.pos.findInRange(FIND_STRUCTURES, 2, { filter: s => s.structureType === STRUCTURE_CONTAINER })[0] as StructureContainer | undefined;
        return container?.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
      };

      const sources = _Room_.ALL.flatMap(r => r.spawners).flatMap(s => s.close_remote_sources())
        .filter(s => !hauled.has((s as any).self.id) && stored((s as any).self.id) > 0);
      const best = this.pos.closestByRoute(sources.map(s => ({ id: (s as any).self.id as Id<Source>, pos: roomPosOf((s as any).self.pos) })));
      if (!best) return false;
      this.self.memory.target = best.id;
      return true;
    }

    // Haul into sinks (overflow to storage). When every sink is full, never idle a load — build the current
    // construction goal, else upgrade the controller (the haulers have WORK parts for exactly this).
    get sinks(): StructureConstant[] { return [STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_TOWER, STRUCTURE_STORAGE]; }
    fillable() { return this.pos.closestFillable({ ignore_capacity: false }, this.sinks); }
    // Sinks first; when they're all full, build the construction goal, else upgrade the controller. The shared
    // (sticky) deliver() picks this once per load and commits to it — no flickering between build and a sink.
    energyDeliveryTarget() { return this.fillable() ?? this.room.construction_goal ?? this.room.my_controller ?? null; }

    // Hauling economics: fill from a container in ~1 tick (no mining), then a round trip to the nearest sink.
    get load_time(): number { return 1; }
    get trip_downtime(): number {
      const pickup = this.pos.closestCollectable();
      if (!pickup) return Infinity;
      const at = new _Position_(pickup);
      const sink = at.closestFillable({ ignore_capacity: true }, this.sinks);
      return sink ? at.travelTimeTo(sink) * 2 : Infinity;
    }

    // Nothing to deliver into right now (everything's full) — wait off the road so we don't clog the spawn lanes.
    idle(): void {
      if (!this.self.pos.lookFor(LOOK_STRUCTURES).some(s => s.structureType === STRUCTURE_ROAD)) return;
      const terrain = this.self.room.getTerrain();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const x = this.self.pos.x + dx, y = this.self.pos.y + dy;
        if (x < 1 || x > 48 || y < 1 || y > 48 || (terrain.get(x, y) & TERRAIN_MASK_WALL)) continue;
        const tile = new RoomPosition(x, y, this.self.room.name);
        if (tile.lookFor(LOOK_CREEPS).length) continue;
        if (tile.lookFor(LOOK_STRUCTURES).some(s => s.structureType !== STRUCTURE_CONTAINER && s.structureType !== STRUCTURE_RAMPART)) continue;
        return void this.self.move(this.self.pos.getDirectionTo(tile));
      }
    }
  }
  export class Scout extends Obj {
    static count() { return Object.values(Game.creeps).filter(x => x.body.length === 1 && x.body[0].type === MOVE).length; }
    static configuration: Configuration = [[MOVE], []]

    loop(): void {
      // Re-pick when we have no target or we've arrived (being here means the room loop just cached it).
      if (!this.self.memory.scout || this.self.room.name === this.self.memory.scout) this.self.memory.scout = this.frontier();
      if (this.self.memory.scout) this.travel(new RoomPosition(ROOM_SIZE / 2, ROOM_SIZE / 2, this.self.memory.scout), { visualizePathStyle: { stroke: '#00cccc' } });
    }

    // Head to whichever reachable, non-owned room we have the least-fresh vision of: never-seen first, then the
    // oldest cache. Candidates come from the exits of every room we know (ours + cached), so it explores outward.
    frontier(): string | undefined {
      const status = Game.map.getRoomStatus(this.self.room.name).status;
      const known = [..._Room_.ALL.filter(x => x.my_controller).map(x => x.self.name), ...Object.keys(Memory.rooms)];
      const candidates = new Set<string>();
      for (const name of known)
        for (const adj of Object.values(Game.map.describeExits(name) ?? {}))
          // Skip our own rooms and rooms behind a status boundary (novice/respawn wall) — the exit can't be crossed.
          if (!Game.rooms[adj]?.controller?.my && Game.map.getRoomStatus(adj).status === status) candidates.add(adj);

      const seen_at = (name: string) => Game.rooms[name] ? Game.time : (Memory.rooms[name]?.timestamp ?? -Infinity);
      return [...candidates]
        .sort((a, b) => seen_at(a) - seen_at(b))
        .find(name => Game.map.findRoute(this.self.room.name, name) !== ERR_NO_PATH); // skip rooms we can't route to
    }
  }
  export class Settler extends Obj {
    // We may claim another room only while we own fewer than GCL allows; at the cap we can still reserve.
    static canSettle() { return _Room_.ALL.filter(x => x.my_controller).length < Game.gcl.level; }
    static roomScore(d: _Room_ | Serialized<_Room_>) { return d.sources.length; } //TODO Empty spaces next too.

    static get username(): string | undefined { return Object.values(Game.spawns)[0]?.owner?.username; }

    // Rooms we've logged a remote source in (a spawn's close_remote_sources). Committing to a source is enough — we
    // reserve/claim its room regardless of whether a miner or hauler is currently assigned. Owned rooms are excluded
    // (our own sources aren't remote reserve targets).
    static remoteSourceRoomNames(): Set<string> {
      const names = new Set<string>();
      for (const room of _Room_.ALL)
        for (const spawn of room.spawners)
          for (const src of spawn.close_remote_sources()) {
            const name = (src as any).self?.pos?.roomName;
            if (name && !Game.rooms[name]?.controller?.my) names.add(name);
          }
      return names;
    }

    // Targets a settler should work, in priority order: the remote rooms we actually mine (reserved to double their
    // output), plus — only while we have GCL headroom to claim it — the single best expansion room. Restricting to
    // mined rooms means we never reserve somewhere we aren't harvesting.
    static priorityTargets(): string[] {
      const status = _Room_.ALL.find(x => x.my_controller)?.status;
      const claimable = _Room_.CLAIMABLE;
      const mined = Settler.remoteSourceRoomNames();
      // Logged remote-source rooms: we're already operating there → reachable by definition, so don't status-gate them.
      const names = claimable.filter(r => mined.has(r.self.name))
        .sort((a, b) => Settler.roomScore(b) - Settler.roomScore(a)).map(r => r.self.name);
      if (Settler.canSettle()) { // only chase an expansion target when we can actually claim it (else we'd just reserve it)
        const settle = Settler.freeSettleTarget()?.self.name;
        if (settle && claimable.some(r => r.self.name === settle && r.status === status) && !names.includes(settle)) names.push(settle);
      }
      return names;
    }

    // A target needs (re)reserving if we have no live reservation of ours above the floor (or none at all).
    static needsReservation(name: string): boolean {
      const ctrl = Game.rooms[name]?.controller;
      if (!ctrl) return true; // no vision → assume it needs us (a settler will get vision on arrival)
      const r = ctrl.reservation;
      return !r || r.username !== Settler.username || r.ticksToEnd < RESERVE_FLOOR;
    }

    static get settlers(): Creep[] { return Object.values(Game.creeps).filter(c => c.body.some(p => p.type === CLAIM)); }

    // Spawn a settler only when uncovered rooms outnumber settlers not yet committed to one. Counting unassigned
    // settlers (a freshly-spawned one hasn't run its loop to pick a target yet) stops us spawning a second body into
    // the same room before the first has claimed it in memory.
    static wanted(): boolean {
      const settlers = Settler.settlers;
      const covered = new Set(settlers.map(c => c.memory.reserve_target).filter(Boolean));
      const uncovered = Settler.priorityTargets().filter(name => !covered.has(name) && Settler.needsReservation(name)).length;
      const uncommitted = settlers.filter(c => !c.memory.reserve_target).length;
      return uncovered > uncommitted;
    }

    // Pick (and remember) a claimable room for this settler — sticky while valid, and never a room another settler
    // already holds, so two settlers don't pile onto the same controller.
    static targetFor(creep: Creep): string | undefined {
      const targets = Settler.priorityTargets();
      const current = creep.memory.reserve_target;
      if (current && targets.includes(current)) return current;
      const taken = new Set(Settler.settlers.filter(c => c.name !== creep.name).map(c => c.memory.reserve_target));
      const pick = targets.find(name => !taken.has(name) && Settler.needsReservation(name))
        ?? targets.find(name => !taken.has(name))
        ?? targets[0];
      return creep.memory.reserve_target = pick;
    }

    // Best unowned, claimable, scouted room to CLAIM (expand into) — or undefined if GCL is maxed / nothing worth it.
    static freeSettleTarget(): _Room_ | Serialized<_Room_> | undefined {
      let best: _Room_ | Serialized<_Room_> | undefined, bestScore = 0;
      const mined = Settler.remoteSourceRoomNames();

      for (const room of _Room_.NON_OWNED) {
        const reservation = room.self.controller?.reservation;
        // Skip foreign-held controllers, but a room WE merely reserve is still a valid place to settle into.
        if (!room.self.controller || room.self.controller.owner || (reservation && reservation.username !== Settler.username)) continue;
        if (room.status === 'closed') continue;
        if (mined.has(room.self.name)) continue; // rooms we mine are RESERVE targets, never claim targets
        const s = Settler.roomScore(room);
        if (s > bestScore) { bestScore = s; best = room; }
      }
      return best;
    }

    static bestSpawnPos(room: _Room_ | Serialized<_Room_>): RoomPosition | undefined {
      const name = room.self.name;
      const controller = room.self.controller;
      const terrain = Game.map.getRoomTerrain(name);
      const wall = (x: number, y: number) => terrain.get(x, y) & TERRAIN_MASK_WALL;

      // Terrain-aware move distance from a point to every walkable tile (8-directional BFS, walls impassable). -1 = unreachable.
      const distanceFrom = (sx: number, sy: number): Int16Array => {
        const dist = new Int16Array(ROOM_SIZE * ROOM_SIZE).fill(-1);
        const q: number[] = [sx * ROOM_SIZE + sy];
        dist[sx * ROOM_SIZE + sy] = 0;
        for (let i = 0; i < q.length; i++) {
          const cur = q[i], cx = (cur / ROOM_SIZE) | 0, cy = cur % ROOM_SIZE, d = dist[cur] + 1;
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            if (!dx && !dy) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || nx >= ROOM_SIZE || ny < 0 || ny >= ROOM_SIZE) continue;
            const ni = nx * ROOM_SIZE + ny;
            if (dist[ni] !== -1 || wall(nx, ny)) continue;
            dist[ni] = d; q.push(ni);
          }
        }
        return dist;
      };

      // Mining capacity of a source = open (non-wall) tiles a miner can stand on around it. More slots → more miners →
      // more energy → more haul/spawn traffic, so we pull the spawn harder toward higher-capacity sources.
      const freeSlots = (sx: number, sy: number): number => {
        let n = 0;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          const nx = sx + dx, ny = sy + dy;
          if (nx >= 0 && nx < ROOM_SIZE && ny >= 0 && ny < ROOM_SIZE && !wall(nx, ny)) n++;
        }
        return n;
      };

      // Only sources that can actually be mined (≥1 open slot) influence placement.
      const sources = room.sources
        .map(s => ({ x: s.pos.x, y: s.pos.y, slots: freeSlots(s.pos.x, s.pos.y) }))
        .filter(s => s.slots > 0);
      if (!sources.length) return undefined;

      const fields = sources.map(s => distanceFrom(s.x, s.y));
      const controllerField = controller ? distanceFrom(controller.pos.x, controller.pos.y) : undefined;
      const CONTROLLER_WEIGHT = 0.5; // how many "source-slots worth" the controller proximity counts for

      let best: RoomPosition | undefined, bestScore = Infinity;
      for (let x = 1; x < ROOM_SIZE - 1; x++) for (let y = 1; y < ROOM_SIZE - 1; y++) {
        if (wall(x, y)) continue;
        const i = x * ROOM_SIZE + y;
        if (fields.some(f => f[i] < 2)) continue;                 // unreachable (-1) or jammed against a source
        if (controllerField && controllerField[i] < 0) continue;  // must be reachable from the controller too

        // Squared distances → penalise being far from ANY target (so we land on a balanced middle, not an extreme),
        // each source weighted by its mining-slot count, plus the controller at CONTROLLER_WEIGHT.
        let total = 0, weight = 0;
        for (let k = 0; k < fields.length; k++) {
          total += fields[k][i] * fields[k][i] * sources[k].slots;
          weight += sources[k].slots;
        }
        if (controllerField) { total += controllerField[i] * controllerField[i] * CONTROLLER_WEIGHT; weight += CONTROLLER_WEIGHT; }

        const score = total / weight;
        if (score < bestScore) { bestScore = score; best = new RoomPosition(x, y, name); }
      }
      return best;
    }

    static paintTarget() {
      const target = Settler.freeSettleTarget();
      if (!target) return;

      _Room_.NON_OWNED.forEach(target => {
        const spawn = Settler.bestSpawnPos(target);
        if (!spawn) return;

        new RoomVisual(spawn.roomName).circle(spawn.x, spawn.y, {fill: '#CC00CC', stroke: '#ffffff', radius: 0.5});
      })
    }

    // TODO Dont move into the room if there's a tower still.
    static configuration: Configuration = [[MOVE, CLAIM], [MOVE, CLAIM]]

    loop(): void {
      const targetName = Settler.targetFor(this.self);
      if (!targetName) return; // nothing claimable to work

      const controller = Game.rooms[targetName]?.controller;
      // No vision yet, or not adjacent → travel into the room toward its controller (centre as a fallback heading).
      if (!controller || !this.self.pos.inRangeTo(controller, 1))
        return void this.travel(controller ?? new RoomPosition(ROOM_SIZE / 2, ROOM_SIZE / 2, targetName), { visualizePathStyle: { stroke: '#cc00cc' } });

      // Reserve by default — that's the steady state for remote-mining rooms and keeps others denied to enemies.
      // Claim ONLY this room if it's the chosen settle target (best expansion room) AND we have GCL headroom AND
      // nobody else holds the controller. Every other room just gets reserved.
      if (Settler.freeSettleTarget()?.self.name === targetName
        && Settler.canSettle() && !controller.owner && (!controller.reservation || controller.reservation.username === Settler.username)) {
        const code = this.self.claimController(controller);
        if (code === ERR_GCL_NOT_ENOUGH || code === ERR_INVALID_TARGET) this.self.reserveController(controller);
        return;
      }
      const code = this.self.reserveController(controller);
      if (code === ERR_INVALID_TARGET) this.self.attackController(controller); // reserved/owned by an enemy → tear it down
    }
  }

  // TODO Under attack, the first parts to take hits are those specified first.
  export class Tank extends Obj {
    static configuration: Configuration = [[MOVE, ATTACK], [MOVE, MOVE, ATTACK, TOUGH]]
    
    loop(): void {
      
    }
  }
  export class Infantry extends Obj {
    static configuration: Configuration = [[MOVE, ATTACK], [MOVE, ATTACK]]
    
    loop(): void {
      
    }
  }
  export class Ranged extends Obj {
    static configuration: Configuration = [[MOVE, RANGED_ATTACK], [MOVE, RANGED_ATTACK]]
    // Calculate whether doing massive attack is more 1.5? times more than regular attack.
    loop(): void {
      
    }
  }
  export class Healer extends Obj {
    static configuration: Configuration = [[MOVE, HEAL], [MOVE, HEAL]]
    
    loop(): void {
      
    }
  }

}

type Serialized<T> =
  T extends (...a: any[]) => any ? never
  : T extends ReadonlyArray<infer U> ? Serialized<U>[]
  : T extends object ? { [K in keyof T as T[K] extends (...a: any[]) => any ? never : K]: Serialized<T[K]> }
  : T;
// Per-tick memo: results that are stable within a tick (cost matrices, needsWorker, …) computed once and shared,
// instead of re-running PathFinder/room.find for every creep. Cleared when the tick advances.
let _cache_tick = -1;
const _tick_cache: Record<string, any> = {};
function memo<T>(key: string, fn: () => T): T {
  if (_cache_tick !== Game.time) { _cache_tick = Game.time; for (const k in _tick_cache) delete _tick_cache[k]; }
  return key in _tick_cache ? _tick_cache[key] : (_tick_cache[key] = fn());
}

const SERIALIZE_SKIP = new Set([
  'workers', 'construction_goal', 'exits', 'list_friendlies', 'list_hostiles', 'friendlies', 'hostiles',
  'road_to_controller', 'road_to_extensions', 'road_to_exits', 'road_state', 'next_construction_site',
]);
function serialize<T>(obj: T, depth = 6, seen = new WeakSet<object>()): Serialized<T> {
  if (obj === null || typeof obj !== 'object')
    return (typeof obj === 'function' ? undefined : obj) as Serialized<T>;
  if (depth <= 0 || seen.has(obj)) return undefined as Serialized<T>;

  seen.add(obj);
  let out: unknown;

  if (obj instanceof CreepSelector) {
    return out = { all: serialize(obj.all, depth - 1, seen), some: obj.some } as Serialized<T>
  }

  if (Array.isArray(obj)) {
    out = obj.map(v => serialize(v, depth - 1, seen));
  } else {
    const o: Record<string, unknown> = {};
    const take = (key: string) => {
      if (key in o) return;
      if (key === 'room') return;
      if (key === 'memory') return;
      if (key.startsWith('_')) return;
      // Computational getters: each runs PathFinder / room.find / places construction sites. Caching a room must
      // not invoke them (it ran the whole worker-economics + road-planning chain per source, per room, per tick).
      if (SERIALIZE_SKIP.has(key)) return;

      try {
        const value = (obj as any)[key];
        if (typeof value !== 'function') o[key] = serialize(value, depth - 1, seen);
      } catch { /* getter threw — skip */ }
    };
    for (const key of Object.keys(obj)) take(key);
    for (let p = Object.getPrototypeOf(obj); p && p !== Object.prototype; p = Object.getPrototypeOf(p))
      for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(p)))
        if (desc.get) take(key);
    out = o;
  }

  seen.delete(obj);
  return out as Serialized<T>;
}

class CreepSelector {
  constructor(public at: RoomObject, public creeps: Creep[], public powerCreeps: PowerCreep[] = []) {}

  get all() { return [...this.creeps, ...this.powerCreeps] }

  get wounded() { return new CreepSelector(this.at, this.creeps.filter(c => c.hits < c.hitsMax), this.powerCreeps.filter(c => c.hits < c.hitsMax)); }

  get healers() { return new CreepSelector(this.at, this.creeps.filter(c => c.body.some(p => p.type === HEAL))); }
  get frontline() { return new CreepSelector(this.at, this.creeps.filter(c => c.body.some(p => p.type === ATTACK))); }
  get backline() { return new CreepSelector(this.at, this.creeps.filter(c => c.body.some(p => p.type === RANGED_ATTACK))); }
  get tanky() { return new CreepSelector(this.at, this.creeps.filter(c => c.body.some(p => p.type === TOUGH))); }

  closestByRange() { return this.at.pos.findClosestByRange([...this.creeps, ...this.powerCreeps]) }
  closestByPath() { return this.at.pos.findClosestByPath([...this.creeps, ...this.powerCreeps]) }

  get some() { return this.creeps.length !== 0 || this.powerCreeps.length !== 0; }
}

class _Room_ {

  static ALL: _Room_[] = []
  static REMOTE: Serialized<_Room_>[] = []
  static get NON_OWNED(): (_Room_ | Serialized<_Room_>)[] { return [...this.ALL.filter(x => !x.my_controller), ..._Room_.REMOTE] } 
  static get CLAIMABLE() { return this.NON_OWNED.filter(x => x.self.controller && !x.self.controller.owner) }

  static remote_loop(room: Serialized<_Room_> & { timestamp: number }) {
    if (Game.time - room.timestamp >= ROOM_CACHE_LIFETIME) {
      delete Memory.rooms[room.self.name];
      return;
    }

    _Room_.REMOTE.push(room);
  }

  // Look up a (cached) remote source by id across the scouted-but-unseen rooms — lets a worker keep heading to
  // a target it currently has no vision of. Returns a _Source_ around a minimal stand-in (id + RoomPosition),
  // which is all that's needed to travel there; once in the room, Game.getObjectById resolves the live Source.
  static find_remote_source(id: Id<Source>): Serialized<_Source_> | undefined {
    for (const room of _Room_.REMOTE) {
      const src = (room.sources as any[]).find(s => s.self.id === id);
      if (src) return src as Serialized<_Source_>;
    }
    return undefined;
  }

  constructor(public self: Room) { }

  get spawners() { return this.self.find(FIND_MY_SPAWNS).map(x => new Structures.Spawn(x)) }
  get sources() { return this.self.find(FIND_SOURCES).map(x => new _Source_(x)) }
  get minerals() { return this.self.find(FIND_MINERALS).map(x => new _Mineral_(x)) }
  get my_controller() { return this.self.controller?.my ? this.self.controller : undefined }

  get status() { return Game.map.getRoomStatus(this.self.name).status }

  get exits(): Record<'top' | 'bottom' | 'left' | 'right', RoomPosition[]> | undefined {
    const exitDirs = Game.map.describeExits(this.self.name);
    if (!exitDirs) return;

    const exits: any = {}
    for (const [direction, find] of  [['top', FIND_EXIT_TOP], ['bottom', FIND_EXIT_BOTTOM], ['left', FIND_EXIT_LEFT], ['right', FIND_EXIT_RIGHT]]) {
      const neighbour = (exitDirs as any)[find];
      if (!neighbour || Game.map.getRoomStatus(neighbour).status !== this.status) continue;

      const entries = this.self.find(find as FindConstant);
      if (entries.length === 0) continue;
      exits[direction] = entries;
    }
    return exits;
  }

  get construction_goal(): ConstructionSite | undefined {
    return memo('construction_goal:' + this.self.name, () => this._construction_goal());
  }
  private _construction_goal(): ConstructionSite | undefined {
    const site = (type: StructureConstant) => {
      const sites = this.self.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === type });
      return sites.length > 0 ? sites[0] : undefined
    };

    if (this.spawners.length > 0 && !this.has_max_extensions()) {
      // Extensions: checkerboard ring outward from the spawn, but `bounded` so we pack close to the spawn
      // instead of reaching over a wall to the far side.
      return site(STRUCTURE_EXTENSION) ?? this.place_checkerboard(STRUCTURE_EXTENSION, this.spawners[0].self.pos, 2, 12, true);

    } else if (this.needsContainer()) {
      const source = (this.needsContainer() as _Source_[])[0];
      return site(STRUCTURE_CONTAINER) ?? this.place_checkerboard(STRUCTURE_CONTAINER, source.self.pos, 2, 3);

    } else if (this.needsTower()) {
      return site(STRUCTURE_TOWER) ?? this.place_checkerboard(STRUCTURE_TOWER, this.spawners[0].self.pos, 1, 3);

    } else if (this.needsRoad()) {
      const road = (this.needsRoad() as Structures.Road[])[0];
      road.place();

      const s = road.next_construction_site(this.spawners[0].self);
      if (!s) { console.error('Expected a road to build.'); return undefined; }
      return s;
    }
//  if (this.room.find(FIND_MY_SPAWNS).length || this.target) return; // already have one / site placed
      // const pos = Unit.bestSpawnPos(this.room);
      // if (pos) this.room.createConstructionSite(pos, STRUCTURE_SPAWN);
    // }

  }

  // The single source of the checkerboard pattern: every non-wall tile of the given parity in the ring
  // [min,max] around `center`. parity 0 = the structure tiles ((x+y) even), 1 = the movement lanes between
  // them (what roads pave). `bounded`: skip tiles whose PATH from the spawn is much longer than their
  // straight-line range (a wall/detour) — so we fill close to the spawn, not over a wall to the far side.
  // Does NOT filter occupied tiles — each caller decides what to do with those.
  checkerboard_tiles(center: RoomPosition, min: number, max: number, parity: 0 | 1 = 0, bounded = false): RoomPosition[] {
    const terrain = this.self.getTerrain();
    const spawn = this.spawners[0]?.self.pos;
    const sources = this.self.find(FIND_SOURCES);                          // keep each source's mining ring clear
    const tiles: RoomPosition[] = [];
    for (let r = min; r <= max; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;          // only the ring at radius r
        const x = center.x + dx, y = center.y + dy;
        if (x < 1 || x > 48 || y < 1 || y > 48) continue;
        if ((x + y) % 2 !== parity) continue;
        if (terrain.get(x, y) & TERRAIN_MASK_WALL) continue;
        const pos = new RoomPosition(x, y, this.self.name);
        if (sources.some(s => pos.inRangeTo(s, 1))) continue;             // never build on a tile a miner stands on
        if (bounded && spawn) {
          const route = PathFinder.search(spawn, { pos, range: 0 }, { plainCost: 1, swampCost: 1, maxRooms: 1 });
          if (route.incomplete || route.path.length > spawn.getRangeTo(pos) * 1.5) continue; // over a wall / big detour
        }
        tiles.push(pos);
      }
    }
    return tiles;
  }

  // Place `type` on the first free (no structure/site) structure-checkerboard tile, returning the created site.
  place_checkerboard(type: BuildableStructureConstant, center: RoomPosition, min: number, max: number, bounded = false): ConstructionSite | undefined {
    for (const pos of this.checkerboard_tiles(center, min, max, 0, bounded)) {
      if (this.self.lookForAt(LOOK_STRUCTURES, pos).length || this.self.lookForAt(LOOK_CONSTRUCTION_SITES, pos).length) continue;
      if (this.self.createConstructionSite(pos, type) === OK) return this.self.lookForAt(LOOK_CONSTRUCTION_SITES, pos)[0];
    }
    return undefined;
  }

  has_max_extensions() { return this.self.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_EXTENSION }).length >= this.max_extensions }
  get max_extensions() { return this.self.controller ? CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][this.self.controller.level] : 0; }

  road(name: string, from: RoomPosition, to: RoomPosition) {
    return new Structures.Road(name, () => PathFinder.search(from, { pos: to, range: 2 }, {
      plainCost: 2, swampCost: 10, maxOps: 4000,
      roomCallback: (roomName) => {
        const cm = new PathFinder.CostMatrix();
        const room = Game.rooms[roomName];
        if (!room) return cm;
        for (const s of room.find(FIND_STRUCTURES)) {
          if (s.structureType === STRUCTURE_ROAD) cm.set(s.pos.x, s.pos.y, 1);
          else if (s.structureType === STRUCTURE_CONTAINER) cm.set(s.pos.x, s.pos.y, 255);
        }
        for (const cs of room.find(FIND_CONSTRUCTION_SITES)) {
          if (cs.structureType === STRUCTURE_ROAD) cm.set(cs.pos.x, cs.pos.y, 1);
          else if (cs.structureType === STRUCTURE_CONTAINER) cm.set(cs.pos.x, cs.pos.y, 255);
        }
        return cm;
      },
    }).path);
  }
  road_grid(name: string, spawn: RoomPosition): Structures.Road {
    // The spawn's movement lanes: the OFF-checkerboard tiles (parity 1) between the structures, bounded so we
    // only pave near the spawn — not over a wall to the far side. Computed once and cached by Structures.Road.
    return new Structures.Road(name, () => this.checkerboard_tiles(spawn, 1, ROAD_FILL_RADIUS, 1, true));
  }

  creep_selector(at: RoomObject, creeps: Creep[], powerCreeps: PowerCreep[]) { return new CreepSelector(at, creeps, powerCreeps); }

  middle(): RoomPosition { return new RoomPosition(Math.ceil(ROOM_SIZE / 2), Math.floor(ROOM_SIZE / 2), this.self.name); }

  get list_friendlies() { return this.friendlies(); }
  get list_hostiles() { return this.hostiles(); }
  friendlies(at: RoomObject = { room: this.self, pos: this.middle() } as RoomObject) { return this.creep_selector(at,
    this.self.find(FIND_CREEPS, { filter: x => x.my || FRIENDLY_PLAYERS.includes(x.owner.username) }),
    this.self.find(FIND_POWER_CREEPS, { filter: x => x.my || FRIENDLY_PLAYERS.includes(x.owner.username) }),
  ); }
  hostiles(at: RoomObject = { room: this.self, pos: this.middle() } as RoomObject) { return this.creep_selector(at,
    this.self.find(FIND_HOSTILE_CREEPS, { filter: x => !FRIENDLY_PLAYERS.includes(x.owner.username) }),
    this.self.find(FIND_HOSTILE_POWER_CREEPS, { filter: x => !FRIENDLY_PLAYERS.includes(x.owner.username) }),
  ); }

  loop(): void {
    const towers = this.self.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER }).map(x => new Structures.Tower(x));
    for (const tower of towers) { tower.loop(); }
  
    this.save_cache();
  }

  save_cache(): void {
    if (this.my_controller) return; // Don't cache if we'll certainly get an next tick.
    const cached = Memory.rooms[this.self.name];
    if (cached && Game.time - cached.timestamp < 10) return; // refresh at most every 10 ticks (positions don't move)
    this.self.memory = serialize(this);
    this.self.memory.timestamp = Game.time;
  }

  bestAffordableUnit(configuration: Unit.Configuration, budget = this.self.energyCapacityAvailable) {
    const base = configuration[0]; const repeated = configuration[1];
    const baseCost = Unit.cost(base), repeatedCost = Unit.cost(repeated);
    const maxUnits = repeated.length === 0 ? 0 : Math.floor((MAX_CREEP_SIZE - base.length) / repeated.length);
    const times = Math.max(0, Math.min(maxUnits, repeatedCost === 0 ? 0 : Math.floor((budget - baseCost) / repeatedCost)));
    return [...base, ...Array.from({ length: times }, () => repeated).flat()];
  }

  needsTower(): false | Structures.Spawn[] {
    const spawners = this.spawners.filter(x => !x.has_tower());
    return spawners.length === 0 ? false : spawners;
  }
  // Mirror needsWorker, but room-level: how much enters the haul system each regen cycle vs. how much the haulers
  // can move. Energy to haul = mining capacity of local sources that have a container (range 3, matching where we
  // place them) plus the remote sources we drop-mine and shuttle home.
  needsTransporter(): boolean {
    return memo('needsTransporter:' + this.self.name, () => this._needsTransporter());
  }
  private _needsTransporter(): boolean {
    const spawn = this.spawners[0];
    if (!spawn) return false;

    const containers = this.self.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER });
    const producers = this.sources.filter(s => containers.some(c => c.pos.inRangeTo(s.self, 3)));
    const production = producers.reduce((sum, s) => sum + s.self.energyCapacity, 0)
      + spawn.close_remote_sources().reduce((sum, s) => sum + (s as any).self.energyCapacity, 0);
    if (production === 0) return false;

    // One representative hauler's per-cycle throughput (a single trip estimate = a few PathFinder calls) times how
    // many we have — instead of summing every transporter's own trip (that was O(transporters) PathFinder per tick).
    const body = this.bestAffordableUnit(Unit.Transporter.roaded_configuration(this));
    const candidate = new Unit.Transporter({
      body: body.map(type => ({ type, hits: 100 })),
      memory: {},
      pos: spawn.self.pos,
      room: this.self,
    } as unknown as Creep);

    // Measure the haul from a PRODUCING source-container — NOT from the spawn. The candidate stands on the spawn, so
    // trip_downtime's closestCollectable() picked whatever loose energy was nearest the spawn, already beside a sink →
    // travelTimeTo (range 1) returns 0 → throughput looks infinite → we never spawn a hauler. Instead measure the real
    // distance from a container to where the load lands: an open sink, or the controller when everything's topped off
    // (a long, slow upgrade haul — exactly when we want MORE haulers moving the surplus).
    const sourceContainers = containers.filter(c => producers.some(s => c.pos.inRangeTo(s.self, 1)));
    const from = new _Position_((sourceContainers[0] ?? producers[0]?.self ?? spawn.self) as RoomObject);
    const dest = from.closestFillable({ ignore_capacity: false }) ?? this.my_controller;
    if (!dest) return false;
    const trip = from.travelTimeTo(dest) * 2;
    if (trip === Infinity) return false; // unreachable → don't over-spawn

    const perHauler = candidate.load / (candidate.load_time + trip) * ENERGY_REGEN_TIME;
    return this.transporters.length * perHauler < production * TRANSPORTER_HEADROOM;
  }
  get transporters() {
    return this.self.find(FIND_MY_CREEPS).filter(x => x.body.filter(p => p.type === CARRY).length >= 2).map(x => new Unit.Transporter(x));
  }
  needsWorker(): false | (Serialized<_Source_> | _Source_)[] {
    // Memoized per tick — called per delivering worker, and each source's needsWorker() runs PathFinder per worker.
    return memo('needsWorker:' + this.self.name, () => {
      const sources = [
        ...this.sources.filter(x => x.needsWorker()),
        ...this.spawners.flatMap(x => x.close_remote_sources()).filter(x => x instanceof _Source_ ? x.needsWorker() : !Object.values(Game.creeps).some(c => c.memory.target === (x as any).self.id && c.body.some(p => p.type === WORK) && c.body.filter(p => p.type === CARRY).length < 2))
      ]
      return sources.length === 0 ? false : sources;
    });
  }
  needsContainer(): false | _Source_[] {
    const sources = this.sources.filter(x => !x.has_max_containers());
    return sources.length === 0 ? false : sources;
  }
  needsRoad(): false | Structures.Road[] {
    const roads = this.spawners.flatMap(x => [x.road_to_controller, x.road_to_extensions, ...x.road_to_exits]).filter(x => !x.completed);
    return roads.length === 0 ? false : roads;
  }

  needsSettler() {
    return _Room_.CLAIMABLE.length !== 0;
  }

}
class _Source_ {
  constructor(public self: Source) { }

  get room() { return new _Room_(this.self.room) }
  get pos() { return new _Position_(this.self) }

  has_max_containers() { return this.self.room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER && s.pos.inRangeTo(this.self, 4) } ).length >= this.max_containers }
  get max_containers() { 
    if (!this.self.room.controller?.my) return 0;
    return Math.max(2, Math.floor(CONTROLLER_STRUCTURES[STRUCTURE_CONTAINER][this.self.room.controller?.level ?? 0] / this.room.sources.length));
  }

  needsWorker(): boolean {
    // One representative worker's trip estimate (a single PathFinder) times how many are assigned here — instead of
    // computing every assigned worker's own trip (that was O(workers) PathFinder per source per tick).
    const body = this.room.bestAffordableUnit(Unit.Worker.configuration);
    const candidate = new Unit.Worker({
      body: body.map(type => ({ type, hits: 100 })),
      memory: { target: this.self.id },
      pos: this.self.pos,
      room: this.self.room,
    } as unknown as Creep);

    const trip = candidate.trip_downtime;
    if (trip === Infinity) return false;
    if (candidate.revenue <= 0) return false;

    const n = this.workers;
    if (n.reduce((a, x) => a + x.revenue, 0) / CREEP_LIFE_TIME * ENERGY_REGEN_TIME >= this.self.energyCapacity) return false;

    const spacesUsed = n.length * candidate.load_time / (candidate.load_time + trip);
    const freeBySpace = Math.max(0, 1 - spacesUsed / this.pos.adjacentSpaces());
    return candidate.revenue * freeBySpace > Unit.cost(body);
  }

  get workers() {
    return Object.values(Game.creeps).filter(x => x.memory.target === this.self.id).map(x => new Unit.Worker(x));
  }
}
class _Mineral_ {
  constructor(public self: Mineral) { }

  get room() { return this.self.room ? new _Room_(this.self.room) : undefined }
  get pos() { return new _Position_(this.self) }
}

// A live RoomPosition has methods; a serialized/cached one is plain { x, y, roomName }. Normalise to a real one.
function roomPosOf(pos: RoomPosition | { x: number; y: number; roomName: string }): RoomPosition {
  return pos instanceof RoomPosition ? pos : new RoomPosition(pos.x, pos.y, pos.roomName);
}

type LookFilter = { ignore_creeps: boolean | ((creep: Creep) => boolean) }
class _Position_ {
  constructor(public self: RoomObject) { }

  closestByRoute<T extends { pos: RoomPosition }>(targets: T[]): T | undefined {
    const origin = this.self.pos;
    if (!origin) return undefined;
    const goals = targets.filter(t => t.pos).map(t => ({ pos: t.pos, range: 1 }));
    if (goals.length === 0) return undefined;
    const result = PathFinder.search(origin, goals, { maxOps: 4000 });
    if (result.incomplete) return undefined;
    const end = result.path.length ? result.path[result.path.length - 1] : origin;
    return targets.find(t => t.pos && t.pos.roomName === end.roomName && t.pos.getRangeTo(end) <= 1);
  }

  get room(): Room | undefined { return this.self.room ?? Game.rooms[this.self.pos.roomName] }

  get x() { return this.self.pos.x; }; get y() { return this.self.pos.y; }

  adjacentSpaces(filter: LookFilter = { ignore_creeps: true }): number {
    const room = this.room;
    if (!room) return 0;
    const adjacent = room.lookForAtArea(LOOK_TERRAIN, this.y - 1, this.x - 1, this.y + 1, this.x + 1, true);
    return adjacent.filter(t => {
      if (t.terrain === 'wall') return false;
      if (t.x === this.x && t.y === this.y) return false;
      
      const blocked = room.lookForAt(LOOK_STRUCTURES, t.x, t.y).some(s =>
        s.structureType !== STRUCTURE_CONTAINER 
        && s.structureType !== STRUCTURE_ROAD 
        && (s.structureType !== STRUCTURE_RAMPART || !(s as StructureRampart).my)
      );
      
      if (blocked) return false;

      return room.lookForAt(LOOK_CREEPS, t.x, t.y).every(x => filter.ignore_creeps === true || filter.ignore_creeps && filter.ignore_creeps(x));
    }).length;
  }

  travelTimeTo(target: RoomObject | RoomPosition): number {
    const to = target instanceof RoomPosition ? target : target.pos;
    const result = PathFinder.search(this.self.pos, { pos: to, range: 1 }, { maxOps: 4000 });
    return result.incomplete ? Infinity : result.path.length;
  }

  closestFillable(opts: { ignore_capacity: boolean } = { ignore_capacity: false }, include: StructureConstant[] = [STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_TOWER, STRUCTURE_CONTAINER]): StructureSpawn | StructureExtension | StructureTower | StructureContainer | null {
    // Across ALL visible rooms (so a remote miner can deliver to a home sink), pick the closest by route.
    // Only OUR spawn/extension/tower (never a hostile one); containers are unowned so any is fair game.
    const candidates = _Room_.ALL.flatMap(r => {
      const reserveForSpawn = r.my_controller && r.self.energyAvailable < r.self.energyCapacityAvailable; // still filling spawn/extensions → don't load towers yet
      return r.self.find(FIND_STRUCTURES, {
        filter: s => include.includes(s.structureType)
          && (s.structureType === STRUCTURE_CONTAINER || (s as OwnedStructure).my)
          && !(reserveForSpawn && s.structureType === STRUCTURE_TOWER)
          && (opts.ignore_capacity || ('store' in s && (s.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0) > 0)),
      });
    }) as (StructureSpawn | StructureExtension | StructureTower | StructureContainer)[];
    return this.closestByRoute(candidates) ?? null;
  }
  closestCollectable(include: StructureConstant[] = [STRUCTURE_CONTAINER]): StructureSpawn | StructureExtension | StructureTower | StructureContainer | Resource | null {
    const candidates = _Room_.ALL.flatMap(r => [
      ...r.self.find(FIND_STRUCTURES, {
        filter: s => include.includes(s.structureType) && 'store' in s && (s.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0) > 0,
      }),
      ...r.self.find(FIND_DROPPED_RESOURCES, { filter: res => res.resourceType === RESOURCE_ENERGY }), // leftover energy on the ground
    ]) as (StructureSpawn | StructureExtension | StructureTower | StructureContainer | Resource)[];
    return this.closestByRoute(candidates) ?? null;
  }
  closestSpawn() {
    return this.closestByRoute(_Room_.ALL.filter(x => x.my_controller && x.spawners.length > 0).flatMap(x => x.spawners).map(x => x.self)) ?? null;
  }
  
  get road_state(): 'done' | 'pending' | 'todo' | 'skip' {
    if (Game.map.getRoomTerrain(this.self.pos.roomName).get(this.x, this.y) & TERRAIN_MASK_WALL) return 'skip';
    const room = Game.rooms[this.self.pos.roomName];
    if (!room) return 'skip'; // no vision → can't see/build it right now
    const structs = room.lookForAt(LOOK_STRUCTURES, this.self.pos);
    if (structs.some(s => s.structureType === STRUCTURE_ROAD)) return 'done';
    if (structs.length) return 'skip';
    const sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, this.self.pos);
    if (sites.some(s => s.structureType === STRUCTURE_ROAD)) return 'pending';
    if (sites.length) return 'skip';
    return 'todo';
  }
}

namespace Structures {

  export abstract class Obj<T extends Structure> {
    constructor(public self: T) { }
    get room() { return new _Room_(this.self.room) }
    get pos() { return new _Position_(this.self) }
    abstract loop(): void
  }

  const road_cache: Record<string, { x: number; y: number; roomName: string }[]> = {};
  export class Road {
    constructor(public name: string, private compute: () => RoomPosition[]) {}

    private get tiles() { 
      if (!road_cache[this.name]) road_cache[this.name] = this.compute().map(p => ({ x: p.x, y: p.y, roomName: p.roomName }));
      return road_cache[this.name].map(t => new _Position_({pos: new RoomPosition(t.x, t.y, t.roomName)} as any));
    }

    next_construction_site(from: RoomObject): ConstructionSite | undefined {
      const pos = from.pos.findClosestByPath(this.tiles.filter(x => x.road_state === 'pending').map(x => x.self))
      if (!pos) return;
      const sites = pos.room?.lookForAt(LOOK_CONSTRUCTION_SITES, pos);
      return sites ? sites[0] : undefined;
    }

    completed(): boolean {
      return this.tiles.every(x => { const s = x.road_state; return s === 'done' || s === 'skip'; });
    }

    place(): void {
      for (const x of this.tiles) if (x.room && x.road_state === 'todo') x.room.createConstructionSite(x.self, STRUCTURE_ROAD);
    }
  }

  export class Spawn extends Obj<StructureSpawn> {

    has_tower() { return this.self.room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER && s.pos.inRangeTo(this.self, 4) } ).length >= 1 }

    spawnCreep(body: BodyPartConstant[], opts?: SpawnOptions) { return this.self.spawnCreep(body, 'Creep' + Game.time, opts); }

    get road_to_controller(): Structures.Road { return this.room.road(`${this.self.id}.road_to_controller`, this.self.pos, this.room.my_controller!.pos); }
    get road_to_extensions(): Structures.Road { return this.room.road_grid(`${this.self.id}.road_to_extensions`, this.self.pos); }
    get road_to_exits(): Structures.Road[] { 
      return Object.entries(this.room.exits ?? {}).map(([direction, exits]: any) => this.room.road(`${this.self.id}.road_to_exits.${direction}`, this.self.pos, exits[Math.floor(exits.length / 2)]))
    }

    loop(): void {
      console.log(this.room.needsTransporter())
      // TODO IF IN WAR
      if (this.self.spawning) return; // busy → skip all the spawn-decision work (needsWorker/needsTransporter/road scans)

      // Workers are the lifeblood. Whenever one is needed (or none mine THIS room — remote miners don't refill our
      // spawn), revert everything to replacing them: spawn the best we can afford from energy ON HAND right now —
      // never wait for full capacity, or they die off faster than we replace them — and let nothing else spawn until
      // it's handled. energyAvailable == capacity when the spawn's full, so healthy-economy workers stay full size.
      const localSources = new Set(this.room.sources.map(s => s.self.id));
      const localWorkers = Object.values(Game.creeps).filter(c =>
        c.body.some(p => p.type === WORK) && c.body.filter(p => p.type === CARRY).length < 2 && localSources.has(c.memory.target as Id<Source>)).length;
      if (localWorkers === 0 || this.room.needsWorker()) {
        const body = this.room.bestAffordableUnit(Unit.Worker.configuration, this.self.room.energyAvailable);
        if (body.includes(WORK)) this.spawnCreep(body); // below a functional worker → wait, don't waste energy on a stub
        return;
      }

      if (this.room.needsTransporter()) return void this.spawnCreep(this.room.bestAffordableUnit(Unit.Transporter.roaded_configuration(this.room)));

      // Settlers: reserve (and, with GCL headroom, claim) our claimable rooms — remote-mined ones first.
      if (Unit.Settler.wanted()) {
        const body = this.room.bestAffordableUnit(Unit.Settler.configuration);
        if (body.includes(CLAIM)) return void this.spawnCreep(body); // below a 1-CLAIM settler → wait, don't waste energy
      }

      if (Unit.Scout.count() === 0) this.spawnCreep(this.room.bestAffordableUnit(Unit.Scout.configuration));
    }

    // Every source in the scouted, not-currently-visible remote rooms we've cached this tick.
    close_remote_sources(): (Serialized<_Source_> | _Source_)[] {
      // Memoized per tick — two PathFinder calls per remote source, and it's read from needsWorker/needsTransporter.
      const home = this.self.room.name;
      return memo('close_remote_sources:' + this.self.id, () => [
        ..._Room_.REMOTE.flatMap(room => room.sources),
        ..._Room_.ALL.filter(x => !x.my_controller).flatMap(room => room.sources)
      ] // cheap room-distance gate first: a source within REMOTE_SOURCE_RANGE tiles is at most ~1 room away — skips a
        // PathFinder per source for every far-off scouted room (_Room_.REMOTE holds everything we've ever cached).
       .filter(x => Game.map.getRoomLinearDistance(home, (x as any).pos.self.pos.roomName) <= 1)
       .filter(x => this.pos.travelTimeTo(x.pos.self as RoomObject) <= REMOTE_SOURCE_RANGE)
       .filter(x => new _Position_(x.pos.self as RoomObject).closestSpawn()?.id === this.self.id));
    }

  }
  
  export class Tower extends Obj<StructureTower> {

    loop(): void {
      const friendlies = this.room.friendlies(this.self);
      const hostiles = this.room.hostiles(this.self);

      if (hostiles.some) {
        const enemy = (hostiles.healers.some ? hostiles.healers : hostiles).closestByRange();
        
        if (enemy) {
          this.self.attack(enemy);
          return;
        }
      }

      const wounded = friendlies.wounded;
      const friendly = (wounded.healers.some ? wounded.healers : wounded).closestByRange();
      if (friendly) {
        this.self.heal(friendly);
        return;
      }

      // Keep a reserve for defence.
      if ((this.self.store[RESOURCE_ENERGY] ?? 0) <= TOWER_REPAIR_RESERVE) return;

      // Repair
      const damaged = this.self.pos.findClosestByRange(
        this.room.self.find(FIND_STRUCTURES, {
          filter: s => s.hits < s.hitsMax 
            && s.structureType !== STRUCTURE_WALL
            && (s.structureType !== STRUCTURE_RAMPART || s.hits < TOWER_BARRIER_TARGET),
        })
      );
      if (damaged) {
        this.self.repair(damaged);
        return;
      }
    }
  }
}