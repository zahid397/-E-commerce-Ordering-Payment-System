import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { QueryProductDto } from './dto/query-product.dto';

/** Either the main Prisma client or a client scoped to an active
 * transaction — reduceStockSafely can be called standalone or composed into
 * a larger atomic operation (e.g. "mark payment successful AND reduce stock"
 * as a single all-or-nothing unit). */
type PrismaClientOrTx = PrismaService | Prisma.TransactionClient;

export class OutOfStockError extends ConflictException {
  constructor(productId: string) {
    super(`Product ${productId} does not have enough stock for this quantity`);
  }
}

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateProductDto) {
    const existing = await this.prisma.product.findUnique({ where: { sku: dto.sku } });
    if (existing) {
      throw new ConflictException('A product with this SKU already exists');
    }
    return this.prisma.product.create({ data: dto });
  }

  async update(id: string, dto: UpdateProductDto) {
    await this.findOneOrThrow(id);
    if (dto.sku) {
      const existing = await this.prisma.product.findUnique({ where: { sku: dto.sku } });
      if (existing && existing.id !== id) {
        throw new ConflictException('A product with this SKU already exists');
      }
    }
    return this.prisma.product.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    await this.findOneOrThrow(id);
    await this.prisma.product.delete({ where: { id } });
    return { message: 'Product deleted successfully' };
  }

  async findAll(query: QueryProductDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Prisma.ProductWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.categoryId) where.categoryId = query.categoryId;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { sku: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.product.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  async findOne(id: string) {
    return this.findOneOrThrow(id);
  }

  private async findOneOrThrow(id: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    return product;
  }

  /**
   * Safely (concurrency-safe) reduces stock by `quantity`.
   *
   * The naive approach — read current stock, check in application code,
   * then write the new value — has a classic race condition: two requests
   * can both read stock=1, both decide "there's enough for my order of 1",
   * and both write stock=0, selling the same last unit twice.
   *
   * The fix is to make the check and the decrement a single atomic
   * database operation: `UPDATE ... WHERE stock >= quantity`. Postgres
   * evaluates the WHERE clause and applies the write as one indivisible
   * step per row, under the row lock the UPDATE itself takes — a second
   * concurrent transaction attempting the same UPDATE simply blocks until
   * the first commits, then re-evaluates WHERE against the now-updated
   * stock and correctly fails if there isn't enough left. No read-then-write
   * gap exists for a race to land in.
   *
   * `updateMany`'s `count` tells us whether a row actually matched and was
   * updated — if 0, either the product doesn't exist or stock was too low,
   * so we throw either way (the caller already validated existence earlier
   * in the normal order-creation path; a 0 here at payment-success time
   * means stock changed between order creation and payment, which is
   * exactly the scenario this method exists to catch safely).
   */
  async reduceStockSafely(
    productId: string,
    quantity: number,
    client: PrismaClientOrTx = this.prisma,
  ): Promise<void> {
    if (quantity <= 0) {
      throw new Error('Quantity to reduce must be positive');
    }
    const result = await client.product.updateMany({
      where: { id: productId, stock: { gte: quantity } },
      data: { stock: { decrement: quantity } },
    });
    if (result.count === 0) {
      throw new OutOfStockError(productId);
    }
  }
}
