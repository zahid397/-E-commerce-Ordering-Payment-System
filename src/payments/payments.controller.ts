import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../common/types/jwt-payload.interface';
import { PaymentsService } from './payments.service';
import { InitiatePaymentDto } from './dto/initiate-payment.dto';

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: "List the caller's own payments" })
  listMine(@CurrentUser() user: AuthenticatedUser) {
    return this.paymentsService.listForUser(user.userId);
  }

  @Post(':orderId/initiate')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Start a payment for an order via Stripe or bKash' })
  initiate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId') orderId: string,
    @Body() dto: InitiatePaymentDto,
  ) {
    return this.paymentsService.initiatePayment(user.userId, orderId, dto.provider);
  }

  @Post(':orderId/confirm')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Explicitly confirm a payment server-side (in addition to the webhook/callback)',
  })
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId') orderId: string,
    @Body() body: { provider: 'stripe' | 'bkash'; [key: string]: unknown },
  ) {
    const { provider, ...payload } = body;
    return this.paymentsService.confirmPayment(user.userId, orderId, provider, payload);
  }

  /**
   * Stripe requires the *raw*, unparsed request body to verify the webhook
   * signature — main.ts enables `rawBody: true` so `req.rawBody` is
   * available here even though Nest's global body parser has already run
   * for every other route.
   */
  @Post('stripe/webhook')
  @ApiOperation({ summary: 'Stripe webhook — verifies signature, finalizes the payment' })
  handleStripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!req.rawBody) {
      throw new BadRequestException('Missing raw request body for Stripe signature verification');
    }
    return this.paymentsService.handleStripeWebhook(req.rawBody, signature);
  }

  /**
   * bKash redirects the user's browser here after they approve/cancel on
   * bKash's hosted checkout page (not an async server push like Stripe's
   * webhook — see PaymentsService.handleBkashCallback for the distinction).
   */
  @Get('bkash/callback')
  @ApiOperation({ summary: 'bKash redirect callback — executes and finalizes the payment' })
  handleBkashCallback(@Query('paymentID') paymentId: string, @Query('status') status: string) {
    return this.paymentsService.handleBkashCallback(paymentId, status);
  }
}
