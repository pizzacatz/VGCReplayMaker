/**
 * The shared event log (Event Schema v2, T1.1) — the spine Part 1 writes, the
 * solver reads (clean subset), and replay reads (everything). Constitution §D.
 *
 * This module defines the log's SHAPE. Modifier state is reconstructed from the
 * timeline (Schema v2 §1.4), not stored on events; damage events carry only
 * observed values. Doubles only: each side has two active slots (positions 0/1).
 */

export type Side = 'A' | 'B';
export type Position = 0 | 1;
export type DamageStatus = 'clean' | 'composite' | 'unresolved';

export interface BaseEvent {
  eventId: string;
  /** global total order */
  seq: number;
  turn: number;
}

export interface TurnStartEvent extends BaseEvent {
  type: 'turn_start';
}

export interface MoveUsedEvent extends BaseEvent {
  type: 'move_used';
  user: string;
  move: string;
  targets: string[];
  isSpread?: boolean;
}

export interface DamageEvent extends BaseEvent {
  type: 'damage';
  attacker: string;
  move: string;
  defender: string;
  hpBefore: number;
  hpAfter: number;
  crit: boolean;
  status: DamageStatus;
  observedEffectiveness?: string;
  note?: string;
}

export interface PassiveHpChangeEvent extends BaseEvent {
  type: 'passive_hp_change';
  target: string;
  source: string;
  hpBefore: number;
  hpAfter: number;
}

export interface HealEvent extends BaseEvent {
  type: 'heal';
  target: string;
  source: string;
  hpBefore: number;
  hpAfter: number;
}

export interface SwitchEvent extends BaseEvent {
  type: 'switch';
  side: Side;
  position: Position;
  out?: string;
  in: string;
}

export interface FaintEvent extends BaseEvent {
  type: 'faint';
  target: string;
}

export interface StatusAppliedEvent extends BaseEvent {
  type: 'status_applied';
  target: string;
  status: string;
  source?: string;
}

export interface StatusCuredEvent extends BaseEvent {
  type: 'status_cured';
  target: string;
  status: string;
}

export interface StatStageChangeEvent extends BaseEvent {
  type: 'stat_stage_change';
  target: string;
  stat: string;
  stages: number;
  source?: string;
}

export interface FieldChangeEvent extends BaseEvent {
  type: 'field_change';
  field: string;
  action: 'set' | 'end';
  side?: Side;
  turnsKnown?: number;
}

export interface ItemOrAbilityEvent extends BaseEvent {
  type: 'item_or_ability_event';
  mon: string;
  kind: 'item' | 'enditem' | 'ability' | 'activate';
  name: string;
  effect?: string;
}

export interface RandomOutcomeEvent extends BaseEvent {
  type: 'random_outcome';
  mon: string;
  eventKind: string;
  outcome: string;
  linkedEvent?: string;
}

export type MatchEvent =
  | TurnStartEvent
  | MoveUsedEvent
  | DamageEvent
  | PassiveHpChangeEvent
  | HealEvent
  | SwitchEvent
  | FaintEvent
  | StatusAppliedEvent
  | StatusCuredEvent
  | StatStageChangeEvent
  | FieldChangeEvent
  | ItemOrAbilityEvent
  | RandomOutcomeEvent;

/** Minimal mon sheet info replay needs (the full sheet lives in the roster/TeamInstance). */
export interface LogMonSheet {
  monId: string;
  species: string;
  nickname?: string;
  /** max HP (observed or read) — for current/max HP display */
  maxHp: number;
}

export interface LeadEntry {
  side: Side;
  position: Position;
  monId: string;
}

export interface MatchLog {
  matchId: string;
  format: string;
  sideA: { player: string; mons: LogMonSheet[] };
  sideB: { player: string; mons: LogMonSheet[] };
  /** initial board */
  leads: LeadEntry[];
  /** seq-ordered (sorted on read regardless) */
  events: MatchEvent[];
}
