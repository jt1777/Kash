import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from '../config';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'EPERM';
  }
}

/**
 * Prevents overlapping batch processor runs (e.g. two `npm start`s on the same contract).
 * Stale locks from dead processes are replaced automatically.
 */
export class BatchRunLock {
  private readonly lockFile: string;
  private acquired = false;

  constructor() {
    const id = `${config.product}-${config.kashYieldAddress.toLowerCase()}`;
    this.lockFile = path.join(os.tmpdir(), 'kashyield-bot', `${id}.lock`);
  }

  acquire(): void {
    fs.mkdirSync(path.dirname(this.lockFile), { recursive: true });

    if (fs.existsSync(this.lockFile)) {
      const raw = fs.readFileSync(this.lockFile, 'utf8').trim();
      const pid = parseInt(raw.split('\n')[0] ?? '', 10);
      if (!Number.isNaN(pid) && isProcessAlive(pid)) {
        throw new Error(
          `Another batch bot is already running (pid ${pid}). ` +
            `If that process is dead, remove the lock file: ${this.lockFile}`,
        );
      }
      fs.unlinkSync(this.lockFile);
    }

    fs.writeFileSync(this.lockFile, `${process.pid}\n${Date.now()}\n`, { flag: 'wx' });
    this.acquired = true;
  }

  release(): void {
    if (!this.acquired) return;
    try {
      if (fs.existsSync(this.lockFile)) {
        const raw = fs.readFileSync(this.lockFile, 'utf8');
        const pid = parseInt(raw.split('\n')[0] ?? '', 10);
        if (pid === process.pid) {
          fs.unlinkSync(this.lockFile);
        }
      }
    } catch {
      // Best-effort cleanup on exit.
    }
    this.acquired = false;
  }
}
