import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { StripePaymentStrategy } from './strategies/stripe.strategy';
import { BkashPaymentStrategy } from './strategies/bkash.strategy';
import { BkashHttpClient } from './strategies/bkash-http.client';
import { PaymentStrategyFactory } from './strategies/payment-strategy.factory';
import { ProductsModule } from '../products/products.module';

@Module({
  imports: [ProductsModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    StripePaymentStrategy,
    BkashPaymentStrategy,
    BkashHttpClient,
    PaymentStrategyFactory,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
