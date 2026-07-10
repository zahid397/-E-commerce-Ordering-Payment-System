export class InvalidPaymentStateTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Cannot transition payment from ${from} to ${to}`);
    this.name = 'InvalidPaymentStateTransitionError';
  }
}

export type PaymentStatusValue = 'PENDING' | 'SUCCESS' | 'FAILED';
export type PaymentProviderValue = 'STRIPE' | 'BKASH';

const ALLOWED_TRANSITIONS: Record<PaymentStatusValue, PaymentStatusValue[]> = {
  PENDING: ['SUCCESS', 'FAILED'],
  SUCCESS: [],
  FAILED: [],
};

export interface PaymentProps {
  id: string;
  orderId: string;
  provider: PaymentProviderValue;
  transactionId: string;
  status: PaymentStatusValue;
  rawResponse?: unknown;
}

/**
 * Domain entity for Payment. Both SUCCESS and FAILED are terminal — a
 * payment that already succeeded or failed can't be silently overwritten by
 * a late/duplicate webhook delivery re-processing the same transaction,
 * which is a real, common payment-integration bug class (providers do retry
 * webhook delivery).
 */
export class PaymentEntity {
  readonly id: string;
  readonly orderId: string;
  readonly provider: PaymentProviderValue;
  readonly transactionId: string;
  private _status: PaymentStatusValue;
  private _rawResponse: unknown;

  constructor(props: PaymentProps) {
    this.id = props.id;
    this.orderId = props.orderId;
    this.provider = props.provider;
    this.transactionId = props.transactionId;
    this._status = props.status;
    this._rawResponse = props.rawResponse ?? null;
  }

  get status(): PaymentStatusValue {
    return this._status;
  }

  get rawResponse(): unknown {
    return this._rawResponse;
  }

  isTerminal(): boolean {
    return this._status !== 'PENDING';
  }

  private assertTransition(to: PaymentStatusValue): void {
    const allowed = ALLOWED_TRANSITIONS[this._status];
    if (!allowed.includes(to)) {
      throw new InvalidPaymentStateTransitionError(this._status, to);
    }
  }

  markSuccess(rawResponse: unknown): void {
    this.assertTransition('SUCCESS');
    this._status = 'SUCCESS';
    this._rawResponse = rawResponse;
  }

  markFailed(rawResponse: unknown): void {
    this.assertTransition('FAILED');
    this._status = 'FAILED';
    this._rawResponse = rawResponse;
  }
}
