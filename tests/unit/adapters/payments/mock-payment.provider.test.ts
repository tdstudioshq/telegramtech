import { describe, expect, it } from 'vitest';
import { MockPaymentProvider } from '../../../../src/adapters/payments/mock-payment.provider.js';
import type { PaymentRequest } from '../../../../src/core/ports/payment-provider.port.js';

const request: PaymentRequest = {
  idempotencyKey: 'k-1',
  amountStars: 50,
  description: 'Unlock "Test"',
  userId: '00000000-0000-4000-8000-000000000001',
  creatorId: '00000000-0000-4000-8000-000000000002',
};

describe('MockPaymentProvider', () => {
  it('walks the real lifecycle and succeeds at failureRate 0', async () => {
    const provider = new MockPaymentProvider({ delayMs: 0, failureRate: 0 });

    const intent = await provider.createIntent(request);
    expect(intent.providerIntentId).toBe('mock_int_k-1');

    const approval = await provider.awaitApproval(intent);
    expect(approval.approved).toBe(true);

    const confirmation = await provider.confirm(intent);
    expect(confirmation).toMatchObject({ status: 'succeeded', providerChargeId: 'mock_ch_k-1' });
  });

  it('always declines at failureRate 1 with a mock reason', async () => {
    const provider = new MockPaymentProvider({ delayMs: 0, failureRate: 1 });
    const intent = await provider.createIntent(request);

    const confirmation = await provider.confirm(intent);

    expect(confirmation).toMatchObject({ status: 'failed', reason: 'mock_declined' });
  });

  it('rolls the injected random against the failure rate deterministically', async () => {
    const rolls = [0.29, 0.31];
    const provider = new MockPaymentProvider(
      { delayMs: 0, failureRate: 0.3 },
      () => rolls.shift() ?? 1,
    );
    const intent = await provider.createIntent(request);

    expect((await provider.confirm(intent)).status).toBe('failed'); // 0.29 < 0.3
    expect((await provider.confirm(intent)).status).toBe('succeeded'); // 0.31 >= 0.3
  });

  it('honors the configured delay', async () => {
    const provider = new MockPaymentProvider({ delayMs: 30, failureRate: 0 });
    const intent = await provider.createIntent(request);

    const start = Date.now();
    await provider.confirm(intent);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });

  it('refunds succeed (port + schema ready; no service path until debt #9)', async () => {
    const provider = new MockPaymentProvider({ delayMs: 0, failureRate: 1 });
    const refund = await provider.refund('mock_ch_k-1', 50);
    expect(refund.status).toBe('refunded');
  });
});
