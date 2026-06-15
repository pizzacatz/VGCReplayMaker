/**
 * Main-thread bridge to the solve worker. One persistent worker is reused so the
 * damage-factor memo cache (inside the worker) stays warm across re-solves —
 * excluding a hit and re-solving is then near-instant. Falls back to a synchronous
 * solve if Web Workers aren't available (or the worker fails to start).
 */

import { runSolve, type Workspace } from './model';
import { solveTournament, type Tournament } from './store';
import type { SolveResult } from '../solver';
import type { InstanceReport } from '../aggregation';

export type Progress = (done: number, total: number) => void;
type Message = { kind: 'game'; ws: Workspace } | { kind: 'tournament'; tournament: Tournament };

let worker: Worker | null = null;

function getWorker(): Worker {
  if (!worker) worker = new Worker(new URL('./solve.worker.ts', import.meta.url), { type: 'module' });
  return worker;
}

function viaWorker<T>(message: Message, onProgress?: Progress): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const w = getWorker();
    w.onmessage = (e: MessageEvent) => {
      const d = e.data as { type: 'progress'; done: number; total: number } | { type: 'result'; result: T } | { type: 'error'; message: string };
      if (d.type === 'progress') onProgress?.(d.done, d.total);
      else if (d.type === 'result') resolve(d.result);
      else reject(new Error(d.message));
    };
    w.onerror = (err) => reject(new Error(err.message || 'solve worker failed'));
    w.postMessage(message);
  });
}

export async function solveGameAsync(ws: Workspace, onProgress?: Progress): Promise<SolveResult> {
  if (typeof Worker === 'undefined') return runSolve(ws, onProgress);
  try {
    return await viaWorker<SolveResult>({ kind: 'game', ws }, onProgress);
  } catch {
    worker = null; // reset a broken worker; fall back to a (blocking) main-thread solve
    return runSolve(ws, onProgress);
  }
}

export async function solveTournamentAsync(tournament: Tournament, onProgress?: Progress): Promise<Map<string, InstanceReport>> {
  if (typeof Worker === 'undefined') return solveTournament(tournament, onProgress);
  try {
    return await viaWorker<Map<string, InstanceReport>>({ kind: 'tournament', tournament }, onProgress);
  } catch {
    worker = null;
    return solveTournament(tournament, onProgress);
  }
}
