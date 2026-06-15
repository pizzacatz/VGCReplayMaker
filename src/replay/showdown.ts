/**
 * Generate a Pokémon Showdown battle log from our event log, so a transcribed
 * match can be rendered by the official Showdown replay engine (replay-embed.js)
 * with real sprites/animations. Format matched to a real Champions replay.
 *
 * This is SEPARATE from src/replay/protocol.ts: that drives our own headless
 * stepping/state; this produces the exact wire format the Showdown client wants.
 */

import type { MatchEvent, MatchLog, Side } from '../log';

const WEATHER_ID: Record<string, string> = { Sun: 'SunnyDay', Rain: 'RainDance', Sand: 'Sandstorm', Sandstorm: 'Sandstorm', Snow: 'Snow', Hail: 'Hail' };
const FIELD_CONDITIONS = new Set(['Electric Terrain', 'Grassy Terrain', 'Psychic Terrain', 'Misty Terrain', 'Trick Room', 'Gravity']);
const SIDE_CONDITIONS = new Set(['Reflect', 'Light Screen', 'Aurora Veil', 'Tailwind', 'Safeguard', 'Mist']);

const pside = (side: Side): string => (side === 'A' ? 'p1' : 'p2');
const ab = (pos: number): string => (pos === 0 ? 'a' : 'b');

/** Build the full Showdown battle log (header + team preview + turns). */
export function toShowdownLog(log: MatchLog): string {
  const sheetsA = new Map(log.sideA.mons.map((m) => [m.monId, m]));
  const sheetsB = new Map(log.sideB.mons.map((m) => [m.monId, m]));
  const sheetOf = (id: string) => sheetsA.get(id) ?? sheetsB.get(id);
  const sideOf = (id: string): Side => (sheetsA.has(id) ? 'A' : 'B');
  const playerName = (side: Side) => (side === 'A' ? log.sideA.player : log.sideB.player);

  const slotByMon = new Map<string, string>(); // monId → 'p1a'
  const hpByMon = new Map<string, number>();
  const place = (side: Side, pos: number, monId: string): string => {
    const slot = `${pside(side)}${ab(pos)}`;
    for (const [m, s] of slotByMon) if (s === slot) slotByMon.delete(m);
    slotByMon.set(monId, slot);
    return slot;
  };
  const identName = (id: string) => sheetOf(id)?.nickname ?? sheetOf(id)?.species ?? id;
  const ident = (id: string) => `${slotByMon.get(id) ?? '?'}: ${identName(id)}`;
  const maxOf = (id: string) => sheetOf(id)?.maxHp ?? 100;
  const hpStr = (id: string, hp: number) => (hp <= 0 ? '0 fnt' : `${hp}/${maxOf(id)}`);

  const lines: string[] = [];
  lines.push(`|j|☆${log.sideA.player}`, `|j|☆${log.sideB.player}`);
  lines.push('|gametype|doubles');
  lines.push(`|player|p1|${log.sideA.player}|1|`, `|player|p2|${log.sideB.player}|1|`);
  lines.push('|gen|9', `|tier|${log.format}`);
  lines.push('|clearpoke');
  for (const m of log.sideA.mons) lines.push(`|poke|p1|${m.species}, L50|`);
  for (const m of log.sideB.mons) lines.push(`|poke|p2|${m.species}, L50|`);

  const brought = new Set<string>(log.leads.map((l) => l.monId));
  for (const e of log.events) if (e.type === 'switch') brought.add(e.in);
  const sizeA = [...brought].filter((id) => sheetsA.has(id)).length || log.sideA.mons.length;
  const sizeB = [...brought].filter((id) => sheetsB.has(id)).length || log.sideB.mons.length;
  lines.push(`|teampreview|${Math.max(sizeA, sizeB, 4)}`);
  lines.push(`|teamsize|p1|${sizeA}`, `|teamsize|p2|${sizeB}`, '|start');

  for (const lead of log.leads) {
    place(lead.side, lead.position, lead.monId);
    const sh = sheetOf(lead.monId)!;
    hpByMon.set(lead.monId, sh.maxHp);
    lines.push(`|switch|${ident(lead.monId)}|${sh.species}, L50|${sh.maxHp}/${sh.maxHp}`);
  }

  for (const ev of [...log.events].sort((a, b) => a.seq - b.seq)) emit(ev);
  if (log.result) {
    // Communicate HOW the game ended (a concession, not a random win).
    const loser: Side = log.result.winnerSide === 'A' ? 'B' : 'A';
    if (log.result.reason === 'forfeit') lines.push(`|-message|${playerName(loser)} forfeited.`);
    else if (log.result.reason === 'timeout') lines.push(`|-message|${playerName(loser)} lost due to inactivity.`);
    else if (log.result.reason === 'dq') lines.push(`|-message|${playerName(loser)} was disqualified.`);
    lines.push(`|win|${playerName(log.result.winnerSide)}`);
  }
  return lines.join('\n');

  function emit(ev: MatchEvent): void {
    switch (ev.type) {
      case 'turn_start':
        lines.push(`|turn|${ev.turn}`);
        return;
      case 'move_used': {
        const tgt = ev.targets.map((t) => slotByMon.get(t) && ident(t)).filter(Boolean)[0] ?? ident(ev.user);
        lines.push(`|move|${ident(ev.user)}|${ev.move}|${tgt}`);
        return;
      }
      case 'damage': {
        if (ev.crit) lines.push(`|-crit|${ident(ev.defender)}`);
        if (ev.observedEffectiveness === '2x' || ev.observedEffectiveness === '4x') lines.push(`|-supereffective|${ident(ev.defender)}`);
        else if (ev.observedEffectiveness === '0.5x' || ev.observedEffectiveness === '0.25x') lines.push(`|-resisted|${ident(ev.defender)}`);
        else if (ev.observedEffectiveness === '0x') lines.push(`|-immune|${ident(ev.defender)}`);
        hpByMon.set(ev.defender, ev.hpAfter);
        lines.push(`|-damage|${ident(ev.defender)}|${hpStr(ev.defender, ev.hpAfter)}`);
        return;
      }
      case 'passive_hp_change':
        hpByMon.set(ev.target, ev.hpAfter);
        lines.push(`|-damage|${ident(ev.target)}|${hpStr(ev.target, ev.hpAfter)}|[from] ${ev.source}`);
        return;
      case 'heal':
        hpByMon.set(ev.target, ev.hpAfter);
        lines.push(`|-heal|${ident(ev.target)}|${hpStr(ev.target, ev.hpAfter)}|[from] ${ev.source}`);
        return;
      case 'switch': {
        place(ev.side, ev.position, ev.in);
        const sh = sheetOf(ev.in)!;
        const hp = hpByMon.get(ev.in) ?? sh.maxHp;
        hpByMon.set(ev.in, hp);
        lines.push(`|switch|${ident(ev.in)}|${sh.species}, L50|${hpStr(ev.in, hp)}`);
        return;
      }
      case 'faint':
        lines.push(`|faint|${ident(ev.target)}`);
        return;
      case 'status_applied':
        lines.push(`|-status|${ident(ev.target)}|${ev.status}`);
        return;
      case 'status_cured':
        lines.push(`|-curestatus|${ident(ev.target)}|${ev.status}`);
        return;
      case 'stat_stage_change': {
        const verb = ev.stages >= 0 ? '-boost' : '-unboost';
        lines.push(`|${verb}|${ident(ev.target)}|${ev.stat}|${Math.abs(ev.stages)}`);
        return;
      }
      case 'field_change': {
        if (ev.side || SIDE_CONDITIONS.has(ev.field)) {
          const side = ev.side ?? 'A';
          lines.push(`|${ev.action === 'set' ? '-sidestart' : '-sideend'}|${pside(side)}: ${playerName(side)}|move: ${ev.field}`);
        } else if (WEATHER_ID[ev.field] || ev.field === 'Sun' || ev.field === 'Rain') {
          lines.push(`|-weather|${ev.action === 'set' ? WEATHER_ID[ev.field] ?? ev.field : 'none'}`);
        } else if (FIELD_CONDITIONS.has(ev.field)) {
          lines.push(`|${ev.action === 'set' ? '-fieldstart' : '-fieldend'}|move: ${ev.field}`);
        }
        return;
      }
      case 'mega_evolution':
        lines.push(`|detailschange|${ident(ev.mon)}|${ev.megaSpecies}, L50`);
        lines.push(`|-mega|${ident(ev.mon)}|${identName(ev.mon)}|`);
        return;
      case 'item_or_ability_event':
        lines.push(`|-${ev.kind}|${ident(ev.mon)}|${ev.name}`);
        return;
      case 'random_outcome':
        return; // implied; no standalone Showdown message
    }
  }
}

/** A standalone HTML page that renders the log with the official Showdown replay engine. */
export function showdownReplayHtml(log: MatchLog): string {
  const data = toShowdownLog(log);
  const title = `${log.sideA.player} vs ${log.sideB.player}`;
  return `<!DOCTYPE html>
<meta charset="utf-8" />
<title>${title}</title>
<div class="wrapper replay-wrapper" style="max-width:1180px;margin:0 auto">
<div class="battle"></div><div class="battle-log"></div><div class="replay-controls"></div><div class="replay-controls-2"></div>
<script type="text/plain" class="battle-log-data">${data}</script>
</div>
<script>
let daily = Math.floor(Date.now()/1000/60/60/24);document.write('<scr'+'ipt src="https://play.pokemonshowdown.com/js/replay-embed.js?version'+daily+'"></scr'+'ipt>');
</script>`;
}
