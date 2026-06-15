/**
 * Bridge a transcribed match log into an aggregation Game (T3.5 → T1.3), so one
 * transcription flows straight into the scouting database and the global solve.
 */

import type { Gen, MonSpec } from '../engine';
import type { Game, GameHit, GameSpeedFact, MonRef } from '../aggregation';
import type { MatchLog, Side } from '../log';
import { extractCleanHits, extractSpeedFacts } from './extract';

export interface GameMeta {
  gameId: string;
  tournamentId: string;
  sideA: { playerId: string; instanceId: string };
  sideB: { playerId: string; instanceId: string };
}

/** Turn a match log + side/instance metadata into a solver-ready Game. */
export function logToGame(log: MatchLog, meta: GameMeta, gen: Gen, specs: Map<string, MonSpec>): Game {
  const sideOf = (monId: string): Side => {
    if (log.sideA.mons.some((m) => m.monId === monId)) return 'A';
    if (log.sideB.mons.some((m) => m.monId === monId)) return 'B';
    throw new Error(`mon ${monId} is on neither side of the log`);
  };
  const ref = (monId: string): MonRef => ({
    instanceId: sideOf(monId) === 'A' ? meta.sideA.instanceId : meta.sideB.instanceId,
    monId,
  });

  const cleanHits: GameHit[] = extractCleanHits(log).map((h) => ({
    attacker: ref(h.attackerId),
    defender: ref(h.defenderId),
    move: h.move,
    observedDamage: h.observedDamage,
    ...(h.crit !== undefined ? { crit: h.crit } : {}),
    ...(h.attackerSpecies ? { attackerSpecies: h.attackerSpecies } : {}),
    ...(h.defenderSpecies ? { defenderSpecies: h.defenderSpecies } : {}),
    ...(h.source ? { source: h.source } : {}),
    ...(h.eventId ? { eventId: h.eventId } : {}),
    ...(h.context ? { context: h.context } : {}),
  }));

  const speedFacts: GameSpeedFact[] = extractSpeedFacts(log, gen, specs).facts.map((f) => ({
    first: ref(f.first),
    second: ref(f.second),
    samePriorityBracket: f.samePriorityBracket,
    ...(f.trickRoom !== undefined ? { trickRoom: f.trickRoom } : {}),
    ...(f.firstSpecies ? { firstSpecies: f.firstSpecies } : {}),
    ...(f.secondSpecies ? { secondSpecies: f.secondSpecies } : {}),
  }));

  return {
    gameId: meta.gameId,
    tournamentId: meta.tournamentId,
    sideA: meta.sideA,
    sideB: meta.sideB,
    cleanHits,
    speedFacts,
  };
}
