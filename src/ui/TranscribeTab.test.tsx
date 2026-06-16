// @vitest-environment jsdom
/** Repro/regression: rendering + interacting with the Transcribe tab must not crash. */

import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import type { ParsedMon } from '../import';
import { TranscribeTab } from './TranscribeTab';
import { type MonEntry, type Workspace } from './model';

afterEach(cleanup);

const pm = (species: string, moves: string[] = []): ParsedMon => ({ species, level: 50, moves, alignment: 'neutral', spreadKnown: false, flags: [] });
const entry = (side: string, i: number, species: string, moves: string[] = []): MonEntry => ({ monId: `${side}${i}`, parsed: pm(species, moves), observedMaxHp: 175 });

function makeWs(): Workspace {
  return {
    sideA: { player: 'You', rawPaste: '', mons: [entry('A', 0, 'Incineroar', ['Flare Blitz', 'Fake Out']), entry('A', 1, 'Zapdos'), entry('A', 2, 'Giratina')], leads: ['A0', 'A1'] },
    sideB: { player: 'Opp', rawPaste: '', mons: [entry('B', 0, 'Garchomp'), entry('B', 1, 'Annihilape'), entry('B', 2, 'Dragonite')], leads: ['B0', 'B1'] },
    events: [],
  };
}

function Harness() {
  const [ws, setWs] = useState<Workspace>(makeWs);
  return <TranscribeTab ws={ws} setWs={setWs} />;
}

describe('TranscribeTab does not crash on interaction', () => {
  it('renders and a lead chip click does not throw', () => {
    const { getAllByText, getByText } = render(<Harness />);
    // sanity: setup panel present
    expect(getByText('Match setup')).toBeTruthy();
    // click a roster chip (a lead toggle) — Giratina appears once as a setup chip
    fireEvent.click(getAllByText('Giratina')[0]!);
    // if the click crashed the tree, the board would be gone; assert it survived
    expect(getByText('Match setup')).toBeTruthy();
  });

  it('clicking an active board mon opens its move list', () => {
    const { getAllByText, getByText } = render(<Harness />);
    const incs = getAllByText('Incineroar');
    fireEvent.click(incs[incs.length - 1]!);
    expect(getByText('Flare Blitz')).toBeTruthy();
  });

  it('toggling an existing lead off does not crash', () => {
    const { getAllByText, getByText } = render(<Harness />);
    // Incineroar (A0) is a lead; first occurrence is the setup chip
    fireEvent.click(getAllByText('Incineroar')[0]!);
    expect(getByText('Match setup')).toBeTruthy();
  });

  it('full single-target move flow: actor → move → log damage', () => {
    const { getAllByText, getByText, getByPlaceholderText } = render(<Harness />);
    fireEvent.click(getAllByText('Incineroar').at(-1)!); // board actor
    fireEvent.click(getByText('Flare Blitz')); // move → planTargets (single, foe auto-selected)
    fireEvent.change(getByPlaceholderText('hp after'), { target: { value: '120' } });
    fireEvent.click(getByText('Log action'));
    expect(getByText('Match setup')).toBeTruthy(); // survived
  });

  it('an inconsistent log (event references a non-lead) shows recovery, not a crash', () => {
    const ws: Workspace = {
      sideA: { player: 'You', rawPaste: '', mons: [entry('A', 0, 'Incineroar'), entry('A', 1, 'Zapdos'), entry('A', 2, 'Giratina')], leads: ['A1', 'A2'] },
      sideB: { player: 'Opp', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      // A0 is NOT a lead, so a move by A0 references an inactive mon → board reconstruction fails.
      events: [{ eventId: 'm', seq: 1, turn: 1, type: 'move_used', user: 'A0', move: 'Flare Blitz', targets: ['B0'] }],
    };
    function H() {
      const [w, setW] = useState(ws);
      return <TranscribeTab ws={w} setWs={setW} />;
    }
    const { getByText } = render(<H />);
    expect(getByText('Clear all events')).toBeTruthy(); // graceful recovery panel, not a thrown crash
  });

  it('the recovery screen pinpoints the bad event, keeps the log editable, and a targeted delete restores the board', () => {
    const ws: Workspace = {
      sideA: { player: 'You', rawPaste: '', mons: [entry('A', 0, 'Incineroar'), entry('A', 1, 'Zapdos'), entry('A', 2, 'Giratina')], leads: ['A1', 'A2'] },
      sideB: { player: 'Opp', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      // A0 is not a lead → this move references an inactive mon (the culprit).
      events: [{ eventId: 'bad', seq: 1, turn: 1, type: 'move_used', user: 'A0', move: 'Flare Blitz', targets: ['B0'] }],
    };
    function H() {
      const [w, setW] = useState(ws);
      return <TranscribeTab ws={w} setWs={setW} />;
    }
    const { getByText, queryByText } = render(<H />);
    expect(getByText('Event log (1)')).toBeTruthy(); // log stays visible/editable (no soft-lock)
    fireEvent.click(getByText(/Delete the offending event/)); // targeted, non-destructive fix
    expect(queryByText(/be reconstructed/)).toBeNull(); // error cleared
    expect(getByText('Match setup')).toBeTruthy(); // board/action UI is back
  });

  it('spread move: per-target HP/crit/flinch, two damage events; self move logs once', () => {
    const ws: Workspace = {
      sideA: { player: 'You', rawPaste: '', mons: [entry('A', 0, 'Tyranitar', ['Rock Slide', 'Dragon Dance']), entry('A', 1, 'Zapdos')], leads: ['A0', 'A1'] },
      sideB: { player: 'Opp', rawPaste: '', mons: [entry('B', 0, 'Garchomp'), entry('B', 1, 'Annihilape')], leads: ['B0', 'B1'] },
      events: [],
    };
    function H() {
      const [w, setW] = useState(ws);
      return <TranscribeTab ws={w} setWs={setW} />;
    }
    const { getAllByText, getByText, getAllByPlaceholderText } = render(<H />);
    fireEvent.click(getAllByText('Tyranitar').at(-1)!);
    fireEvent.click(getByText('Rock Slide')); // spread → both foes auto-targeted
    const hpInputs = getAllByPlaceholderText('hp after');
    expect(hpInputs).toHaveLength(2); // one per target
    expect(getAllByText('flinched')).toHaveLength(2); // Rock Slide can flinch each target
    fireEvent.change(hpInputs[0]!, { target: { value: '100' } });
    fireEvent.change(hpInputs[1]!, { target: { value: '120' } });
    fireEvent.click(getByText('Log action'));
    expect(getByText('Event log (3)')).toBeTruthy(); // move_used + 2 damage
  });

  it('single-target move allows exactly one target (clicking another switches)', () => {
    const { getAllByText, getByText, getAllByPlaceholderText } = render(<Harness />);
    fireEvent.click(getAllByText('Incineroar').at(-1)!);
    fireEvent.click(getByText('Flare Blitz')); // single-target
    expect(getAllByPlaceholderText('hp after')).toHaveLength(1);
    // Annihilape is the other foe — selecting its target chip should switch, not add
    fireEvent.click(getAllByText('Annihilape').at(-1)!);
    expect(getAllByPlaceholderText('hp after')).toHaveLength(1);
  });

  it('KO logs a damage to 0 HP and a faint', () => {
    const { getAllByText, getByText } = render(<Harness />);
    fireEvent.click(getAllByText('Incineroar').at(-1)!);
    fireEvent.click(getByText('Flare Blitz'));
    fireEvent.click(getByText('KO')); // KO checkbox → HP auto 0
    fireEvent.click(getByText('Log action'));
    // move_used + damage(→0) + faint + Flare Blitz recoil = 4 events
    expect(getByText('Event log (4)')).toBeTruthy();
    expect(getAllByText(/fainted/).length).toBeGreaterThan(0); // faint event in the log
  });

  it('a logged event can be edited inline', () => {
    const { getAllByText, getByText, getByPlaceholderText, getByLabelText } = render(<Harness />);
    fireEvent.click(getAllByText('Incineroar').at(-1)!);
    fireEvent.click(getByText('Flare Blitz'));
    fireEvent.change(getByPlaceholderText('hp after'), { target: { value: '150' } });
    fireEvent.click(getByText('Log action'));
    // edit the damage event (second event after move_used)
    fireEvent.click(getAllByText('✎')[1]!);
    fireEvent.change(getByLabelText('HP after'), { target: { value: '99' } });
    fireEvent.click(getByText('Save'));
    expect(getByText(/→99/)).toBeTruthy(); // event log reflects the edit
  });

  it('the forfeit button records a forfeit as a timeline event', () => {
    const { getByText, getAllByText } = render(<Harness />);
    fireEvent.click(getByText('⚑ You')); // "You" forfeits → Opp wins
    expect(getAllByText(/You forfeited/).length).toBeGreaterThan(0); // status chip + event-log entry
    expect(getByText(/⚑ You forfeited — game over/)).toBeTruthy(); // appears on the event timeline
  });

  it('a guaranteed-status move (Toxic) applies the status, which then ticks at end of turn', () => {
    const ws: Workspace = {
      sideA: { player: 'You', rawPaste: '', mons: [entry('A', 0, 'Incineroar', ['Toxic'])], leads: ['A0'] },
      sideB: { player: 'Opp', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      events: [{ eventId: 't1', seq: 1, turn: 1, type: 'turn_start' }],
    };
    function H() {
      const [w, setW] = useState(ws);
      return <TranscribeTab ws={w} setWs={setW} />;
    }
    const { getAllByText, getByText } = render(<H />);
    fireEvent.click(getAllByText('Incineroar').at(-1)!);
    fireEvent.click(getByText('Toxic'));
    fireEvent.click(getByText('Log action'));
    expect(getByText(/Garchomp → tox/)).toBeTruthy(); // status auto-applied
    fireEvent.click(getByText('▶ End turn'));
    expect(getByText(/\(Toxic\)/)).toBeTruthy(); // end-of-turn poison tick now derives
  });

  it('Fake Out on turn 2 auto-logs a failure', () => {
    const ws: Workspace = {
      sideA: { player: 'You', rawPaste: '', mons: [entry('A', 0, 'Incineroar', ['Fake Out'])], leads: ['A0'] },
      sideB: { player: 'Opp', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      events: [{ eventId: 't1', seq: 1, turn: 1, type: 'turn_start' }, { eventId: 't2', seq: 2, turn: 2, type: 'turn_start' }],
    };
    function H() {
      const [w, setW] = useState(ws);
      return <TranscribeTab ws={w} setWs={setW} />;
    }
    const { getAllByText, getByText } = render(<H />);
    fireEvent.click(getAllByText('Incineroar').at(-1)!);
    fireEvent.click(getByText('Fake Out'));
    fireEvent.click(getByText('Log action'));
    expect(getByText(/move failed/)).toBeTruthy();
  });

  it('Regenerator heals 1/3 when the mon switches out', () => {
    const tox = entry('A', 0, 'Toxapex');
    tox.parsed.ability = 'Regenerator';
    const ws: Workspace = {
      sideA: { player: 'You', rawPaste: '', mons: [tox, entry('A', 1, 'Zapdos'), entry('A', 2, 'Aerodactyl')], leads: ['A0', 'A1'] },
      sideB: { player: 'Opp', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      events: [
        { eventId: 't1', seq: 1, turn: 1, type: 'turn_start' },
        { eventId: 'd', seq: 2, turn: 1, type: 'damage', attacker: 'B0', move: 'Earthquake', defender: 'A0', hpBefore: 175, hpAfter: 100, crit: false, status: 'clean' },
      ],
    };
    function H() {
      const [w, setW] = useState(ws);
      return <TranscribeTab ws={w} setWs={setW} />;
    }
    const { getAllByText, getByText } = render(<H />);
    fireEvent.click(getAllByText('Toxapex').at(-1)!); // active actor
    fireEvent.click(getByText('Switch out ↔'));
    fireEvent.click(getByText('Aerodactyl')); // bring in the bench mon
    expect(getByText(/Regenerator/)).toBeTruthy(); // heal event logged
  });

  it('the Faint button marks a Pokémon fainted', () => {
    const { getAllByText, getByText } = render(<Harness />);
    fireEvent.click(getAllByText('Incineroar').at(-1)!);
    fireEvent.click(getByText('Faint ✕'));
    expect(getAllByText(/fainted/).length).toBeGreaterThan(0);
  });

  it('a fainted Pokémon can be clicked to send out a replacement', () => {
    const { getAllByText, getByText, queryByText } = render(<Harness />);
    // faint the lead Incineroar (A0)
    fireEvent.click(getAllByText('Incineroar').at(-1)!);
    fireEvent.click(getByText('Faint ✕'));
    // a fainted mon must NOT offer the move/switch menu
    fireEvent.click(getAllByText('Incineroar').at(-1)!);
    expect(getByText(/Send out a replacement/)).toBeTruthy();
    expect(queryByText('Switch out ↔')).toBeNull(); // no normal action menu for a fainted mon
    // bring in Giratina (the bench mon) — emits a switch out of the fainted Incineroar
    fireEvent.click(getAllByText('Giratina').at(-1)!);
    expect(getByText(/\(switch\)/)).toBeTruthy(); // "Incineroar → Giratina (switch)"
  });

  it('damage to 0 HP auto-faints (no KO checkbox needed)', () => {
    const { getAllByText, getByText, getByPlaceholderText } = render(<Harness />);
    fireEvent.click(getAllByText('Incineroar').at(-1)!);
    fireEvent.click(getByText('Flare Blitz'));
    fireEvent.change(getByPlaceholderText('hp after'), { target: { value: '0' } });
    fireEvent.click(getByText('Log action'));
    expect(getAllByText(/fainted/).length).toBeGreaterThan(0);
  });

  it('picking a damaging move pre-fills an estimated HP-after', () => {
    const { getAllByText, getByText, getByPlaceholderText } = render(<Harness />);
    fireEvent.click(getAllByText('Incineroar').at(-1)!);
    fireEvent.click(getByText('Flare Blitz'));
    const input = getByPlaceholderText('hp after') as HTMLInputElement;
    expect(input.value).not.toBe(''); // calc pre-fill present
  });

  it('Flare Blitz auto-adds a recoil event', () => {
    const { getAllByText, getByText, getByPlaceholderText } = render(<Harness />);
    fireEvent.click(getAllByText('Incineroar').at(-1)!);
    fireEvent.click(getByText('Flare Blitz'));
    fireEvent.change(getByPlaceholderText('hp after'), { target: { value: '100' } });
    fireEvent.click(getByText('Log action'));
    expect(getByText(/Recoil/)).toBeTruthy(); // recoil passive_hp_change auto-derived
  });

  it('Start match applies lead Intimidate', () => {
    const inc = entry('A', 0, 'Incineroar');
    inc.parsed.ability = 'Intimidate';
    const ws: Workspace = {
      sideA: { player: 'P1', rawPaste: '', mons: [inc], leads: ['A0'] },
      sideB: { player: 'P2', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      events: [],
    };
    function H() {
      const [w, setW] = useState(ws);
      return <TranscribeTab ws={w} setWs={setW} />;
    }
    const { getByText } = render(<H />);
    fireEvent.click(getByText(/Start match/));
    expect(getByText(/atk -1/)).toBeTruthy(); // Intimidate dropped Garchomp's Attack
  });

  it('a Pokémon holding a mega stone shows a Mega Evolve button (no forme choice)', () => {
    const aero = entry('A', 0, 'Aerodactyl', ['Rock Slide']);
    aero.parsed.item = 'Aerodactylite';
    const ws: Workspace = {
      sideA: { player: 'You', rawPaste: '', mons: [aero, entry('A', 1, 'Zapdos')], leads: ['A0', 'A1'] },
      sideB: { player: 'Opp', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      events: [],
    };
    function H() {
      const [w, setW] = useState(ws);
      return <TranscribeTab ws={w} setWs={setW} />;
    }
    const { getAllByText, getByText } = render(<H />);
    fireEvent.click(getAllByText('Aerodactyl').at(-1)!);
    fireEvent.click(getByText('Mega Evolve ✦')); // single button, forme from the stone
    expect(getByText(/Mega-Evolved → Aerodactyl-Mega/)).toBeTruthy();
  });

  it('End turn logs this turn’s residuals AND advances, together', () => {
    const ws: Workspace = {
      sideA: { player: 'You', rawPaste: '', mons: [entry('A', 0, 'Incineroar')], leads: ['A0'] },
      sideB: { player: 'Opp', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      events: [
        { eventId: 't1', seq: 1, turn: 1, type: 'turn_start' },
        { eventId: 's', seq: 2, turn: 1, type: 'status_applied', target: 'A0', status: 'psn' },
      ],
    };
    function H() {
      const [w, setW] = useState(ws);
      return <TranscribeTab ws={w} setWs={setW} />;
    }
    const { getByText } = render(<H />);
    fireEvent.click(getByText('▶ End turn'));
    expect(getByText(/\(Poison\)/)).toBeTruthy(); // residual applied
    expect(getByText(/── turn 2 ──/)).toBeTruthy(); // and advanced
  });

  it('End turn pauses on a residual KO (no advance) so a replacement can be sent', () => {
    const ws: Workspace = {
      sideA: { player: 'You', rawPaste: '', mons: [entry('A', 0, 'Incineroar'), entry('A', 1, 'Zapdos')], leads: ['A0', 'A1'] },
      sideB: { player: 'Opp', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      events: [
        { eventId: 't1', seq: 1, turn: 1, type: 'turn_start' },
        { eventId: 'p', seq: 2, turn: 1, type: 'passive_hp_change', target: 'A0', source: 'test', hpBefore: 175, hpAfter: 5 },
        { eventId: 's', seq: 3, turn: 1, type: 'status_applied', target: 'A0', status: 'psn' },
      ],
    };
    function H() {
      const [w, setW] = useState(ws);
      return <TranscribeTab ws={w} setWs={setW} />;
    }
    const { getByText, getAllByText, queryByText } = render(<H />);
    fireEvent.click(getByText('▶ End turn'));
    expect(getAllByText(/fainted/).length).toBeGreaterThan(0); // residual KO recorded
    expect(queryByText(/── turn 2 ──/)).toBeNull(); // did NOT advance
  });

});
