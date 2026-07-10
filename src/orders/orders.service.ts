import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderEntity, OrderLineItem } from '../domain/order.entity';
import { ProductEntity } from '../domain/product.entity';
import { UserEntity } from '../domain/user.entity';

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates an order. Per the spec's order flow, stock is validated here
   * (so a customer can't order more than exists) but only actually
   * decremented later, when a payment succeeds (see PaymentsService) —
   * this method never mutates product stock itself.
   *
   * Trade-off worth documenting explicitly: this means stock is *checked*
   * at order time but not *reserved*, so several PENDING orders can each
   * pass this check against the same limited stock, and only as many of
   * them as stock allows will actually succeed at payment time (the later
   * ones will hit OutOfStockError from reduceStockSafely and should show
   * the customer a clear "no longer available" message). A stricter design
   * would place a short-lived hold on stock at order creation; that's a
   * reasonable enhancement for a checkout with a real payment redirect
   * step, and is called out in the README as a future improvement rather
   * than implemented here, to match the spec's stated flow exactly.
   */
  async create(userId: string, dto: CreateOrderDto) {
    const productIds = dto.items.map((item) => item.productId);
    const products = await this.prisma.product.findMany({ where: { id: { in: productIds } } });

    const productById = new Map(products.map((product) => [product.id, product]));
    const lineItems: OrderLineItem[] = [];

    for (const requestedItem of dto.items) {
      const productRow = productById.get(requestedItem.productId);
      if (!productRow) {
        throw new BadRequestException(`Product ${requestedItem.productId} does not exist`);
      }

      const product = ProductEntity.fromPersistence(productRow);
      // Throws InactiveProductError / InsufficientStockError (both 4xx-safe
      // messages) if this line can't be fulfilled right now.
      product.assertOrderable(requestedItem.quantity);

      lineItems.push(
        new OrderLineItem({
          productId: product.id,
          sku: product.sku,
          quantity: requestedItem.quantity,
          unitPrice: product.price,
        }),
      );
    }

    // A throwaway OrderEntity purely to get the deterministic total — the
    // real entity (with a real id/status) is reconstructed after persistence.
    const totalAmount = new OrderEntity('draft', userId, 'PENDING', lineItems).calculateTotal();

    const order = await this.prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          userId,
          totalAmount,
          status: 'PENDING',
          items: {
            create: lineItems.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              price: item.unitPrice,
              subtotal: item.subtotal(),
            })),
          },
        },
        include: { items: { include: { product: true } } },
      });
      return created;
    });

    return order;
  }

  async findAllForUser(userId: string) {
    return this.prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { items: true, payments: true },
    });
  }

  async findAllAdmin() {
    return this.prisma.order.findMany({
      orderBy: { createdAt: 'desc' },
      include: { items: true, payments: true, user: true },
    });
  }

  async findOne(requester: UserEntity, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { include: { product: true } }, payments: true },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (!requester.canAccessOrder(order.userId)) {
      throw new ForbiddenException('You do not have access to this order');
    }
    return order;
  }
}
