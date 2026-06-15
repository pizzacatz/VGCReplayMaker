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
});
