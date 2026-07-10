export class InsufficientStockError extends Error {
  constructor(sku: string, requested: number, available: number) {
    super(`Insufficient stock for product ${sku}: requested ${requested}, available ${available}`);
    this.name = 'InsufficientStockError';
  }
}

export class InactiveProductError extends Error {
  constructor(sku: string) {
    super(`Product ${sku} is not active and cannot be ordered`);
    this.name = 'InactiveProductError';
  }
}

export interface ProductProps {
  id: string;
  sku: string;
  name: string;
  price: number;
  stock: number;
  status: 'ACTIVE' | 'INACTIVE';
}

/**
 * Domain entity for Product. Owns the business rules around stock and
 * availability so they live in exactly one place, independent of how the
 * data is persisted (Prisma) or exposed (REST DTOs).
 *
 * Note on concurrency: `reduceStock` here enforces the invariant in-memory
 * (never let stock go negative) for a single instance, but the actual
 * concurrency-safe guarantee — several simultaneous orders can't oversell
 * the same last unit — comes from the persistence layer's atomic
 * conditional update (see ProductsService.reduceStockSafely), which performs
 * the check-and-decrement as one indivisible SQL statement rather than a
 * read-then-write from application code. This class is the single source of
 * truth for *what* the rule is; the service is responsible for applying it
 * *atomically*.
 */
export class ProductEntity {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly price: number;
  private _stock: number;
  private _status: 'ACTIVE' | 'INACTIVE';

  constructor(props: ProductProps) {
    this.id = props.id;
    this.sku = props.sku;
    this.name = props.name;
    this.price = props.price;
    this._stock = props.stock;
    this._status = props.status;
  }

  get stock(): number {
    return this._stock;
  }

  get status(): 'ACTIVE' | 'INACTIVE' {
    return this._status;
  }

  isActive(): boolean {
    return this._status === 'ACTIVE';
  }

  hasSufficientStock(quantity: number): boolean {
    return this._stock >= quantity;
  }

  /** Throws if the product can't fulfil `quantity` right now. Used to
   * validate an order line before it's placed. */
  assertOrderable(quantity: number): void {
    if (!this.isActive()) {
      throw new InactiveProductError(this.sku);
    }
    if (!this.hasSufficientStock(quantity)) {
      throw new InsufficientStockError(this.sku, quantity, this._stock);
    }
  }

  /** In-memory stock reduction — see the concurrency note on the class. */
  reduceStock(quantity: number): void {
    if (quantity <= 0) {
      throw new Error('Quantity to reduce must be positive');
    }
    if (!this.hasSufficientStock(quantity)) {
      throw new InsufficientStockError(this.sku, quantity, this._stock);
    }
    this._stock -= quantity;
  }

  static fromPersistence(row: {
    id: string;
    sku: string;
    name: string;
    price: number | string | { toNumber(): number };
    stock: number;
    status: string;
  }): ProductEntity {
    const price =
      typeof row.price === 'object' && row.price !== null && 'toNumber' in row.price
        ? row.price.toNumber()
        : Number(row.price);
    return new ProductEntity({
      id: row.id,
      sku: row.sku,
      name: row.name,
      price,
      stock: row.stock,
      status: row.status as 'ACTIVE' | 'INACTIVE',
    });
  }
}
