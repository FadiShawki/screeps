const BUILD_DEDICATION = 0.7;
const UPGRADE_DEDICATION = 0.3;

const TOWER_REPAIR_RESERVE = TOWER_CAPACITY / 2;
const TOWER_BARRIER_TARGET = 30000;

const FRIENDLY_PLAYERS = ['nvim']

interface CreepMemory {
  target?: Id<Source> | Id<Creep>
}
interface RoomMemory {

}
interface Memory {
  creeps: { [name: string]: CreepMemory };
  powerCreeps: { [name: string]: PowerCreepMemory };
  flags: { [name: string]: FlagMemory };
  rooms: { [name: string]: RoomMemory };
  spawns: { [name: string]: SpawnMemory };
}
declare const Memory: Memory;

export function loop() {
  // Clear dead creeps.
  for (const name in Memory.creeps) if (!Game.creeps[name]) delete Memory.creeps[name];
  for (const name in Memory.powerCreeps) if (!Game.creeps[name]) delete Memory.powerCreeps[name];

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

    travel(
      target: RoomPosition | { pos: RoomPosition },
      opts?: MoveToOpts,
    ) {
      return this.self.moveTo(target, opts);
    }

  }
  export class Worker extends Obj {
    static configuration: Configuration = [[CARRY], [MOVE, WORK]]

    get carrying(): ResourceConstant | undefined {
      for (const r in this.self.store) if ((this.self.store as any)[r] !== 0) return r as ResourceConstant;
      return undefined;
    }

    get target(): _Source_ | undefined {
      if (this.self.memory.target === undefined) {
        const targets = this.room.needsWorker();
        if (!targets) return undefined;
        this.self.memory.target = this.self.pos.findClosestByPath(targets.map(x => x.self))!.id;
      }
      
      const target = Game.getObjectById(this.self.memory.target);
      if (!target) { this.self.memory.target = undefined; return; }
      
      if (target instanceof Source) return new _Source_(target);
      console.error('Memory target is not valid.')
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
      const fillable = target.pos.closestFillable({ ignore_capacity: true, ignoreCreeps: true });
      if (!fillable) return Infinity;
      return this.pos.travelTimeTo(fillable) * 2;
    }
    get downtime(): number { return this.lifetime_trips * this.trip_downtime }

    loop(): void { this.gather(); }

    gather(): void {
      if (this.self.store.getFreeCapacity(this.carrying) === 0) return this.deliver();

      const target = this.target;
      if (!target) { return this.idle(); }

      if (this.self.harvest(target.self) === ERR_NOT_IN_RANGE) this.travel(target.self, { visualizePathStyle: { stroke: '#ffaa00' }})
    }

    idle(): void {

    }

    energyDeliveryTarget() {
      let target: StructureController | StructureSpawn | StructureTower | StructureExtension | StructureContainer | null = null;
      target = this.pos.closestFillable();
      return target ?? this.room.my_controller ?? null;
    }

    deliver(): void {
      if (!this.carrying) return this.gather();

      let target: ConstructionSite | StructureController | StructureSpawn | StructureTower | StructureExtension | StructureContainer | null = null;


      if (this.carrying === RESOURCE_ENERGY) {
        target = this.energyDeliveryTarget();
      }

      if (!target) { return this.idle(); }

      if (target instanceof ConstructionSite) {
        if (this.self.build(target) === ERR_NOT_IN_RANGE) this.travel(target, { visualizePathStyle: { stroke: '#0000ff' } });
      } else if (target instanceof StructureController) {
        if (this.self.upgradeController(target) === ERR_NOT_IN_RANGE) this.travel(target, { visualizePathStyle: { stroke: '#00CC00' } });
      } else {
        if (this.self.transfer(target, this.carrying) === ERR_NOT_IN_RANGE) this.travel(target, { visualizePathStyle: { stroke: '#ffffff' } });
      }
    }

  }
  export class Transporter extends Worker {
    static configuration: Configuration = [[MOVE, MOVE, WORK, CARRY], [MOVE, MOVE, WORK, CARRY]]
  }
  export class Scout extends Obj {
    static configuration: Configuration = [[MOVE], []]
    
    loop(): void {
      
    }
  }
  export class Settler extends Obj {
    // TODO Dont move into the room if there's a tower still.
    static configuration: Configuration = [[MOVE, CLAIM], [MOVE, CLAIM]]
    
    loop(): void {
      
    }
  }
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

class _Room_ {
  constructor(public self: Room) { }

  get spawners() { return this.self.find(FIND_MY_SPAWNS).map(x => new Structures.Spawn(x)) }
  get sources() { return this.self.find(FIND_SOURCES).map(x => new _Source_(x)) }
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
    const site = (type: StructureConstant) => {
      const sites = this.self.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === type });
      return sites.length > 0 ? sites[0] : undefined
    };

    if (this.spawners.length > 0 && !this.has_max_extensions()) {
      if (site(STRUCTURE_EXTENSION)) return site(STRUCTURE_EXTENSION);

    } else if (this.needsContainer()) {
      if (site(STRUCTURE_CONTAINER)) return site(STRUCTURE_CONTAINER);

    } else if (this.needsTower()) {
      if (site(STRUCTURE_TOWER)) return site(STRUCTURE_TOWER);
      
    } else if (this.needsRoad()) {
      const road = (this.needsRoad() as Structures.Road[])[0];
      road.place();

      const site = road.next_construction_site(this.spawners[0].self);
      if (!site) { console.error('Expected a road to build.'); return undefined; }
      return site;
    }
//  if (this.room.find(FIND_MY_SPAWNS).length || this.target) return; // already have one / site placed
      // const pos = Unit.bestSpawnPos(this.room);
      // if (pos) this.room.createConstructionSite(pos, STRUCTURE_SPAWN);
    // }

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
  road_grid(name: string, spawn: RoomPosition) {
    return new BuildRoad(room, 'fill', () => fillRoadTiles(room, spawn), priority);
  }

  creep_selector(at: RoomObject, creeps: Creep[], powerCreeps: PowerCreep[]) {
    class CreepSelector {
      constructor(public creeps: Creep[], public powerCreeps: PowerCreep[] = []) {}
      get wounded() { return new CreepSelector(this.creeps.filter(c => c.hits < c.hitsMax), this.powerCreeps.filter(c => c.hits < c.hitsMax)); }

      get healers() { return new CreepSelector(this.creeps.filter(c => c.body.some(p => p.type === HEAL))); }
      get frontline() { return new CreepSelector(this.creeps.filter(c => c.body.some(p => p.type === ATTACK))); }
      get backline() { return new CreepSelector(this.creeps.filter(c => c.body.some(p => p.type === RANGED_ATTACK))); }
      get tanky() { return new CreepSelector(this.creeps.filter(c => c.body.some(p => p.type === TOUGH))); }

      closestByRange() { return at.pos.findClosestByRange([...this.creeps, ...this.powerCreeps]) }
      closestByPath() { return at.pos.findClosestByPath([...this.creeps, ...this.powerCreeps]) }

      some() { return this.creeps.length !== 0 && this.powerCreeps.length !== 0; }
    }
    return new CreepSelector(creeps, powerCreeps);
  }

  friendlies(at: RoomObject) { return this.creep_selector(at,
    this.self.find(FIND_CREEPS, { filter: x => x.my || FRIENDLY_PLAYERS.includes(x.owner.username) }),
    this.self.find(FIND_POWER_CREEPS, { filter: x => x.my || FRIENDLY_PLAYERS.includes(x.owner.username) }),
  ); }
  hostiles(at: RoomObject) { return this.creep_selector(at,
    this.self.find(FIND_HOSTILE_CREEPS, { filter: x => !FRIENDLY_PLAYERS.includes(x.owner.username) }),
    this.self.find(FIND_HOSTILE_POWER_CREEPS, { filter: x => !FRIENDLY_PLAYERS.includes(x.owner.username) }),
  ); }

  loop(): void {
    const towers = this.self.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER }).map(x => new Structures.Tower(x));
    for (const tower of towers) { tower.loop(); }
  }

  bestAffordableUnit(configuration: Unit.Configuration) {
    const budget = this.self.energyCapacityAvailable;
    
    const base = configuration[0]; const repeated = configuration[1];
    const baseCost = Unit.cost(base), repeatedCost = Unit.cost(repeated);
    const maxUnits = Math.floor((MAX_CREEP_SIZE - base.length) / repeated.length);
    const times = Math.min(maxUnits, Math.floor((budget - baseCost) / repeatedCost));
    return [...base, ...Array.from({ length: times }, () => repeated).flat()];
  }

  needsTower(): false | Structures.Spawn[] {
    const spawners = this.spawners.filter(x => !x.has_tower());
    return spawners.length === 0 ? false : spawners;
  }
  needsWorker(): false | _Source_[] {
    const sources = this.sources.filter(x => x.needsWorker());
    return sources.length === 0 ? false : sources;
  }
  needsContainer(): false | _Source_[] {
    const sources = this.sources.filter(x => x.has_max_containers());
    return sources.length === 0 ? false : sources;
  }
  needsRoad(): false | Structures.Road[] {
    const roads = this.spawners.flatMap(x => [x.road_to_controller, x.road_to_extensions, x.road_to_exits]).filter(x => !x.completed);
    return roads.length === 0 ? false : roads;
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
    let drainedPerCycle = 0;
    let spacesUsed = 0;
    for (const w of this.workers) {
      if (w.trip_downtime === Infinity) continue;

      drainedPerCycle += w.revenue / CREEP_LIFE_TIME * ENERGY_REGEN_TIME;
      spacesUsed += w.load_time / (w.load_time + w.trip_downtime);
    }

    if (drainedPerCycle >= this.self.energyCapacity) return false;

    const body = this.room.bestAffordableUnit(Unit.Worker.configuration);
    const candidate = new Unit.Worker({
      body: body.map(type => ({ type, hits: 100 })),
      memory: { target: this.self.id },
      pos: this.self.pos,
      room: this.self.room,
    } as unknown as Creep);

    if (candidate.revenue <= 0) return false;

    const freeBySpace = Math.max(0, 1 - spacesUsed / this.pos.adjacentSpaces());
    return candidate.revenue * freeBySpace > Unit.cost(body);
  }

  get workers() {
    return this.room.self.find(FIND_MY_CREEPS).filter(x => x.memory.target === this.self.id).map(x => new Unit.Worker(x));
  }
}
class _Mineral_ {
  constructor(public self: Mineral) { }
}

type LookFilter = { ignore_creeps: boolean | ((creep: Creep) => boolean) }
class _Position_ {
  constructor(public self: RoomObject) { }

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
    return this.self.pos.findPathTo(to, { ignoreCreeps: true }).length; // TODO Now only counts everything as 1.
  }

  closestFillable(opts: { ignore_capacity: boolean } & FindPathOpts = { ignore_capacity: false }, include: StructureConstant[] = [STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_TOWER, STRUCTURE_CONTAINER]): StructureSpawn | StructureExtension | StructureTower | StructureContainer | null {
    if (!this.room) return null;

    return this.self.pos.findClosestByPath(this.room.find(FIND_STRUCTURES, {
      filter: s => (include.includes(s.structureType)) && (opts.ignore_capacity || 'store' in s && (s.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0) > 0),
    }) as (StructureSpawn | StructureExtension | StructureTower | StructureContainer)[], opts);
  }
  closestCollectable(include: StructureConstant[] = [STRUCTURE_CONTAINER]): StructureSpawn | StructureExtension | StructureTower | StructureContainer | null {
    if (!this.room) return null;

    return this.self.pos.findClosestByPath(this.room.find(FIND_STRUCTURES, {
      filter: s => (include.includes(s.structureType)) && 'store' in s && (s.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0) > 0,
    }) as (StructureSpawn | StructureExtension | StructureTower | StructureContainer)[]);
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

    get road_to_controller() { return this.room.road(`${this.self.id}.road_to_controller`, this.self.pos, this.room.my_controller!.pos); }
    get road_to_extensions() { return this.room.road_grid(`${this.self.id}.road_to_extensions`, this.self.pos); }
    get road_to_exits() { 
      return Object.values(this.room.exits ?? {}).map(([direction, exits]: any) => this.room.road(`${this.self.id}.road_to_exits.${direction}`, this.self.pos, exits[Math.floor(exits.length / 2)]))
    }

    loop(): void {
      // TODO IF IN WAR
      if (this.room.needsWorker()) this.spawnCreep(this.room.bestAffordableUnit(Unit.Worker.configuration))
      
    }

  }
  
  export class Tower extends Obj<StructureTower> {

    loop(): void {
      const friendlies = this.room.friendlies(this.self);
      const hostiles = this.room.hostiles(this.self);

      if (hostiles.some()) {
        const enemy = (hostiles.healers.some() ? hostiles.healers : hostiles).closestByRange();
        
        if (enemy) {
          this.self.attack(enemy);
          return;
        }
      }

      const friendly = (friendlies.healers.some() ? friendlies.healers : friendlies).closestByRange();
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