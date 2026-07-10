import { Test } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from '../products/products.service';
import { PaymentStrategyFactory } from './strategies/payment-strategy.factory';
import { StripePaymentStrategy } from './strategies/stripe.strategy';
import { BkashPaymentStrategy } from './strategies/bkash.strategy';

function paymentRow(overrides: Partial<{ status: string; orderStatus: string }> = {}) {
  return {
    id: 'pay1',
    orderId: 'order1',
    provider: 'STRIPE',
    transactionId: 'pi_123',
    status: overrides.status ?? 'PENDING',
    rawResponse: null,
    order: {
      id: 'order1',
      userId: 'user1',
      status: overrides.orderStatus ?? 'PENDING',
      totalAmount: 20,
      items: [{ productId: 'p1', quantity: 2, price: 10, subtotal: 20 }],
    },
  };
}

describe('PaymentsService', () => {
  let service: PaymentsService;
  let prisma: {
    order: Record<string, jest.Mock>;
    payment: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  let productsService: { reduceStockSafely: jest.Mock };
  let strategyFactory: { getStrategy: jest.Mock };

  beforeEach(async () => {
    prisma = {
      order: { findUnique: jest.fn(), update: jest.fn() },
      payment: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
    productsService = { reduceStockSafely: jest.fn().mockResolvedValue(undefined) };
    strategyFactory = { getStrategy: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ProductsService, useValue: productsService },
        { provide: PaymentStrategyFactory, useValue: strategyFactory },
        { provide: StripePaymentStrategy, useValue: {} },
        { provide: BkashPaymentStrategy, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(PaymentsService);
  });

  describe('initiatePayment', () => {
    it('rejects initiating payment for an order the caller does not own', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'o1',
        userId: 'someone-else',
        status: 'PENDING',
      });
      await expect(service.initiatePayment('user1', 'o1', 'stripe')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejects initiating payment for an order that is not PENDING', async () => {
      prisma.order.findUnique.mockResolvedValue({ id: 'o1', userId: 'user1', status: 'PAID' });
      await expect(service.initiatePayment('user1', 'o1', 'stripe')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects an order that does not exist', async () => {
      prisma.order.findUnique.mockResolvedValue(null);
      await expect(service.initiatePayment('user1', 'missing', 'stripe')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('creates a PENDING payment row using the strategy the caller chose', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'o1',
        userId: 'user1',
        status: 'PENDING',
        totalAmount: 20,
      });
      strategyFactory.getStrategy.mockReturnValue({
        initiate: jest
          .fn()
          .mockResolvedValue({ transactionId: 'pi_1', clientSecret: 'secret', rawResponse: {} }),
      });
      prisma.payment.create.mockResolvedValue({ id: 'pay1' });

      await service.initiatePayment('user1', 'o1', 'stripe');

      expect(strategyFactory.getStrategy).toHaveBeenCalledWith('STRIPE');
      expect(prisma.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'PENDING', provider: 'STRIPE' }),
        }),
      );
    });
  });

  describe('finalizePayment', () => {
    it('on success: marks the payment SUCCESS, the order PAID, and reduces stock for every line item', async () => {
      prisma.payment.findUnique.mockResolvedValue(paymentRow());

      const result = await service.finalizePayment('pi_123', true, { status: 'succeeded' });

      expect(result.alreadyProcessed).toBe(false);
      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'SUCCESS' }) }),
      );
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'order1' },
        data: { status: 'PAID' },
      });
      expect(productsService.reduceStockSafely).toHaveBeenCalledWith('p1', 2, prisma);
    });

    it('on failure: marks the payment FAILED and never touches the order or stock', async () => {
      prisma.payment.findUnique.mockResolvedValue(paymentRow());

      const result = await service.finalizePayment('pi_123', false, { status: 'failed' });

      expect(result.alreadyProcessed).toBe(false);
      expect(prisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
      );
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(productsService.reduceStockSafely).not.toHaveBeenCalled();
    });

    it('is idempotent: a duplicate SUCCESS webhook for an already-SUCCESS payment does not reprocess', async () => {
      prisma.payment.findUnique.mockResolvedValue(
        paymentRow({ status: 'SUCCESS', orderStatus: 'PAID' }),
      );

      const result = await service.finalizePayment('pi_123', true, {});

      expect(result.alreadyProcessed).toBe(true);
      expect(prisma.payment.update).not.toHaveBeenCalled();
      expect(prisma.order.update).not.toHaveBeenCalled();
      // The whole point: stock must NEVER be reduced twice for one payment.
      expect(productsService.reduceStockSafely).not.toHaveBeenCalled();
    });

    it('is idempotent for FAILED too: a late SUCCESS arriving after FAILED does not flip it', async () => {
      prisma.payment.findUnique.mockResolvedValue(paymentRow({ status: 'FAILED' }));

      const result = await service.finalizePayment('pi_123', true, {});

      expect(result.alreadyProcessed).toBe(true);
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for a transaction id with no matching payment', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);
      await expect(service.finalizePayment('unknown_txn', true, {})).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
