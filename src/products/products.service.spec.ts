import { Test } from '@nestjs/testing';
import { OutOfStockError, ProductsService } from './products.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ProductsService.reduceStockSafely', () => {
  let service: ProductsService;
  let prisma: { product: Record<string, jest.Mock> };

  beforeEach(async () => {
    prisma = {
      product: {
        updateMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [ProductsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(ProductsService);
  });

  it('succeeds silently when the conditional update affects a row (enough stock existed)', async () => {
    prisma.product.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.reduceStockSafely('p1', 3)).resolves.toBeUndefined();

    // The critical assertion: the WHERE clause includes the stock check —
    // the check and the write are the SAME statement, not two separate steps.
    expect(prisma.product.updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', stock: { gte: 3 } },
      data: { stock: { decrement: 3 } },
    });
  });

  it('throws OutOfStockError when the conditional update affects zero rows', async () => {
    // count: 0 means "no row currently has stock >= quantity" — this is how
    // a losing request in a race (or genuinely insufficient stock) is
    // distinguished from a successful one, using only the DB's own atomic
    // decision, never a separate application-level read.
    prisma.product.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.reduceStockSafely('p1', 999)).rejects.toThrow(OutOfStockError);
  });

  it('rejects a non-positive quantity before ever touching the database', async () => {
    await expect(service.reduceStockSafely('p1', 0)).rejects.toThrow();
    await expect(service.reduceStockSafely('p1', -5)).rejects.toThrow();
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
  });

  it('uses a provided transaction client instead of the default connection when given one', async () => {
    const txClient = { product: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };

    await service.reduceStockSafely('p1', 2, txClient as never);

    expect(txClient.product.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
  });

  it('simulates two concurrent buyers racing for the last unit — only one can win', async () => {
    // First call "sees" stock still sufficient (count 1); second call, run
    // against the same (now-decremented) row, correctly sees insufficient
    // stock (count 0). This is what the atomic WHERE clause guarantees in
    // real Postgres — this mock just asserts our code correctly reacts to
    // that outcome shape rather than trusting a stale in-memory read.
    prisma.product.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const results = await Promise.allSettled([
      service.reduceStockSafely('last-unit', 1),
      service.reduceStockSafely('last-unit', 1),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});
