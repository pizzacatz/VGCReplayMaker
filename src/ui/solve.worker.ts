/**
 * Solve worker: runs the (heavy, synchronous) reverse-engineering off the UI
 * thread so the tab stays responsive, posting progress between hits. Both
 * runSolve and solveTournament are DOM-free, so they run here unchanged. The
 * worker is kept alive by the main thread, so the damage-factor memo cache stays
 * warm across re-solves.
 */

import { runSolve } from './model';
import { solveTournament } from './store';

const ctx = self as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage: (m: unknown) => void };

ctx.onmessage = (e: MessageEvent) => {
  const data = e.data as
    | { kind: 'game'; ws: Parameters<typeof runSolve>[0] }
    | { kind: 'tournament'; tournament: Parameters<typeof solveTournament>[0] };
  const onProgress = (done: number, total: number) => ctx.postMessage({ type: 'progress', done, total });
  try {
    const result = data.kind === 'game' ? runSolve(data.ws, onProgress) : solveTournament(data.tournament, onProgress);
    ctx.postMessage({ type: 'result', result });
  } catch (err) {
    ctx.postMessage({ type: 'error', message: (err as Error).message });
  }
};
