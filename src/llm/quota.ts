import { ui } from '../cli/ui.js';

export interface RequestRecord {
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
}

export class QuotaManager {
  private history = new Map<string, RequestRecord[]>();
  private backoffTime = 1000;

  private getHistory(model: string): RequestRecord[] {
    if (!this.history.has(model)) {
      this.history.set(model, []);
    }
    return this.history.get(model)!;
  }

  private cleanHistory(model: string) {
    const records = this.getHistory(model);
    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000; // 24 hours
    const filtered = records.filter(r => r.timestamp > cutoff);
    this.history.set(model, filtered);
  }

  public recordUsage(model: string, inputTokens: number, outputTokens: number) {
    const records = this.getHistory(model);
    records.push({
      timestamp: Date.now(),
      inputTokens,
      outputTokens
    });
    this.cleanHistory(model);
  }

  // Returns wait time in milliseconds if any limit is violated, or 0 if okay
  public checkLimits(model: string, limits: { rpm?: number; rpd?: number; tpm?: number; tpd?: number; itpm?: number; otpm?: number }): number {
    this.cleanHistory(model);
    const records = this.getHistory(model);
    const now = Date.now();

    const min1 = now - 60000;
    const day1 = now - 24 * 60 * 60 * 1000;

    // Filter records for 1m and 1d
    const recs1m = records.filter(r => r.timestamp > min1);
    const recs1d = records.filter(r => r.timestamp > day1);

    // Calculate current usage
    const rpmUsed = recs1m.length;
    const rpdUsed = recs1d.length;

    const tpmUsed = recs1m.reduce((acc, r) => acc + r.inputTokens + r.outputTokens, 0);
    const tpdUsed = recs1d.reduce((acc, r) => acc + r.inputTokens + r.outputTokens, 0);

    const itpmUsed = recs1m.reduce((acc, r) => acc + r.inputTokens, 0);
    const otpmUsed = recs1m.reduce((acc, r) => acc + r.outputTokens, 0);

    let maxWait = 0;

    // Helper: calculate time to wait for minute-level limits
    const getWaitTimeForMinLimit = (neededSlots: number, currentRecords: RequestRecord[]) => {
      if (currentRecords.length < neededSlots) return 0;
      const sorted = [...currentRecords].sort((a, b) => a.timestamp - b.timestamp);
      const index = sorted.length - neededSlots;
      const oldestRequired = sorted[index];
      const elapsed = now - oldestRequired.timestamp;
      return Math.max(0, 60000 - elapsed + 100);
    };

    const getWaitTimeForDayLimit = (neededSlots: number, currentRecords: RequestRecord[]) => {
      if (currentRecords.length < neededSlots) return 0;
      const sorted = [...currentRecords].sort((a, b) => a.timestamp - b.timestamp);
      const index = sorted.length - neededSlots;
      const oldestRequired = sorted[index];
      const elapsed = now - oldestRequired.timestamp;
      return Math.max(0, 24 * 60 * 60 * 1000 - elapsed + 100);
    };

    // RPM
    if (limits.rpm && rpmUsed >= limits.rpm) {
      const wait = getWaitTimeForMinLimit(limits.rpm, recs1m);
      if (wait > maxWait) maxWait = wait;
    }
    // RPD
    if (limits.rpd && rpdUsed >= limits.rpd) {
      const wait = getWaitTimeForDayLimit(limits.rpd, recs1d);
      if (wait > maxWait) maxWait = wait;
    }
    // TPM
    if (limits.tpm && tpmUsed >= limits.tpm) {
      let accumulated = 0;
      const sorted = [...recs1m].sort((a, b) => b.timestamp - a.timestamp);
      let lastNeededTimestamp = now - 60000;
      for (const r of sorted) {
        accumulated += r.inputTokens + r.outputTokens;
        if (accumulated >= limits.tpm) {
          lastNeededTimestamp = r.timestamp;
          break;
        }
      }
      const elapsed = now - lastNeededTimestamp;
      const wait = Math.max(0, 60000 - elapsed + 100);
      if (wait > maxWait) maxWait = wait;
    }
    // TPD
    if (limits.tpd && tpdUsed >= limits.tpd) {
      let accumulated = 0;
      const sorted = [...recs1d].sort((a, b) => b.timestamp - a.timestamp);
      let lastNeededTimestamp = now - 24 * 60 * 60 * 1000;
      for (const r of sorted) {
        accumulated += r.inputTokens + r.outputTokens;
        if (accumulated >= limits.tpd) {
          lastNeededTimestamp = r.timestamp;
          break;
        }
      }
      const elapsed = now - lastNeededTimestamp;
      const wait = Math.max(0, 24 * 60 * 60 * 1000 - elapsed + 100);
      if (wait > maxWait) maxWait = wait;
    }
    // ITPM
    if (limits.itpm && itpmUsed >= limits.itpm) {
      let accumulated = 0;
      const sorted = [...recs1m].sort((a, b) => b.timestamp - a.timestamp);
      let lastNeededTimestamp = now - 60000;
      for (const r of sorted) {
        accumulated += r.inputTokens;
        if (accumulated >= limits.itpm) {
          lastNeededTimestamp = r.timestamp;
          break;
        }
      }
      const elapsed = now - lastNeededTimestamp;
      const wait = Math.max(0, 60000 - elapsed + 100);
      if (wait > maxWait) maxWait = wait;
    }
    // OTPM
    if (limits.otpm && otpmUsed >= limits.otpm) {
      let accumulated = 0;
      const sorted = [...recs1m].sort((a, b) => b.timestamp - a.timestamp);
      let lastNeededTimestamp = now - 60000;
      for (const r of sorted) {
        accumulated += r.outputTokens;
        if (accumulated >= limits.otpm) {
          lastNeededTimestamp = r.timestamp;
          break;
        }
      }
      const elapsed = now - lastNeededTimestamp;
      const wait = Math.max(0, 60000 - elapsed + 100);
      if (wait > maxWait) maxWait = wait;
    }

    return maxWait;
  }

  public async enforceLimits(model: string, limits?: { rpm?: number; rpd?: number; tpm?: number; tpd?: number; itpm?: number; otpm?: number }): Promise<void> {
    if (!limits) return;
    const hasAnyLimit = limits.rpm || limits.rpd || limits.tpm || limits.tpd || limits.itpm || limits.otpm;
    if (!hasAnyLimit) return;

    while (true) {
      const waitTime = this.checkLimits(model, limits);
      if (waitTime <= 0) break;
      ui.warning(`Rate limit threshold approached for ${model}. Pausing execution for ${Math.ceil(waitTime / 1000)}s to remain within configured limits.`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  async handleRateLimit(retryAfterHeader?: string | null): Promise<void> {
    let waitTime = this.backoffTime;

    if (retryAfterHeader) {
      const parsed = parseInt(retryAfterHeader, 10);
      if (!isNaN(parsed)) {
        waitTime = parsed * 1000;
      }
    }

    ui.warning(`Rate limit hit (429). Pausing execution for ${waitTime}ms to prevent TPM exhaustion.`);
    
    return new Promise((resolve) => setTimeout(() => {
      this.backoffTime = Math.min((this.backoffTime * 2) + Math.random() * 500, 60000);
      resolve();
    }, waitTime));
  }

  resetBackoff() {
    this.backoffTime = 1000;
  }
}

export const quotaManager = new QuotaManager();
