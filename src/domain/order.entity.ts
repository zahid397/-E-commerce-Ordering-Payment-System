export class InvalidOrderStateTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Cannot transition order from ${from} to ${to}`);
    this.name = 'InvalidOrderStateTransitionError';
  }
}

export type OrderStatusValue = 'PENDING' | 'PAID' | 'CANCELED';

export interface OrderLineItemProps {
  productId: string;
  sku: string;
  quantity: number;
  unitPrice: number;
}

/**
 * A single line within an Order. `subtotal` is derived, not stored input —
 * this is the deterministic algorithm the assignment asks for: given the
 * same quantity and unit price, it always produces the same result, with no
 * hidden state or side effects.
 */
export class OrderLineItem {
  readonly productId: string;
  readonly sku: string;
  readonly quantity: number;
  readonly unitPrice: number;

  constructor(props: OrderLineItemProps) {
    if (props.quantity <= 0) {
      throw new Error(`Quantity for ${props.sku} must be positive`);
    }
    if (props.unitPrice < 0) {
      throw new Error(`Unit price for ${props.sku} cannot be negative`);
    }
    this.productId = props.productId;
    this.sku = props.sku;
    this.quantity = props.quantity;
    this.unitPrice = props.unitPrice;
  }

  /** Deterministic: quantity × unit price, rounded to 2 decimal places to
   * avoid floating-point drift across many lines. */
  subtotal(): number {
    return Math.round(this.quantity * this.unitPrice * 100) / 100;
  }
}

// Only these transitions are legal. Anything not listed here — including
// re-entering the same state — is rejected. This is the whole "algorithm":
// a lookup table, not scattered if/else checks throughout the codebase.
const ALLOWED_TRANSITIONS: Record<OrderStatusValue, OrderStatusValue[]> = {
  PENDING: ['PAID', 'CANCELED'],
  PAID: [],
  CANCELED: [],
};

/**
 * Domain entity for Order. Computes totals deterministically from its line
 * items and enforces that status can only move forward along the allowed
 * transitions (PENDING → PAID or PENDING → CANCELED; PAID and CANCELED are
 * both terminal) — so "reverse" bugs like re-paying a canceled order can't
 * happen no matter which service/controller path calls this.
 */
export class OrderEntity {
  readonly id: string;
  readonly userId: string;
  private _status: OrderStatusValue;
  private readonly _items: OrderLineItem[];

  constructor(id: string, userId: string, status: OrderStatusValue, items: OrderLineItem[]) {
    if (items.length === 0) {
      throw new Error('An order must contain at least one item');
    }
    this.id = id;
    this.userId = userId;
    this._status = status;
    this._items = items;
  }

  get status(): OrderStatusValue {
    return this._status;
  }

  get items(): readonly OrderLineItem[] {
    return this._items;
  }

  /** Deterministic: sum of every line's subtotal. Same items in, same total
   * out, every time — no reliance on stored/cached totals that could drift. */
  calculateTotal(): number {
    const total = this._items.reduce((sum, item) => sum + item.subtotal(), 0);
    return Math.round(total * 100) / 100;
  }

  private assertTransition(to: OrderStatusValue): void {
    const allowed = ALLOWED_TRANSITIONS[this._status];
    if (!allowed.includes(to)) {
      throw new InvalidOrderStateTransitionError(this._status, to);
    }
  }

  markPaid(): void {
    this.assertTransition('PAID');
    this._status = 'PAID';
  }

  markCanceled(): void {
    this.assertTransition('CANCELED');
    this._status = 'CANCELED';
  }

  isPending(): boolean {
    return this._status === 'PENDING';
  }
}
