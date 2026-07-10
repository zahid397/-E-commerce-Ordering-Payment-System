import { InvalidPaymentStateTransitionError, PaymentEntity } from './payment.entity';

function makePayment(status: 'PENDING' | 'SUCCESS' | 'FAILED' = 'PENDING') {
  return new PaymentEntity({
    id: 'pay1',
    orderId: 'o1',
    provider: 'STRIPE',
    transactionId: 'pi_123',
    status,
  });
}

describe('PaymentEntity', () => {
  it('allows PENDING -> SUCCESS and stores the raw response', () => {
    const payment = makePayment('PENDING');
    payment.markSuccess({ id: 'pi_123', status: 'succeeded' });
    expect(payment.status).toBe('SUCCESS');
    expect(payment.rawResponse).toEqual({ id: 'pi_123', status: 'succeeded' });
  });

  it('allows PENDING -> FAILED', () => {
    const payment = makePayment('PENDING');
    payment.markFailed({ error: 'card_declined' });
    expect(payment.status).toBe('FAILED');
  });

  it('rejects a duplicate SUCCESS webhook after already succeeding', () => {
    const payment = makePayment('SUCCESS');
    expect(() => payment.markSuccess({})).toThrow(InvalidPaymentStateTransitionError);
  });

  it('rejects a late SUCCESS webhook arriving after the payment already failed', () => {
    const payment = makePayment('FAILED');
    expect(() => payment.markSuccess({})).toThrow(InvalidPaymentStateTransitionError);
  });

  it('rejects a late FAILED webhook arriving after the payment already succeeded', () => {
    const payment = makePayment('SUCCESS');
    expect(() => payment.markFailed({})).toThrow(InvalidPaymentStateTransitionError);
  });

  it('isTerminal reflects whether the payment can still transition', () => {
    expect(makePayment('PENDING').isTerminal()).toBe(false);
    expect(makePayment('SUCCESS').isTerminal()).toBe(true);
    expect(makePayment('FAILED').isTerminal()).toBe(true);
  });
});
