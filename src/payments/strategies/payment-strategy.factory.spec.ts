import { BadRequestException } from '@nestjs/common';
import { PaymentStrategyFactory } from './payment-strategy.factory';
import { StripePaymentStrategy } from './stripe.strategy';
import { BkashPaymentStrategy } from './bkash.strategy';

describe('PaymentStrategyFactory', () => {
  const stripeStrategy = { provider: 'STRIPE' } as unknown as StripePaymentStrategy;
  const bkashStrategy = { provider: 'BKASH' } as unknown as BkashPaymentStrategy;
  const factory = new PaymentStrategyFactory(stripeStrategy, bkashStrategy);

  it('dispatches to the Stripe strategy for provider "STRIPE"', () => {
    expect(factory.getStrategy('STRIPE')).toBe(stripeStrategy);
  });

  it('dispatches to the bKash strategy for provider "BKASH"', () => {
    expect(factory.getStrategy('BKASH')).toBe(bkashStrategy);
  });

  it('throws a clear, actionable error for an unsupported provider', () => {
    expect(() => factory.getStrategy('PAYPAL')).toThrow(BadRequestException);
    expect(() => factory.getStrategy('PAYPAL')).toThrow(/Unsupported payment provider/);
  });
});
