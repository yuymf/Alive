import { wallNow } from './time-utils';

export class TaskDeadline {
  private readonly startedAtMs: number;

  constructor(
    readonly budgetMs: number,
    readonly label = 'task',
    startedAtMs = Date.now(),
  ) {
    this.startedAtMs = startedAtMs;
  }

  static fromEnv(label: string, envKey: string, defaultBudgetMs: number): TaskDeadline {
    const raw = process.env[envKey];
    const parsed = raw ? Number(raw) : NaN;
    const budgetMs = Number.isFinite(parsed) && parsed > 0 ? parsed : defaultBudgetMs;
    return new TaskDeadline(budgetMs, label);
  }

  elapsedMs(): number {
    return Date.now() - this.startedAtMs;
  }

  remainingMs(): number {
    return Math.max(0, this.budgetMs - this.elapsedMs());
  }

  expired(): boolean {
    return this.remainingMs() <= 0;
  }

  hasAtLeast(minRemainingMs: number): boolean {
    return this.remainingMs() >= minRemainingMs;
  }

  shouldStart(minRemainingMs: number, label?: string): boolean {
    const ok = this.hasAtLeast(minRemainingMs);
    if (!ok) {
      console.warn(
        `[${wallNow().toISOString()}] [deadline:${this.label}] skip ${label ?? 'next step'}: ` +
        `only ${Math.round(this.remainingMs() / 1000)}s remaining`,
      );
    }
    return ok;
  }

  ensure(minRemainingMs: number, label?: string): void {
    if (!this.shouldStart(minRemainingMs, label)) {
      throw new Error(
        `[deadline:${this.label}] budget too low for ${label ?? 'next step'} ` +
        `(${Math.round(this.remainingMs() / 1000)}s remaining)`,
      );
    }
  }
}
