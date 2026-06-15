import { useState } from 'react';
import type { MonReport, SolveResult } from '../solver';
import type { InstanceReport } from '../aggregation';
import { runSolve, type Workspace } from './model';
import { activeTournament, solveTournament, teamById, type ScoutingStore } from './store';

type Scope = 'game' | 'tournament';

export function SolveTab({ ws, store }: { ws: Workspace; store: ScoutingStore }) {
  const [scope, setScope] = useState<Scope>('tournament');
  const [result, setResult] = useState<SolveResult | null>(null);
  const [tResult, setTResult] = useState<Map<string, InstanceReport> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const solve = () => {
    setBusy(true);
    setError(undefined);
    setResult(null);
    setTResult(null);
    // Yield so the "Solving…" state paints before the (synchronous) solve runs.
    setTimeout(() => {
      try {
        if (scope === 'game') {
          setResult(runSolve(ws));
        } else {
          const t = activeTournament(store);
          if (!t) throw new Error('no active tournament');
          setTResult(solveTournament(t));
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    }, 20);
  };

  const t = activeTournament(store);

  return (
    <div>
      <div className="controls">
        <button className={scope === 'tournament' ? 'active' : ''} onClick={() => setScope('tournament')}>
          Whole tournament (per opponent)
        </button>
        <button className={scope === 'game' ? 'active' : ''} onClick={() => setScope('game')}>
          This game only
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          {scope === 'tournament'
            ? 'every game of each player feeds one spread — more games, tighter bounds'
            : 'just the active game'}
        </span>
      </div>
      <div className="controls">
        <button className="primary" onClick={solve} disabled={busy}>
          {busy ? 'Solving…' : 'Reverse-engineer spreads'}
        </button>
        <span className="muted">
          Consumes only clean hits. Tags: <span className="tag read">read</span> <span className="tag locked">locked</span>{' '}
          <span className="tag bounded">bounded</span> <span className="tag guessed">guessed</span>
        </span>
      </div>
      {error && <p className="error">Error: {error}</p>}

      {result && (
        <div className="row">
          {result.mons.map((m) => (
            <MonCard key={m.monId} report={m} />
          ))}
        </div>
      )}

      {tResult &&
        [...tResult.values()].map((inst) => {
          const team = teamById(t, inst.instanceId);
          if (inst.mons.length === 0) return null;
          return (
            <div key={inst.instanceId} style={{ marginTop: 16 }}>
              <h2 style={{ marginBottom: 4 }}>{team?.player ?? inst.instanceId}</h2>
              {inst.flags.map((f, i) => (
                <p key={i} className="muted" style={{ fontSize: 12, margin: 0 }}>⚠ {f}</p>
              ))}
              <div className="row">
                {inst.mons.map((m) => (
                  <MonCard key={m.monId} report={m.report} />
                ))}
              </div>
            </div>
          );
        })}
    </div>
  );
}

const STAT_ORDER = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

function MonCard({ report }: { report: MonReport }) {
  return (
    <div className="col panel" style={{ minWidth: 360 }}>
      <h2 style={{ marginTop: 0 }}>
        {report.species} <span className="muted">· {report.method ?? '—'}</span>
      </h2>

      {report.contradiction && (
        <div className="panel" style={{ background: 'var(--panel2)', border: '1px solid var(--bad)', marginBottom: 10 }}>
          <p className="error" style={{ marginTop: 0 }}>⚠ {report.contradiction}</p>
          {report.contradictionStat && (
            <>
              <div style={{ fontSize: 12.5 }}>
                These <strong>{report.contradictionStat.toUpperCase()}</strong> hits can't all be true — one is likely
                mis-transcribed (wrong HP, crit, weather/screen) or the mon Mega-evolved. Fix the offending event, or
                exclude its game (⊘ in the nav), then re-solve:
              </div>
              <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, marginTop: 4 }}>
                {report.evidence.hits
                  .filter((h) => h.stat === report.contradictionStat)
                  .map((h, i) => (
                    <div key={i}>
                      {h.role === 'taken' ? '⮜ took ' : '⮞ dealt '}
                      <strong>{h.move}</strong> {h.role === 'taken' ? 'from' : 'to'} {h.opponentSpecies} · {h.observedDamage} dmg
                      {h.source ? <span className="muted"> · {h.source}</span> : null}
                    </div>
                  ))}
              </div>
            </>
          )}
        </div>
      )}

      {report.headline && (
        <div className="panel" style={{ background: 'var(--panel2)', marginBottom: 10 }}>
          <strong>Headline</strong> <span className="muted">({report.headline.confidencePct}%)</span>
          <div style={{ fontFamily: 'ui-monospace, monospace', marginTop: 4 }}>
            HP {report.spHp} · Atk {report.headline.spread.atk} · Def {report.headline.spread.def} · SpA{' '}
            {report.headline.spread.spa} · SpD {report.headline.spread.spd} · Spe {report.headline.spread.spe}
          </div>
        </div>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'ui-monospace, monospace', fontSize: 13 }}>
        <tbody>
          {[...report.perStat]
            .sort((a, b) => STAT_ORDER.indexOf(a.stat) - STAT_ORDER.indexOf(b.stat))
            .map((s) => (
              <tr key={s.stat}>
                <td style={{ color: 'var(--muted)', width: 44 }}>{s.stat.toUpperCase()}</td>
                <td style={{ width: 60 }}>{s.best} SP</td>
                <td style={{ width: 70 }}>
                  <span className={`tag ${s.tag}`}>{s.tag}</span>
                </td>
                <td style={{ color: 'var(--muted)' }}>{s.tag === 'bounded' && s.range ? `range ${s.range[0]}–${s.range[1]}` : ''}</td>
              </tr>
            ))}
        </tbody>
      </table>

      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        {report.evidence.cleanHitsIn} clean hits taken · {report.evidence.cleanHitsOut} dealt · {report.evidence.speedFacts} speed facts
      </div>

      {report.evidence.hits.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12.5 }}>
            Show the {report.evidence.hits.length} hits used to derive this
          </summary>
          <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, marginTop: 4 }}>
            {[...report.evidence.hits]
              .sort((a, b) => a.stat.localeCompare(b.stat))
              .map((h, i) => (
                <div key={i} style={{ padding: '1px 0' }}>
                  <span className="tag bounded" style={{ marginRight: 4 }}>{h.stat.toUpperCase()}</span>
                  {h.role === 'taken' ? '⮜ took ' : '⮞ dealt '}
                  <strong>{h.move}</strong> {h.role === 'taken' ? 'from' : 'to'} {h.opponentSpecies} ·{' '}
                  {h.observedDamage} dmg
                  {h.source ? <span className="muted"> · {h.source}</span> : null}
                </div>
              ))}
            <div className="muted" style={{ marginTop: 3 }}>
              taken → constrains its defenses · dealt → its offenses
            </div>
          </div>
        </details>
      )}

      {report.candidates.length > 0 && (
        <>
          <h2>Candidates</h2>
          <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }}>
            {report.candidates.map((c, i) => (
              <div key={i}>
                {i + 1}. {c.spread.atk}/{c.spread.def}/{c.spread.spa}/{c.spread.spd}/{c.spread.spe}{' '}
                <span className="muted">{c.confidencePct}%</span>
              </div>
            ))}
            <div className="muted">remaining mass: {report.remainingMassPct}%</div>
          </div>
        </>
      )}

      {report.missing.length > 0 && (
        <>
          <h2>What would tighten this</h2>
          {report.missing.map((m, i) => (
            <div key={i} style={{ fontSize: 12.5, marginBottom: 4 }}>
              <span className={`tag ${m.tag}`}>{m.stat}</span> {m.reason}{' '}
              <span style={{ color: 'var(--accent)' }}>{m.resolve}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
