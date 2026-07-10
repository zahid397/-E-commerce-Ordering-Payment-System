import { InactiveProductError, InsufficientStockError, ProductEntity } from './product.entity';

function makeProduct(overrides: Partial<{ stock: number; status: 'ACTIVE' | 'INACTIVE' }> = {}) {
  return new ProductEntity({
    id: 'p1',
    sku: 'SKU-1',
    name: 'Widget',
    price: 19.99,
    stock: overrides.stock ?? 10,
    status: overrides.status ?? 'ACTIVE',
  });
}

describe('ProductEntity', () => {
  it('reports sufficient stock correctly', () => {
    const product = makeProduct({ stock: 5 });
    expect(product.hasSufficientStock(5)).toBe(true);
    expect(product.hasSufficientStock(6)).toBe(false);
  });

  it('reduces stock in place', () => {
    const product = makeProduct({ stock: 10 });
    product.reduceStock(3);
    expect(product.stock).toBe(7);
  });

  it('never allows stock to go negative', () => {
    const product = makeProduct({ stock: 2 });
    expect(() => product.reduceStock(3)).toThrow(InsufficientStockError);
    expect(product.stock).toBe(2); // unchanged after the failed attempt
  });

  it('rejects reducing by a non-positive quantity', () => {
    const product = makeProduct({ stock: 5 });
    expect(() => product.reduceStock(0)).toThrow();
    expect(() => product.reduceStock(-1)).toThrow();
  });

  it('assertOrderable throws for inactive products regardless of stock', () => {
    const product = makeProduct({ stock: 100, status: 'INACTIVE' });
    expect(() => product.assertOrderable(1)).toThrow(InactiveProductError);
  });

  it('assertOrderable throws for insufficient stock on active products', () => {
    const product = makeProduct({ stock: 1, status: 'ACTIVE' });
    expect(() => product.assertOrderable(2)).toThrow(InsufficientStockError);
    expect(() => product.assertOrderable(1)).not.toThrow();
  });

  it('fromPersistence converts a Prisma Decimal-like price correctly', () => {
    const product = ProductEntity.fromPersistence({
      id: 'p2',
      sku: 'SKU-2',
      name: 'Gadget',
      price: { toNumber: () => 42.5 },
      stock: 3,
      status: 'ACTIVE',
    });
    expect(product.price).toBe(42.5);
  });

  it('fromPersistence handles a plain numeric/string price too', () => {
    expect(
      ProductEntity.fromPersistence({
        id: 'p3',
        sku: 'SKU-3',
        name: 'Thing',
        price: '9.5',
        stock: 1,
        status: 'ACTIVE',
      }).price,
    ).toBe(9.5);
  });
});
