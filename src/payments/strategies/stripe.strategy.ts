import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import {
  InitiatePaymentContext,
  PaymentConfirmationResult,
  PaymentInitiationResult,
  PaymentStrategy,
} from './payment-strategy.interface';

@Injectable()
export class StripePaymentStrategy implements PaymentStrategy {
  readonly provider = 'STRIPE' as const;
  private readonly logger = new Logger(StripePaymentStrategy.name);
  private readonly client: Stripe;
  private readonly webhookSecret: string;

  constructor(private readonly configService: ConfigService) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY') ?? '';
    this.webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET') ?? '';
    // apiVersion pinned so Stripe's response shape can't shift under us
    // silently on a future account-level default-version change.
    this.client = new Stripe(secretKey, {
      apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion,
    });
  }

  async initiate(context: InitiatePaymentContext): Promise<PaymentInitiationResult> {
    // Stripe amounts are in the smallest currency unit (cents for USD).
    const amountInCents = Math.round(context.amount * 100);

    const paymentIntent = await this.client.paymentIntents.create({
      amount: amountInCents,
      currency: 'usd',
      metadata: { orderId: context.orderId },
      automatic_payment_methods: { enabled: true },
    });

    return {
      transactionId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret ?? undefined,
      rawResponse: paymentIntent,
    };
  }

  /** Explicit server-side confirm/status-check — retrieves the current
   * state of a PaymentIntent by id. The webhook (see verifyAndParseEvent)
   * remains the primary, authoritative confirmation path; this exists for
   * the assignment's explicit "Confirm payment" capability and for
   * reconciliation/polling use cases. */
  async confirm(payload: Record<string, unknown>): Promise<PaymentConfirmationResult> {
    const paymentIntentId = payload.paymentIntentId as string;
    const paymentIntent = await this.client.paymentIntents.retrieve(paymentIntentId);

    return {
      transactionId: paymentIntent.id,
      success: paymentIntent.status === 'succeeded',
      rawResponse: paymentIntent,
    };
  }

  /** Verifies the webhook signature and parses the event. Throws if the
   * signature doesn't match — callers must not process an event that fails
   * this check, since that would let anyone POST fake "payment succeeded"
   * events at the webhook URL. */
  verifyAndParseEvent(rawBody: Buffer, signature: string): Stripe.Event {
    return this.client.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }
}
