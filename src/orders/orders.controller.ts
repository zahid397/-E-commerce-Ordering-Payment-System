import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/jwt-payload.interface';
import { UserEntity } from '../domain/user.entity';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';

@ApiTags('Orders')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  @ApiOperation({ summary: 'Create an order from a list of product/quantity pairs' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOrderDto) {
    return this.ordersService.create(user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List the caller's own orders (all orders, if admin)" })
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return user.role === 'ADMIN'
      ? this.ordersService.findAllAdmin()
      : this.ordersService.findAllForUser(user.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single order (owner or admin only)' })
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    const requester = new UserEntity({ id: user.userId, email: user.email, role: user.role });
    return this.ordersService.findOne(requester, id);
  }
}
