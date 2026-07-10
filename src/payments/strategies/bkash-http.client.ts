import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { RedisService } from '../../redis/redis.service';

const ID_TOKEN_CACHE_KEY = 'bkash:id_token';
// bKash's id_token is valid for 1 hour; refresh a bit early so a
// request never straddles the exact expiry instant.
const ID_TOKEN_CACHE_TTL_SECONDS = 50 * 60;

export interface BkashCreatePaymentResponse {
  paymentID: string;
  bkashURL: string;
  transactionStatus: string;
  amount: string;
  currency: string;
  merchantInvoiceNumber: string;
}

export interface BkashExecutePaymentResponse {
  paymentID: string;
  trxID?: string;
  transactionStatus: string;
  amount: string;
  currency: string;
  statusCode?: string;
  statusMessage?: string;
}

@Injectable()
export class BkashHttpClient {
  private readonly logger = new Logger(BkashHttpClient.name);
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly appKey: string;
  private readonly appSecret: string;
  private readonly callbackUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly redis: RedisService,
  ) {
    this.baseUrl = this.configService.get<string>('BKASH_BASE_URL') ?? '';
    this.username = this.configService.get<string>('BKASH_USERNAME') ?? '';
    this.password = this.configService.get<string>('BKASH_PASSWORD') ?? '';
    this.appKey = this.configService.get<string>('BKASH_APP_KEY') ?? '';
    this.appSecret = this.configService.get<string>('BKASH_APP_SECRET') ?? '';
    this.callbackUrl = this.configService.get<string>('BKASH_CALLBACK_URL') ?? '';
  }

  private async getIdToken(): Promise<string> {
    const cached = await this.redis.get<string>(ID_TOKEN_CACHE_KEY);
    if (cached) {
      return cached;
    }

    try {
      const response = await axios.post(
        `${this.baseUrl}/tokenized/checkout/token/grant`,
        { app_key: this.appKey, app_secret: this.appSecret },
        {
          headers: {
            username: this.username,
            password: this.password,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: 15000,
        },
      );
      const idToken: string = response.data.id_token;
      await this.redis.set(ID_TOKEN_CACHE_KEY, idToken, ID_TOKEN_CACHE_TTL_SECONDS);
      return idToken;
    } catch (err) {
      this.logRequestError('grant token', err);
      throw new ServiceUnavailableException('Could not authenticate with bKash');
    }
  }

  private async authHeaders() {
    const idToken = await this.getIdToken();
    return {
      Authorization: idToken,
      'X-App-Key': this.appKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  async createPayment(params: {
    amount: number;
    merchantInvoiceNumber: string;
    payerReference?: string;
  }): Promise<BkashCreatePaymentResponse> {
    try {
      const headers = await this.authHeaders();
      const response = await axios.post(
        `${this.baseUrl}/tokenized/checkout/create`,
        {
          mode: '0011',
          payerReference: params.payerReference || ' ',
          callbackURL: this.callbackUrl,
          amount: params.amount.toFixed(2),
          currency: 'BDT',
          intent: 'sale',
          merchantInvoiceNumber: params.merchantInvoiceNumber,
        },
        { headers, timeout: 15000 },
      );
      return response.data;
    } catch (err) {
      this.logRequestError('create payment', err);
      throw new ServiceUnavailableException('Could not create bKash payment');
    }
  }

  /** Executes (finalizes) a payment server-side after the user has approved
   * it on bKash's hosted page and been redirected back to callbackURL. */
  async executePayment(paymentID: string): Promise<BkashExecutePaymentResponse> {
    try {
      const headers = await this.authHeaders();
      const response = await axios.post(
        `${this.baseUrl}/tokenized/checkout/execute`,
        { paymentID },
        { headers, timeout: 15000 },
      );
      return response.data;
    } catch (err) {
      this.logRequestError('execute payment', err);
      throw new ServiceUnavailableException('Could not execute bKash payment');
    }
  }

  /**
   * Checks the status of a previously-created payment — used for
   * reconciliation (e.g. a scheduled job double-checking any payment stuck
   * in PENDING). NOTE: bKash's own reference docs list this operation's
   * URL fragment as "...UsingGET" while at least one independent
   * integration write-up documents it as a POST with `{paymentID}` in the
   * body; this implementation follows the POST form since that source's
   * documentation was the more complete/explicit of the two. If your
   * bKash developer-portal account shows GET for this endpoint, switch the
   * method below accordingly — everything else in this client is
   * unaffected either way.
   */
  async queryPayment(paymentID: string): Promise<BkashExecutePaymentResponse> {
    try {
      const headers = await this.authHeaders();
      const response = await axios.post(
        `${this.baseUrl}/tokenized/checkout/payment/status`,
        { paymentID },
        { headers, timeout: 15000 },
      );
      return response.data;
    } catch (err) {
      this.logRequestError('query payment', err);
      throw new ServiceUnavailableException('Could not query bKash payment status');
    }
  }

  private logRequestError(action: string, err: unknown): void {
    if (err instanceof AxiosError) {
      this.logger.error(
        `bKash ${action} failed: ${err.response?.status} ${JSON.stringify(err.response?.data)}`,
      );
    } else {
      this.logger.error(`bKash ${action} failed: ${(err as Error).message}`);
    }
  }
}
