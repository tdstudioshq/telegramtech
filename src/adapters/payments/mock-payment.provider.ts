/**
 * MockPaymentProvider (ADR-005, Q4) — implements the REAL Stars lifecycle shape,
 * auto-resolving the phases a human would drive: approval always passes, confirm
 * rolls the configured failure rate. Configurable latency exercises the pending
 * UX; injectable `random` makes tests deterministic. The business layer never
 * learns this isn't real money.
 */
import type {
  PaymentApproval,
  PaymentConfirmation,
  PaymentIntent,
  PaymentProvider,
  PaymentRequest,
  RefundOutcome,
} from '../../core/ports/payment-provider.port.js';
import type { Stars } from '../../shared/domain.js';

export interface MockPaymentConfig {
  /** Simulated provider latency per phase (MOCK_PAYMENT_DELAY_MS). */
  readonly delayMs: number;
  /** 0..1 — probability confirm() declines (MOCK_PAYMENT_FAILURE_RATE). */
  readonly failureRate: number;
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock' as const;

  constructor(
    private readonly config: MockPaymentConfig,
    private readonly random: () => number = Math.random,
  ) {}

  async createIntent(request: PaymentRequest): Promise<PaymentIntent> {
    return { providerIntentId: `mock_int_${request.idempotencyKey}`, request };
  }

  async awaitApproval(_intent: PaymentIntent): Promise<PaymentApproval> {
    await this.delay();
    return { approved: true };
  }

  async confirm(intent: PaymentIntent): Promise<PaymentConfirmation> {
    await this.delay();
    if (this.random() < this.config.failureRate) {
      return {
        status: 'failed',
        reason: 'mock_declined',
        rawPayload: { mock: true, intentId: intent.providerIntentId },
      };
    }
    return {
      status: 'succeeded',
      providerChargeId: `mock_ch_${intent.request.idempotencyKey}`,
      rawPayload: { mock: true, intentId: intent.providerIntentId },
    };
  }

  async refund(providerChargeId: string, _amountStars: Stars): Promise<RefundOutcome> {
    await this.delay();
    return { status: 'refunded', rawPayload: { mock: true, providerChargeId } };
  }

  private delay(): Promise<void> {
    if (this.config.delayMs <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, this.config.delayMs));
  }
}
