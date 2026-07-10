import { BadRequestException, Injectable } from '@nestjs/common';
import { StripePaymentStrategy } from './stripe.strategy';
import { BkashPaymentStrategy } from './bkash.strategy';
import { PaymentProviderName, PaymentStrategy } from './payment-strategy.interface';

@Injectable()
export class PaymentStrategyFactory {
  private readonly strategies: Map<PaymentProviderName, PaymentStrategy>;

  constructor(
    private readonly stripeStrategy: StripePaymentStrategy,
    private readonly bkashStrategy: BkashPaymentStrategy,
  ) {
    this.strategies = new Map<PaymentProviderName, PaymentStrategy>([
      ['STRIPE', this.stripeStrategy],
      ['BKASH', this.bkashStrategy],
    ]);
  }

  /**
   * Adding a new provider later (say, "SSLCOMMERZ") means: implement
   * PaymentStrategy in a new class, register it in this map — nothing in
   * PaymentsService, OrdersService, or any controller needs to change.
   * That's the entire point of the strategy pattern requirement here.
   */
  getStrategy(provider: string): PaymentStrategy {
    const strategy = this.strategies.get(provider as PaymentProviderName);
    if (!strategy) {
      throw new BadRequestException(
        `Unsupported payment provider "${provider}". Supported: ${[...this.strategies.keys()].join(', ')}`,
      );
    }
    return strategy;
  }
}
