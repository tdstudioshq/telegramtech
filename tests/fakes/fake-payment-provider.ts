/**
 * Scriptable FakePaymentProvider (testing strategy) — queue outcomes per confirm
 * call; default succeeds. Records every lifecycle call so tests can assert the
 * createIntent → awaitApproval → confirm order.
 */
import type {
  PaymentApproval,
  PaymentConfirmation,
  PaymentIntent,
  PaymentProvider,
  PaymentRequest,
  RefundOutcome,
} from '../../src/core/ports/payment-provider.port.js';
import type { Stars } from '../../src/shared/domain.js';

type ScriptedOutcome = { succeed: true } | { succeed: false; reason: string };

export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'mock' as const;
  readonly calls: string[] = [];
  private script: ScriptedOutcome[] = [];
  private approvalRejection: string | null = null;

  /** Queue the next confirm() outcomes, in order. Unqueued calls succeed. */
  scriptConfirm(...outcomes: ScriptedOutcome[]): void {
    this.script.push(...outcomes);
  }

  failNext(reason = 'declined'): void {
    this.scriptConfirm({ succeed: false, reason });
  }

  rejectNextApproval(reason = 'pre_checkout_rejected'): void {
    this.approvalRejection = reason;
  }

  async createIntent(request: PaymentRequest): Promise<PaymentIntent> {
    this.calls.push('createIntent');
    return { providerIntentId: `fake_int_${request.idempotencyKey}`, request };
  }

  async awaitApproval(_intent: PaymentIntent): Promise<PaymentApproval> {
    this.calls.push('awaitApproval');
    if (this.approvalRejection !== null) {
      const reason = this.approvalRejection;
      this.approvalRejection = null;
      return { approved: false, reason };
    }
    return { approved: true };
  }

  async confirm(intent: PaymentIntent): Promise<PaymentConfirmation> {
    this.calls.push('confirm');
    const scripted = this.script.shift() ?? { succeed: true as const };
    if (!scripted.succeed) {
      return { status: 'failed', reason: scripted.reason, rawPayload: { fake: true } };
    }
    return {
      status: 'succeeded',
      providerChargeId: `fake_ch_${intent.request.idempotencyKey}`,
      rawPayload: { fake: true },
    };
  }

  async refund(providerChargeId: string, _amountStars: Stars): Promise<RefundOutcome> {
    this.calls.push('refund');
    return { status: 'refunded', rawPayload: { fake: true, providerChargeId } };
  }
}
