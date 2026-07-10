import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { PrismaService } from '../prisma/prisma.service';

function productRow(
  overrides: Partial<{ id: string; price: number; stock: number; status: string }> = {},
) {
  return {
    id: overrides.id ?? 'p1',
    sku: `SKU-${overrides.id ?? 'p1'}`,
    name: 'Test Product',
    price: overrides.price ?? 10,
    stock: overrides.stock ?? 10,
    status: overrides.status ?? 'ACTIVE',
    categoryId: null,
  };
}

describe('OrdersService.create', () => {
  let service: OrdersService;
  let prisma: {
    product: Record<string, jest.Mock>;
    order: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      product: { findMany: jest.fn() },
      order: { create: jest.fn() },
      $transaction: jest.fn(),
    };
    // $transaction just invokes the callback with a tx object that reuses
    // the same mocked delegates — enough to exercise the code path without
    // a real database.
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));

    const moduleRef = await Test.createTestingModule({
      providers: [OrdersService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(OrdersService);
  });

  it('creates an order with the deterministically-calculated total', async () => {
    prisma.product.findMany.mockResolvedValue([
      productRow({ id: 'p1', price: 10, stock: 5 }),
      productRow({ id: 'p2', price: 4.5, stock: 5 }),
    ]);
    prisma.order.create.mockImplementation(({ data }) => ({
      id: 'order1',
      ...data,
      items: data.items.create,
    }));

    const result = (await service.create('user1', {
      items: [
        { productId: 'p1', quantity: 2 },
        { productId: 'p2', quantity: 3 },
      ],
    })) as unknown as { totalAmount: number };

    // 2*10 + 3*4.5 = 33.5
    expect(result.totalAmount).toBe(33.5);
  });

  it('rejects an order referencing a product that does not exist', async () => {
    prisma.product.findMany.mockResolvedValue([]); // none found

    await expect(
      service.create('user1', { items: [{ productId: 'missing', quantity: 1 }] }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects an order line for an inactive product', async () => {
    prisma.product.findMany.mockResolvedValue([productRow({ status: 'INACTIVE' })]);

    await expect(
      service.create('user1', { items: [{ productId: 'p1', quantity: 1 }] }),
    ).rejects.toThrow();
  });

  it('rejects an order line that exceeds available stock', async () => {
    prisma.product.findMany.mockResolvedValue([productRow({ stock: 1 })]);

    await expect(
      service.create('user1', { items: [{ productId: 'p1', quantity: 2 }] }),
    ).rejects.toThrow();
  });

  it('never calls any stock-mutating method — stock is only reduced at payment success', async () => {
    prisma.product.findMany.mockResolvedValue([productRow({ stock: 5 })]);
    prisma.order.create.mockResolvedValue({ id: 'order1', totalAmount: 10 });

    await service.create('user1', { items: [{ productId: 'p1', quantity: 1 }] });

    expect(prisma.product.updateMany).toBeUndefined(); // never even referenced
  });
});
