# System Architecture

## Overview

```mermaid
graph TB
    Client["Client (Postman / Swagger UI / frontend)"]

    subgraph API["NestJS Application"]
        Auth["Auth Module<br/>(JWT register/login)"]
        Users["Users Module"]
        Categories["Categories Module<br/>(DFS + Redis cache)"]
        Products["Products Module<br/>(atomic stock reduction)"]
        Orders["Orders Module<br/>(domain-driven totals)"]
        Payments["Payments Module<br/>(Strategy pattern)"]
        Domain["Domain Layer<br/>(User/Product/Order/Payment entities)"]
    end

    subgraph Strategies["Payment Strategies"]
        StripeStrat["StripePaymentStrategy"]
        BkashStrat["BkashPaymentStrategy"]
    end

    Postgres[("PostgreSQL<br/>(Prisma)")]
    Redis[("Redis<br/>(category tree + bKash token cache)")]
    StripeAPI["Stripe API"]
    BkashAPI["bKash Tokenized Checkout API"]

    Client -->|"HTTPS + JWT"| API
    Auth --> Postgres
    Users --> Postgres
    Categories --> Postgres
    Categories --> Redis
    Products --> Postgres
    Orders --> Postgres
    Orders --> Domain
    Payments --> Domain
    Payments --> Postgres
    Payments --> Strategies
    StripeStrat --> StripeAPI
    BkashStrat --> BkashAPI
    BkashStrat --> Redis

    StripeAPI -.->|"webhook (async push)"| Payments
    BkashAPI -.->|"redirect callback"| Payments
```

## Layering

```
Controller  → HTTP concerns only (guards, DTO validation, status codes)
Service     → orchestration: talks to Prisma, calls domain entities, calls strategies
Domain      → pure business rules (no I/O): OrderEntity, ProductEntity, PaymentEntity, UserEntity
Prisma      → persistence
Strategies  → third-party payment integration, swappable without touching Service/Domain
```

The domain layer has zero dependency on NestJS, Prisma, or HTTP — it's plain
TypeScript classes, which is exactly why `src/domain/*.spec.ts` can unit-test
the total-calculation and state-machine logic directly, with no database or
mocking required at all.

## Request flow: checkout end to end

```mermaid
sequenceDiagram
    actor User
    participant API as NestJS API
    participant DB as PostgreSQL
    participant Strategy as Payment Strategy
    participant Provider as Stripe / bKash

    User->>API: POST /orders {items}
    API->>DB: validate stock, create Order (PENDING) + OrderItems
    API-->>User: 201 Order

    User->>API: POST /payments/:orderId/initiate {provider}
    API->>Strategy: initiate(order)
    Strategy->>Provider: create payment intent / checkout
    Provider-->>Strategy: transactionId, clientSecret/redirectUrl
    API->>DB: create Payment (PENDING)
    API-->>User: redirectUrl or clientSecret

    User->>Provider: completes payment
    Provider-->>API: webhook (Stripe) / redirect callback (bKash)
    API->>Strategy: verify + confirm
    API->>DB: transaction — Payment=SUCCESS, Order=PAID, stock -= qty (atomic)
    API-->>Provider: 200 OK
```
