interface UsageRecord {
  timestamp: number;
  tokens: number;
  requests: number;
}

export class TokenLimiter {
  private static instance: TokenLimiter;
  private minuteLog: UsageRecord[] = [];
  private dayLog: UsageRecord[] = [];

  private constructor() {}

  public static getInstance(): TokenLimiter {
    if (!TokenLimiter.instance) {
      TokenLimiter.instance = new TokenLimiter();
    }
    return TokenLimiter.instance;
  }

  public addUsage(tokens: number) {
    const now = Date.now();
    this.minuteLog.push({ timestamp: now, tokens, requests: 1 });
    this.dayLog.push({ timestamp: now, tokens, requests: 1 });
    this.cleanup();
  }

  private cleanup() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    const oneDayAgo = now - 86400000; // 24 hours

    this.minuteLog = this.minuteLog.filter(log => log.timestamp > oneMinuteAgo);
    this.dayLog = this.dayLog.filter(log => log.timestamp > oneDayAgo);
  }

  public getMinuteUsage() {
    this.cleanup();
    return this.minuteLog.reduce((acc, log) => {
      acc.tokens += log.tokens;
      acc.requests += log.requests;
      return acc;
    }, { tokens: 0, requests: 0 });
  }

  public getDayUsage() {
    this.cleanup();
    return this.dayLog.reduce((acc, log) => {
      acc.tokens += log.tokens;
      acc.requests += log.requests;
      return acc;
    }, { tokens: 0, requests: 0 });
  }

  public async checkAndWait(provider: string, config: any, ui: any): Promise<void> {
    if (provider.toLowerCase() === 'ollama') {
      return; // Local models don't have API rate limits
    }

    const activeModel = config.providers[provider as keyof typeof config.providers]?.activeModel || 'default';
    const limits = config.modelLimits?.[activeModel] || {};

    // Defaults if nothing is set in config
    const maxTpm = limits.tpm || Infinity;
    const maxTpd = limits.tpd || Infinity;
    const maxRpm = limits.rpm || Infinity;
    const maxRpd = limits.rpd || Infinity;

    let warningShown = false;
    let limitExceeded = true;

    while (limitExceeded) {
      const minUsage = this.getMinuteUsage();
      const dayUsage = this.getDayUsage();

      const hitsTpm = minUsage.tokens >= maxTpm;
      const hitsTpd = dayUsage.tokens >= maxTpd;
      const hitsRpm = minUsage.requests >= maxRpm;
      const hitsRpd = dayUsage.requests >= maxRpd;

      if (hitsTpm || hitsTpd || hitsRpm || hitsRpd) {
        if (!warningShown) {
          const reasons = [];
          if (hitsTpm) reasons.push(`TPM (${maxTpm})`);
          if (hitsTpd) reasons.push(`TPD (${maxTpd})`);
          if (hitsRpm) reasons.push(`RPM (${maxRpm})`);
          if (hitsRpd) reasons.push(`RPD (${maxRpd})`);

          ui.error(`Model limit exceeded: ${reasons.join(', ')}. Pausing API requests...`);
          warningShown = true;
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
      } else {
        limitExceeded = false;
      }
    }
  }
}
