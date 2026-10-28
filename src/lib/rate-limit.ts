/**
 * Limitador em memória (janela deslizante), por chave. Suficiente para uma ferramenta interna de
 * instância única; reinicia junto com o processo. `now` é injetável para os testes.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys: number = 5000
  ) {}

  /** Registra uma tentativa e informa se ela é permitida. */
  consume(key: string, now: number = Date.now()): { readonly allowed: boolean; readonly retryAfterSeconds: number } {
    const recent = (this.hits.get(key) ?? []).filter((time) => now - time < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.prune(now);
    // teto rígido: mesmo com chaves ainda válidas (IPs forjados), a memória não cresce além de maxKeys
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next();
      if (oldest.done) break;
      this.hits.delete(oldest.value);
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private prune(now: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((time) => now - time >= this.windowMs)) this.hits.delete(key);
    }
  }
}
