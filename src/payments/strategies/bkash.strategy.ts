import { Injectable } from '@nestjs/common';
import { BkashHttpClient } from './bkash-http.client';
import {
  InitiatePaymentContext,
  PaymentConfirmationResult,
  PaymentInitiationResult,
  PaymentStrategy,
} from './payment-strategy.interface';

@Injectable()
export class BkashPaymentStrategy implements PaymentStrategy {
  readonly provider = 'BKASH' as const;

  constructor(private readonly bkashClient: BkashHttpClient) {}

  async initiate(context: InitiatePaymentContext): Promise<PaymentInitiationResult> {
    const response = await this.bkashClient.createPayment({
      amount: context.amount,
      merchantInvoiceNumber: context.orderId,
      payerReference: context.payerReference,
    });

    return {
      transactionId: response.paymentID,
      redirectUrl: response.bkashURL,
      rawResponse: response,
    };
  }

  /** bKash's flow: the user approves payment on bKash's hosted page, which
   * redirects back to our callback URL carrying the paymentID — at that
   * point we call Execute Payment server-side to actually finalize it.
   * This is the bKash equivalent of Stripe's webhook-driven confirmation,
   * just structured as callback-redirect + explicit execute rather than an
   * async server-to-server push. */
  async confirm(payload: Record<string, unknown>): Promise<PaymentConfirmationResult> {
    const paymentId = payload.paymentID as string;
    const response = await this.bkashClient.executePayment(paymentId);

    return {
      transactionId: response.paymentID,
      success: response.transactionStatus === 'Completed',
      rawResponse: response,
    };
  }

  /** Reconciliation helper — not part of the shared Strategy interface
   * (Stripe has no equivalent single-transaction query call worth
   * standardizing on), but useful directly from PaymentsService for bKash
   * specifically. */
  async queryStatus(paymentId: string) {
    return this.bkashClient.queryPayment(paymentId);
  }
}
