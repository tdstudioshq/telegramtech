/**
 * PaymentProvider port (ADR-005) — shaped after the REAL Telegram Stars lifecycle:
 * createIntent → awaitApproval (pre-checkout) → confirm → refund. The mock adapts
 * to this shape (auto-resolving phases), never vice versa, so the real provider
 * slots in with zero service changes. The business layer never learns which
 * provider ran.
 */
import type { CreatorId, PaymentProviderName, Stars, UserId } from '../../shared/domain.js';

export interface PaymentRequest {
  /** Client-generated per logical attempt; absorbs double-taps via payments.idempotency_key. */
  readonly idempotencyKey: string;
  readonly amountStars: Stars;
  readonly description: string;
  readonly userId: UserId;
  readonly creatorId: CreatorId;
}

export interface PaymentIntent {
  readonly providerIntentId: string;
  readonly request: PaymentRequest;
}

export type PaymentApproval =
  | { readonly approved: true }
  | { readonly approved: false; readonly reason: string };

export type PaymentConfirmation =
  | {
      readonly status: 'succeeded';
      readonly providerChargeId: string;
      readonly rawPayload?: unknown;
    }
  | { readonly status: 'failed'; readonly reason: string; readonly rawPayload?: unknown };

export type RefundOutcome =
  | { readonly status: 'refunded'; readonly rawPayload?: unknown }
  | { readonly status: 'failed'; readonly reason: string; readonly rawPayload?: unknown };

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  createIntent(request: PaymentRequest): Promise<PaymentIntent>;
  /** Pre-checkout phase (real Stars asks the provider to approve before charging). */
  awaitApproval(intent: PaymentIntent): Promise<PaymentApproval>;
  confirm(intent: PaymentIntent): Promise<PaymentConfirmation>;
  /** Port + schema support refunds now; no service path/UX until debt #9 triggers. */
  refund(providerChargeId: string, amountStars: Stars): Promise<RefundOutcome>;
}
