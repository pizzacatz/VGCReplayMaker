/**
 * Replay stepping (Replay Spec T2.3 §5) — forward/backward, by turn and by action.
 *
 * Key property: the protocol is fully deterministic (every outcome is logged, no
 * hidden RNG), so the state at any index is a PURE FUNCTION of the messages up to
 * it. Backward stepping / jumping rebuilds forward from the start (or a keyframe)
 * to the target — never mutates in reverse. This is the clean consequence of the
 * no-re-simulation design (Constitution §G2).
 */

import type { Effect, ProtocolMessage } from './protocol';

export interface SlotState {
  monId: string;
  species: string;
  hp: number;
  maxHp: number;
  fainted: boolean;
}

export interface ReplayState {
  turn: number;
  /** active board: 'p1a' | 'p1b' | 'p2a' | 'p2b' → slot state (or null if empty) */
  slots: Record<string, SlotState | null>;
  /** monId → status (persists with the mon across switches) */
  status: Record<string, string>;
  /** monId → stat → stage (−6..+6) */
  boosts: Record<string, Record<string, number>>;
  weather: string | null;
  /** field conditions: terrain, Trick Room, Gravity, … */
  field: string[];
  /** side conditions: screens, Tailwind, … */
  sides: { A: string[]; B: string[] };
}

const SLOT_KEYS = ['p1a', 'p1b', 'p2a', 'p2b'] as const;

export function initialState(): ReplayState {
  return {
    turn: 0,
    slots: { p1a: null, p1b: null, p2a: null, p2b: null },
    status: {},
    boosts: {},
    weather: null,
    field: [],
    sides: { A: [], B: [] },
  };
}

const clampStage = (n: number): number => Math.max(-6, Math.min(6, n));

/** Apply one effect, returning a NEW state (pure; never mutates the input). */
export function applyEffect(prev: ReplayState, effect: Effect): ReplayState {
  const s: ReplayState = {
    turn: prev.turn,
    slots: { ...prev.slots },
    status: { ...prev.status },
    boosts: { ...prev.boosts },
    weather: prev.weather,
    field: [...prev.field],
    sides: { A: [...prev.sides.A], B: [...prev.sides.B] },
  };
  switch (effect.kind) {
    case 'turn':
      s.turn = effect.n;
      return s;
    case 'switchIn':
      s.slots[effect.slot] = { monId: effect.monId, species: effect.species, hp: effect.hp, maxHp: effect.maxHp, fainted: false };
      return s;
    case 'hp': {
      const slot = s.slots[effect.slot];
      if (slot) s.slots[effect.slot] = { ...slot, hp: effect.hp };
      return s;
    }
    case 'faint': {
      const slot = s.slots[effect.slot];
      if (slot) s.slots[effect.slot] = { ...slot, hp: 0, fainted: true };
      return s;
    }
    case 'status':
      if (effect.action === 'set') s.status[effect.monId] = effect.status;
      else delete s.status[effect.monId];
      return s;
    case 'boost': {
      const cur = { ...(s.boosts[effect.monId] ?? {}) };
      cur[effect.stat] = clampStage((cur[effect.stat] ?? 0) + effect.stages);
      s.boosts[effect.monId] = cur;
      return s;
    }
    case 'weather':
      s.weather = effect.value;
      return s;
    case 'field':
      if (effect.action === 'set') {
        if (!s.field.includes(effect.condition)) s.field.push(effect.condition);
      } else {
        s.field = s.field.filter((c) => c !== effect.condition);
      }
      return s;
    case 'side': {
      const list = s.sides[effect.side];
      if (effect.action === 'set') {
        if (!list.includes(effect.condition)) list.push(effect.condition);
      } else {
        s.sides[effect.side] = list.filter((c) => c !== effect.condition);
      }
      return s;
    }
    case 'formeChange': {
      const slot = s.slots[effect.slot];
      if (slot) s.slots[effect.slot] = { ...slot, species: effect.species };
      return s;
    }
    case 'noop':
      return s;
  }
}

/**
 * Drives a protocol stream forward/backward. A cursor of −1 is the pre-battle
 * empty state; index i means "after applying messages 0..i".
 */
export class ReplayPlayer {
  private cursor = -1;

  constructor(public readonly messages: ProtocolMessage[]) {}

  get length(): number {
    return this.messages.length;
  }

  get index(): number {
    return this.cursor;
  }

  /** Pure rebuild: state after applying messages 0..index (−1 → initial). */
  stateAt(index: number): ReplayState {
    let state = initialState();
    const end = Math.min(index, this.messages.length - 1);
    for (let i = 0; i <= end; i++) state = applyEffect(state, this.messages[i]!.effect);
    return state;
  }

  /** Current rendered state. */
  state(): ReplayState {
    return this.stateAt(this.cursor);
  }

  stepForward(): ReplayState {
    if (this.cursor < this.messages.length - 1) this.cursor++;
    return this.state();
  }

  stepBackward(): ReplayState {
    if (this.cursor >= 0) this.cursor--;
    return this.state();
  }

  /** Indices of the `|turn|N` markers, in order. */
  turnIndices(): number[] {
    return this.messages.filter((m) => m.effect.kind === 'turn').map((m) => m.index);
  }

  /** Jump to the start of turn N (its `|turn|` marker). */
  toTurn(n: number): ReplayState {
    const target = this.messages.find((m) => m.effect.kind === 'turn' && (m.effect as { n: number }).n === n);
    this.cursor = target ? target.index : this.cursor;
    return this.state();
  }

  /** Jump to a specific action (message index). */
  toAction(index: number): ReplayState {
    this.cursor = Math.max(-1, Math.min(index, this.messages.length - 1));
    return this.state();
  }
}

export { SLOT_KEYS };
