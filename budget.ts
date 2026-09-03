// budget.ts — a ceiling on writes, per principal.
//
// Sized to stop a client in a retry loop, not a person. Nobody records twenty
// flowers in a minute; an agent looping on a failed call issues a thousand, and
// every one of them is a commit.

export class RateLimitError extends Error {
  readonly status = 429;
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

interface Window {
  startedAt: number;
  count: number;
}

export class WriteBudget {
  private readonly minutes = new Map<string, Window>();
  private readonly days = new Map<string, Window>();

  constructor(
    private readonly perMinute: number,
    private readonly perDay: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Charge one write, or refuse.
   *
   * Both windows are checked before either is charged: a refusal on the daily
   * ceiling must not also quietly spend the minute's allowance, or the caller
   * ends up rate-limited twice for one attempt.
   */
  consume(principal: string): void {
    const now = this.now();
    this.check(this.minutes, principal, now, 60_000, this.perMinute, "per minute");
    this.check(this.days, principal, now, 86_400_000, this.perDay, "per day");
    this.commit(this.minutes, principal, now, 60_000);
    this.commit(this.days, principal, now, 86_400_000);
  }

  remaining(principal: string): { minute: number; day: number } {
    const now = this.now();
    return {
      minute: this.perMinute - this.countIn(this.minutes, principal, now, 60_000),
      day: this.perDay - this.countIn(this.days, principal, now, 86_400_000),
    };
  }

  private countIn(
    windows: Map<string, Window>,
    principal: string,
    now: number,
    span: number,
  ): number {
    const window = windows.get(principal);
    if (!window || now - window.startedAt >= span) return 0;
    return window.count;
  }

  private check(
    windows: Map<string, Window>,
    principal: string,
    now: number,
    span: number,
    limit: number,
    label: string,
  ): void {
    const used = this.countIn(windows, principal, now, span);
    if (used >= limit) {
      const window = windows.get(principal)!;
      const retryIn = Math.ceil((span - (now - window.startedAt)) / 1000);
      throw new RateLimitError(`Write limit reached (${limit} ${label}). Try again in ${retryIn}s.`);
    }
  }

  private commit(windows: Map<string, Window>, principal: string, now: number, span: number): void {
    const window = windows.get(principal);
    if (!window || now - window.startedAt >= span) {
      windows.set(principal, { startedAt: now, count: 1});
      return;
    }
    window.count++;
  }
}
