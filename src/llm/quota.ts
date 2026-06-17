import { ui } from '../cli/ui.js';

export class QuotaManager {
  private backoffTime = 1000;
  private maxRetries = 3;

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
      // Exponential backoff with jitter for future hits
      this.backoffTime = Math.min((this.backoffTime * 2) + Math.random() * 500, 60000);
      resolve();
    }, waitTime));
  }

  resetBackoff() {
    this.backoffTime = 1000;
  }
}

export const quotaManager = new QuotaManager();
