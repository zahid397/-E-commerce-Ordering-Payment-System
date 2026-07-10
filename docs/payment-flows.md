# Payment Flow Diagrams

## Stripe — async webhook confirmation

```mermaid
sequenceDiagram
    actor User
    participant FE as Client
    participant API as NestJS API
    participant Stripe
    participant DB as PostgreSQL

    User->>FE: chooses "Pay with Stripe"
    FE->>API: POST /payments/:orderId/initiate {provider:"stripe"}
    API->>Stripe: paymentIntents.create({amount, metadata:{orderId}})
    Stripe-->>API: {id, client_secret}
    API->>DB: Payment{provider:STRIPE, transactionId:id, status:PENDING}
    API-->>FE: {clientSecret}

    FE->>Stripe: stripe.confirmPayment(clientSecret, card details)
    Note over FE,Stripe: Card details never touch our backend

    Stripe-->>API: POST /payments/stripe/webhook<br/>(event: payment_intent.succeeded)
    API->>API: verify signature (stripe-signature header + raw body)
    API->>DB: transaction:<br/>Payment→SUCCESS, Order→PAID, stock -= qty per item
    API-->>Stripe: 200 OK

    Note over API: A duplicate/retried webhook for the same<br/>already-SUCCESS payment is detected via<br/>PaymentEntity.isTerminal() and safely no-ops.
```

## bKash — callback + explicit execute

```mermaid
sequenceDiagram
    actor User
    participant FE as Client
    participant API as NestJS API
    participant Bkash as bKash
    participant DB as PostgreSQL
    participant Redis

    User->>FE: chooses "Pay with bKash"
    FE->>API: POST /payments/:orderId/initiate {provider:"bkash"}
    API->>Redis: get cached id_token (or grant a new one, cache ~50min)
    API->>Bkash: POST /tokenized/checkout/create
    Bkash-->>API: {paymentID, bkashURL}
    API->>DB: Payment{provider:BKASH, transactionId:paymentID, status:PENDING}
    API-->>FE: {redirectUrl: bkashURL}

    FE->>Bkash: redirect user to bkashURL
    User->>Bkash: approves payment (wallet number + PIN + OTP)
    Bkash-->>API: redirect to callbackURL?paymentID=...&status=success

    API->>Bkash: POST /tokenized/checkout/execute {paymentID}
    Bkash-->>API: {transactionStatus: "Completed", trxID}
    API->>DB: transaction:<br/>Payment→SUCCESS, Order→PAID, stock -= qty per item
    API-->>User: redirect to success page

    Note over API,Bkash: Unlike Stripe, bKash has no async server-push<br/>webhook — the callback redirect + explicit<br/>Execute Payment call together ARE the<br/>confirmation step.
```

## Why the two flows are structured differently

| | Stripe | bKash |
|---|---|---|
| Confirmation trigger | Async server-to-server webhook, independent of the user's browser | Browser redirect back to our callback URL |
| Backend's role on confirmation | Verify signature, then trust the event | Verify nothing cryptographically — must call Execute Payment ourselves to get an authoritative status |
| Retry/duplicate risk | Stripe retries webhook delivery on non-2xx | A user could reload the callback URL |
| How this repo prevents double-processing | `PaymentEntity`'s state machine — `SUCCESS`/`FAILED` are terminal, so both paths funnel through one `PaymentsService.finalizePayment` and safely no-op on a repeat |

Both providers ultimately converge on the exact same code path
(`PaymentsService.finalizePayment`), so "mark paid, reduce stock" is
implemented and tested exactly once, not duplicated per provider.
