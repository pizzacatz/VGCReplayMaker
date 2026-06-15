/**
 * Data model & aggregation (T1.3) — organize games by player/tournament and run
 * ONE global solve across the TeamInstances that share games, sliced per instance
 * (DATA_MODEL_AND_AGGREGATION.md; Constitution §E2, §E9).
 *
 * Aggregation key = the TeamInstance (§4): all clean hits from every game in which
 * an instance appears feed one inference for it. Mon identities are namespaced by
 * instance (`instanceId#monId`), so the solver NEVER aggregates across an instance
 * boundary unless the user models two scopes as one instance — the structural
 * guarantee §4 requires. A game feeds BOTH sides' instances; a hit across sides
 * couples them in the global system (§5).
 */

import { championsGen, type MonSpec } from '../engine';
import {
  ConstraintSystem,
  NON_HP_STATS,
  type MonReport,
  type SolveOptions,
  type SolverHit,
  type SolverMon,
  type SpeedControl,
  type SpeedFact,
} from '../solver';
import type { SpSpread } from '../conversion';
import type { ParsedMon } from '../import';

export interface Player {
  playerId: string;
  displayName: string;
  aliases?: string[];
}

export interface Tournament {
  tournamentId: string;
  name: string;
  date: string;
  format: string;
}

export interface RosterMon {
  monId: string;
  spec: MonSpec;
  /** observed max HP → SP_hp (read). Required to solve a mon. */
  observedMaxHp: number;
  /** present for own-team / confirmed builds; the solver does not re-solve a known spread. */
  knownSpread?: SpSpread;
}

export interface TeamInstance {
  instanceId: string;
  playerId: string;
  roster: RosterMon[];
}

export interface MonRef {
  instanceId: string;
  monId: string;
}

export interface GameHit {
  attacker: MonRef;
  defender: MonRef;
  move: string;
  observedDamage: number;
  crit?: boolean;
  /** Mega forme of attacker/defender at hit time, if any (uses that forme's stats). */
  attackerSpecies?: string;
  defenderSpecies?: string;
  /** provenance label for the evidence drill-down (e.g. "R7 G2 · T3"). */
  source?: string;
  /** the originating damage event's id (for per-hit exclude). */
  eventId?: string;
}

export interface GameSpeedFact {
  first: MonRef;
  second: MonRef;
  samePriorityBracket: boolean;
  trickRoom?: boolean;
  firstControl?: SpeedControl;
  secondControl?: SpeedControl;
  tie?: boolean;
  /** Mega forme of each mover at the time, if any (uses that forme's Speed base). */
  firstSpecies?: string;
  secondSpecies?: string;
}

export interface Game {
  gameId: string;
  tournamentId: string;
  sideA: { playerId: string; instanceId: string };
  sideB: { playerId: string; instanceId: string };
  cleanHits: GameHit[];
  speedFacts?: GameSpeedFact[];
}

export interface InstanceReport {
  instanceId: string;
  playerId: string;
  mons: Array<{ monId: string; report: MonReport }>;
  flags: string[];
}

const gid = (ref: MonRef): string => `${ref.instanceId}#${ref.monId}`;
const splitGid = (id: string): { instanceId: string; monId: string } => {
  const i = id.indexOf('#');
  return { instanceId: id.slice(0, i), monId: id.slice(i + 1) };
};

/** Build a RosterMon from a parsed pokepaste sheet plus the observed max HP. */
export function rosterMonFromParsed(parsed: ParsedMon, monId: string, observedMaxHp: number): RosterMon {
  return {
    monId,
    spec: {
      species: parsed.species,
      alignment: parsed.alignment,
      ...(parsed.item ? { item: parsed.item } : {}),
      ...(parsed.ability ? { ability: parsed.ability } : {}),
    },
    observedMaxHp,
    ...(parsed.spSpread ? { knownSpread: parsed.spSpread } : {}),
  };
}

export class ScoutingDB {
  private readonly players = new Map<string, Player>();
  private readonly tournaments = new Map<string, Tournament>();
  private readonly instances = new Map<string, TeamInstance>();
  private readonly games: Game[] = [];

  addPlayer(player: Player): void {
    this.players.set(player.playerId, player);
  }
  addTournament(tournament: Tournament): void {
    this.tournaments.set(tournament.tournamentId, tournament);
  }
  addInstance(instance: TeamInstance): void {
    this.instances.set(instance.instanceId, instance);
  }
  addGame(game: Game): void {
    this.games.push(game);
  }

  /** Run one global solve across all instances sharing games; return per-instance reports. */
  solve(options: SolveOptions = {}): Map<string, InstanceReport> {
    const gen = championsGen();

    const mons: SolverMon[] = [];
    const monRefExists = new Set<string>();
    for (const instance of this.instances.values()) {
      for (const m of instance.roster) {
        const id = gid({ instanceId: instance.instanceId, monId: m.monId });
        mons.push({ id, spec: m.spec, observedMaxHp: m.observedMaxHp });
        monRefExists.add(id);
      }
    }

    const hits: SolverHit[] = [];
    const speedFacts: SpeedFact[] = [];
    const instanceFlags = new Map<string, string[]>();
    const flag = (instanceId: string, msg: string): void => {
      const list = instanceFlags.get(instanceId) ?? [];
      if (!list.includes(msg)) list.push(msg);
      instanceFlags.set(instanceId, list);
    };

    const resolvable = (ref: MonRef): boolean => this.instances.has(ref.instanceId) && monRefExists.has(gid(ref));

    for (const game of this.games) {
      const partialNote = (other: string) =>
        `game ${game.gameId}: a referenced mon is unsheeted — its hits are skipped (partial sheet; import ${other}'s team to use them)`;
      for (const hit of game.cleanHits) {
        if (!resolvable(hit.attacker) || !resolvable(hit.defender)) {
          if (this.instances.has(hit.attacker.instanceId)) flag(hit.attacker.instanceId, partialNote('the opponent'));
          if (this.instances.has(hit.defender.instanceId)) flag(hit.defender.instanceId, partialNote('the opponent'));
          continue; // a damage factor needs BOTH sheets; otherwise the hit is unusable (§5)
        }
        hits.push({
          attackerId: gid(hit.attacker),
          defenderId: gid(hit.defender),
          move: hit.move,
          observedDamage: hit.observedDamage,
          ...(hit.crit !== undefined ? { crit: hit.crit } : {}),
          ...(hit.attackerSpecies ? { attackerSpecies: hit.attackerSpecies } : {}),
          ...(hit.defenderSpecies ? { defenderSpecies: hit.defenderSpecies } : {}),
          ...(hit.source ? { source: hit.source } : {}),
          ...(hit.eventId ? { eventId: hit.eventId } : {}),
        });
      }
      for (const sf of game.speedFacts ?? []) {
        if (!resolvable(sf.first) || !resolvable(sf.second)) continue;
        speedFacts.push({
          firstId: gid(sf.first),
          secondId: gid(sf.second),
          samePriorityBracket: sf.samePriorityBracket,
          ...(sf.trickRoom !== undefined ? { trickRoom: sf.trickRoom } : {}),
          ...(sf.firstControl ? { firstControl: sf.firstControl } : {}),
          ...(sf.secondControl ? { secondControl: sf.secondControl } : {}),
          ...(sf.tie !== undefined ? { tie: sf.tie } : {}),
          ...(sf.firstSpecies ? { firstSpecies: sf.firstSpecies } : {}),
          ...(sf.secondSpecies ? { secondSpecies: sf.secondSpecies } : {}),
        });
      }
    }

    const system = new ConstraintSystem(gen, mons, hits, speedFacts);

    // Apply known spreads: the solver does not re-solve a confirmed build.
    for (const instance of this.instances.values()) {
      for (const m of instance.roster) {
        if (!m.knownSpread) continue;
        const id = gid({ instanceId: instance.instanceId, monId: m.monId });
        for (const stat of NON_HP_STATS) system.restrictDomain(id, stat, [m.knownSpread[stat]]);
      }
    }

    const result = system.solve(options);
    const byInstance = new Map<string, Array<{ monId: string; report: MonReport }>>();
    for (const report of result.mons) {
      const { instanceId, monId } = splitGid(report.monId);
      const list = byInstance.get(instanceId) ?? [];
      list.push({ monId, report });
      byInstance.set(instanceId, list);
    }

    // Cross-tournament merge surfacing (§4): flag an instance whose games span tournaments.
    for (const instance of this.instances.values()) {
      const tournaments = new Set(
        this.games
          .filter((g) => g.sideA.instanceId === instance.instanceId || g.sideB.instanceId === instance.instanceId)
          .map((g) => g.tournamentId),
      );
      if (tournaments.size > 1) {
        flag(
          instance.instanceId,
          `this instance spans ${tournaments.size} tournaments — explicit cross-tournament aggregation; valid only if the spread is unchanged`,
        );
      }
    }

    const reports = new Map<string, InstanceReport>();
    for (const instance of this.instances.values()) {
      reports.set(instance.instanceId, {
        instanceId: instance.instanceId,
        playerId: instance.playerId,
        mons: byInstance.get(instance.instanceId) ?? [],
        flags: instanceFlags.get(instance.instanceId) ?? [],
      });
    }
    return reports;
  }
}
