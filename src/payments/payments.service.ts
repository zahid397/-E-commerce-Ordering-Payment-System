import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from '../products/products.service';
import { PaymentStrategyFactory } from './strategies/payment-strategy.factory';
import { StripePaymentStrategy } from './strategies/stripe.strategy';
import { BkashPaymentStrategy } from './strategies/bkash.strategy';
import { PaymentEntity } from '../domain/payment.entity';
import { OrderEntity, OrderLineItem } from '../domain/order.entity';

/**
 * Converts unknown provider responses into values accepted by
 * Prisma JSON fields.
 *
 * JSON.stringify also removes unsupported nested values such as undefined.
 * Top-level null/undefined uses Prisma.JsonNull.
 */
function toPrismaJson(value: unknown) {
  if (value === null || value === undefined) {
    return Prisma.JsonNull;
  }

  const serialized = JSON.stringify(value);

  if (serialized === undefined) {
    return Prisma.JsonNull;
  }

  return JSON.parse(serialized) as Prisma.InputJsonValue;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly strategyFactory: PaymentStrategyFactory,
    private readonly productsService: ProductsService,

    // Injected directly because webhook verification and bKash status
    // confirmation are provider-specific capabilities.
    private readonly stripeStrategy: StripePaymentStrategy,
    private readonly bkashStrategy: BkashPaymentStrategy,
  ) {}

  async initiatePayment(
    userId: string,
    orderId: string,
    providerInput: 'stripe' | 'bkash',
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (order.userId !== userId) {
      throw new ForbiddenException('You do not have access to this order');
    }

    if (order.status !== 'PENDING') {
      throw new BadRequestException(
        `Order is ${order.status.toLowerCase()} and cannot be paid again`,
      );
    }

    const provider = providerInput.toUpperCase() as 'STRIPE' | 'BKASH';
    const strategy = this.strategyFactory.getStrategy(provider);

    const initiation = await strategy.initiate({
      orderId: order.id,
      amount: Number(order.totalAmount),
    });

    const payment = await this.prisma.payment.create({
      data: {
        orderId: order.id,
        provider,
        transactionId: initiation.transactionId,
        status: 'PENDING',
        rawResponse: toPrismaJson(initiation.rawResponse),
      },
    });

    return {
      paymentId: payment.id,
      provider,
      transactionId: initiation.transactionId,
      redirectUrl: initiation.redirectUrl,
      clientSecret: initiation.clientSecret,
    };
  }

  /**
   * Explicit payment confirmation endpoint.
   *
   * Stripe can confirm through a webhook or this explicit endpoint.
   * bKash confirms through callback + Execute Payment.
   */
  async confirmPayment(
    userId: string,
    orderId: string,
    provider: 'stripe' | 'bkash',
    payload: Record<string, unknown>,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order || order.userId !== userId) {
      throw new NotFoundException('Order not found');
    }

    const strategy = this.strategyFactory.getStrategy(
      provider.toUpperCase(),
    );

    const result = await strategy.confirm(payload);

    return this.finalizePayment(
      result.transactionId,
      result.success,
      result.rawResponse,
    );
  }

  async handleStripeWebhook(rawBody: Buffer, signature: string) {
    const event = this.stripeStrategy.verifyAndParseEvent(
      rawBody,
      signature,
    );

    if (
      event.type === 'payment_intent.succeeded' ||
      event.type === 'payment_intent.payment_failed'
    ) {
      const paymentIntent = event.data.object as { id: string };
      const success = event.type === 'payment_intent.succeeded';

      return this.finalizePayment(
        paymentIntent.id,
        success,
        event,
      );
    }

    this.logger.log(
      `Ignoring unhandled Stripe event type: ${event.type}`,
    );

    return {
      ignored: true,
      eventType: event.type,
    };
  }

  /**
   * bKash redirects the user to the callback URL.
   * The backend then executes the payment server-side.
   */
  async handleBkashCallback(paymentId: string, status: string) {
    if (status !== 'success') {
      return this.finalizePayment(paymentId, false, {
        paymentID: paymentId,
        status,
      });
    }

    const result = await this.bkashStrategy.confirm({
      paymentID: paymentId,
    });

    return this.finalizePayment(
      result.transactionId,
      result.success,
      result.rawResponse,
    );
  }

  async listForUser(userId: string) {
    return this.prisma.payment.findMany({
      where: {
        order: {
          userId,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        order: true,
      },
    });
  }

  /**
   * Applies a provider confirmation to the payment and order.
   *
   * Both Stripe and bKash use this method so payment finalization,
   * order status updates and stock reduction remain centralized.
   */
  async finalizePayment(
    transactionId: string,
    success: boolean,
    rawResponse: unknown,
  ) {
    const paymentRow = await this.prisma.payment.findUnique({
      where: {
        transactionId,
      },
      include: {
        order: {
          include: {
            items: true,
          },
        },
      },
    });

    if (!paymentRow) {
      this.logger.warn(
        `Received confirmation for unknown transaction ${transactionId}`,
      );

      throw new NotFoundException(
        `No payment found for transaction ${transactionId}`,
      );
    }

    const paymentEntity = new PaymentEntity({
      id: paymentRow.id,
      orderId: paymentRow.orderId,
      provider: paymentRow.provider,
      transactionId: paymentRow.transactionId,
      status: paymentRow.status,
      rawResponse: paymentRow.rawResponse,
    });

    if (paymentEntity.isTerminal()) {
      this.logger.log(
        `Transaction ${transactionId} already finalized as ` +
          `${paymentEntity.status} — ignoring duplicate`,
      );

      return {
        alreadyProcessed: true,
        paymentId: paymentRow.id,
        status: paymentEntity.status,
      };
    }

    if (success) {
      paymentEntity.markSuccess(rawResponse);
    } else {
      paymentEntity.markFailed(rawResponse);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: {
          id: paymentRow.id,
        },
        data: {
          status: paymentEntity.status,
          rawResponse: toPrismaJson(rawResponse),
        },
      });

      if (!success) {
        return;
      }

      const orderEntity = new OrderEntity(
        paymentRow.order.id,
        paymentRow.order.userId,
        paymentRow.order.status,
        paymentRow.order.items.map(
          (item) =>
            new OrderLineItem({
              productId: item.productId,
              sku: item.productId,
              quantity: item.quantity,
              unitPrice: Number(item.price),
            }),
        ),
      );

      orderEntity.markPaid();

      await tx.order.update({
        where: {
          id: paymentRow.order.id,
        },
        data: {
          status: 'PAID',
        },
      });

      for (const item of paymentRow.order.items) {
        await this.productsService.reduceStockSafely(
          item.productId,
          item.quantity,
          tx,
        );
      }
    });

    return {
      alreadyProcessed: false,
      paymentId: paymentRow.id,
      status: paymentEntity.status,
    };
  }
}