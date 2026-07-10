export type PaymentProviderName = 'STRIPE' | 'BKASH';

export interface InitiatePaymentContext {
  orderId: string;
  amount: number;
  payerReference?: string;
}

export interface PaymentInitiationResult {
  transactionId: string;
  /** Where the client should redirect/present UI to complete payment
   * (bKash's hosted checkout URL; Stripe instead uses clientSecret). */
  redirectUrl?: string;
  /** Stripe-specific: the client_secret Stripe.js needs to confirm the
   * PaymentIntent from the frontend. */
  clientSecret?: string;
  rawResponse: unknown;
}

export interface PaymentConfirmationResult {
  transactionId: string;
  success: boolean;
  rawResponse: unknown;
}

/**
 * Strategy interface (the assignment's explicit design-pattern requirement).
 * PaymentsService is written entirely against this interface — it never
 * imports the Stripe SDK or bKash's HTTP client directly. Adding a third
 * provider later means writing one new class that implements this and
 * registering it in PaymentStrategyFactory; PaymentsService and the order
 * flow logic don't change at all.
 */
export interface PaymentStrategy {
  readonly provider: PaymentProviderName;

  /** Starts a payment for an order. Returns whatever the client needs to
   * complete it (a redirect URL, a client secret, etc). */
  initiate(context: InitiatePaymentContext): Promise<PaymentInitiationResult>;

  /** Explicitly confirms/executes a payment server-side, given whatever
   * identifiers the provider's flow hands back (e.g. bKash's paymentID
   * after the user approves on bKash's page). */
  confirm(payload: Record<string, unknown>): Promise<PaymentConfirmationResult>;
}
