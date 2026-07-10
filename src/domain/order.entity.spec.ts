import { InvalidOrderStateTransitionError, OrderEntity, OrderLineItem } from './order.entity';

function makeOrder(status: 'PENDING' | 'PAID' | 'CANCELED' = 'PENDING') {
  const items = [
    new OrderLineItem({ productId: 'p1', sku: 'SKU-1', quantity: 2, unitPrice: 10 }),
    new OrderLineItem({ productId: 'p2', sku: 'SKU-2', quantity: 1, unitPrice: 5.5 }),
  ];
  return new OrderEntity('o1', 'u1', status, items);
}

describe('OrderLineItem', () => {
  it('computes a deterministic subtotal', () => {
    const item = new OrderLineItem({ productId: 'p1', sku: 'SKU-1', quantity: 3, unitPrice: 4.25 });
    expect(item.subtotal()).toBe(12.75);
    // calling it again gives the exact same result — no hidden state
    expect(item.subtotal()).toBe(12.75);
  });

  it('rejects non-positive quantity', () => {
    expect(
      () => new OrderLineItem({ productId: 'p1', sku: 'SKU-1', quantity: 0, unitPrice: 1 }),
    ).toThrow();
  });

  it('rejects negative unit price', () => {
    expect(
      () => new OrderLineItem({ productId: 'p1', sku: 'SKU-1', quantity: 1, unitPrice: -1 }),
    ).toThrow();
  });

  it('avoids floating point drift by rounding to 2dp', () => {
    const item = new OrderLineItem({ productId: 'p1', sku: 'SKU-1', quantity: 3, unitPrice: 0.1 });
    // naive 3 * 0.1 in IEEE754 is 0.30000000000000004
    expect(item.subtotal()).toBe(0.3);
  });
});

describe('OrderEntity', () => {
  it('requires at least one item', () => {
    expect(() => new OrderEntity('o1', 'u1', 'PENDING', [])).toThrow();
  });

  it('calculates total deterministically as the sum of line subtotals', () => {
    const order = makeOrder();
    // 2 * 10 + 1 * 5.5 = 25.5
    expect(order.calculateTotal()).toBe(25.5);
    expect(order.calculateTotal()).toBe(25.5); // stable across repeated calls
  });

  it('allows PENDING -> PAID', () => {
    const order = makeOrder('PENDING');
    order.markPaid();
    expect(order.status).toBe('PAID');
  });

  it('allows PENDING -> CANCELED', () => {
    const order = makeOrder('PENDING');
    order.markCanceled();
    expect(order.status).toBe('CANCELED');
  });

  it('rejects PAID -> CANCELED (paid orders cannot be canceled)', () => {
    const order = makeOrder('PAID');
    expect(() => order.markCanceled()).toThrow(InvalidOrderStateTransitionError);
  });

  it('rejects CANCELED -> PAID (a canceled order cannot later be paid)', () => {
    const order = makeOrder('CANCELED');
    expect(() => order.markPaid()).toThrow(InvalidOrderStateTransitionError);
  });

  it('rejects re-entering the same terminal state', () => {
    const order = makeOrder('PAID');
    expect(() => order.markPaid()).toThrow(InvalidOrderStateTransitionError);
  });

  it('isPending reflects current status', () => {
    expect(makeOrder('PENDING').isPending()).toBe(true);
    expect(makeOrder('PAID').isPending()).toBe(false);
  });
});
