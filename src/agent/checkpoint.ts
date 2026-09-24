import fs from 'node:fs';
import path from 'node:path';
import type { RunState } from '../types.ts';
import { writeJsonAtomic } from '../util.ts';

export class RunLog {
  dir: string;
  file: string;
  seq = 0;

  constructor(dir: string) {
    this.dir = dir;
    this.file = path.join(dir, 'trajectory.jsonl');
    fs.mkdirSync(dir, { recursive: true });
  }

  event(type: string, data: unknown): void {
    const line = JSON.stringify({ seq: ++this.seq, ts: new Date().toISOString(), type, data });
    fs.appendFileSync(this.file, line + '\n');
  }

  saveState(state: RunState): void {
    writeJsonAtomic(path.join(this.dir, 'state.json'), state);
  }

  static loadState(dir: string): RunState {
    return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  }

  static loadEvents(dir: string): any[] {
    const file = path.join(dir, 'trajectory.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
}
