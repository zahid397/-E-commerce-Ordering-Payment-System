# E-commerce Ordering & Payment System

A backend for managing users, products, orders, and payments, with **Stripe** and **bKash** integrated behind a shared Strategy interface. Built for the Backend Engineer assessment.

---

## 1. Tech Stack

NestJS 10 · TypeScript · PostgreSQL · Prisma 5 · Redis (ioredis) · JWT (Passport) · bcryptjs · Stripe SDK · Swagger/OpenAPI · Jest + Supertest · Docker

## 2. Features

- Register/login (JWT), roles (`USER`/`ADMIN`)
- Product catalog with admin CRUD, public search/filter/pagination
- Category hierarchy (self-referencing tree) with **DFS-traversed, Redis-cached** related-product recommendations
- Orders with deterministic total/subtotal calculation via a domain layer
- Payments via **Stripe** (webhook) and **bKash** (Tokenized Checkout, callback + execute) behind one **Strategy pattern** interface
- **Concurrency-safe stock reduction** — an atomic conditional UPDATE, not a read-then-write
- **Idempotent payment finalization** — a duplicate/retried webhook can never double-reduce stock
- Global validation, helmet, CORS, rate limiting on write-heavy routes, structured logging, consistent JSON error shape

## 3. Folder Structure

```
src/
├── domain/              # Pure OOP entities: User, Product, Order, Payment (no I/O, no framework deps)
├── auth/                 # register, login, JWT strategy
├── users/
├── categories/           # DFS traversal + Redis-cached tree
├── products/             # CRUD + reduceStockSafely (the atomic algorithm)
├── orders/                # domain-entity-driven creation + total calculation
├── payments/
│   ├── strategies/         # PaymentStrategy interface, Stripe/bKash implementations, factory
│   ├── payments.service.ts # strategy dispatch + idempotent finalizePayment
│   └── payments.controller.ts
├── prisma/, redis/        # infrastructure
├── common/                # guards, decorators, filters, types
├── app.module.ts, main.ts
prisma/
├── schema.prisma, seed.ts
test/
├── app.e2e-spec.ts        # auth, orders, payments, webhook idempotency
docs/
├── architecture.md, erd.md, payment-flows.md   # all with Mermaid diagrams
```

## 4. Core Design Requirements — where each one lives

| Requirement | Implementation |
|---|---|
| **OOP** (User/Product/Order/Payment classes) | `src/domain/*.entity.ts` — real behavior (state machines, stock guards, total calculation), not anemic models. Framework/DB-free, which is also why they're unit-testable with zero mocking. |
| **Data structures** (relational + indexed) | `prisma/schema.prisma` — see `docs/erd.md` for the index rationale table |
| **Deterministic algorithms** | `OrderEntity.calculateTotal()` / `OrderLineItem.subtotal()` — pure functions, rounded to avoid float drift; verified in `order.entity.spec.ts` |
| **Safe stock reduction** | `ProductsService.reduceStockSafely()` — single atomic `UPDATE ... WHERE stock >= qty`, not check-then-write. See the method's doc comment and `products.service.spec.ts`'s concurrent-race simulation |
| **Strategy pattern** (payments) | `src/payments/strategies/` — `PaymentStrategy` interface, `StripePaymentStrategy`, `BkashPaymentStrategy`, `PaymentStrategyFactory`. `PaymentsService` never imports Stripe or bKash directly |
| **DFS + caching** (category recommendations) | `CategoriesService.getDescendantIds()` — explicit stack-based DFS over a Redis-cached flat category list; see `categories.service.spec.ts` |

## 5. Environment Variables

See `.env.example`. Notably:

- `DATABASE_URL` — Postgres connection string
- `REDIS_URL` — used for the category-tree cache and the bKash `id_token` cache
- `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` — get your own from the [Stripe test dashboard](https://dashboard.stripe.com/test/apikeys)
- `BKASH_*` — the values shipped in `.env.example` are **bKash's own publicly documented sandbox demo credentials** (shared by bKash for any developer to test with, not a real merchant's secret — see [developer.bka.sh](https://developer.bka.sh)). Replace with your own sandbox or live credentials for anything beyond local testing.

## 6. Setup & Run Locally

```bash
npm install                 # also runs `prisma generate` via postinstall
cp .env.example .env         # fill in DATABASE_URL, JWT_SECRET, Stripe keys
npm run prisma:migrate       # creates the schema, prompts for a migration name (e.g. "init")
npm run seed                 # optional — admin@example.com / AdminPass123, sample products
npm run start:dev
```

API on `http://localhost:5000`. Swagger: `http://localhost:5000/api/docs`.

### Docker (everything at once)

```bash
docker compose up --build
```

## 7. Testing

```bash
npm test                     # unit tests: 59 tests across domain entities + services
npm run test:e2e             # e2e: auth, orders, payments, webhook idempotency (needs a real Postgres)
```

**What's actually been run, honestly:** all 59 unit tests (`src/**/*.spec.ts`) were executed for real in this build — Jest results are in the PR/build log. The domain-entity tests need no database at all (pure TypeScript classes); the service-layer tests mock Prisma/Redis/the payment strategies, which is correct practice regardless (a unit test shouldn't hit a real payment gateway). The e2e suite (`test/app.e2e-spec.ts`) was verified to **compile with zero TypeScript errors** against the real controller/service/DTO shapes, but its actual database-backed run needs a real `DATABASE_URL` and a normal internet connection for `prisma generate`/`prisma migrate` to fetch Prisma's query-engine binary — run it yourself with `npm run test:e2e` after `npm install` completes normally.

### Manual webhook testing with the Stripe CLI

```bash
stripe listen --forward-to localhost:5000/api/v1/payments/stripe/webhook
stripe trigger payment_intent.succeeded
```

### Exposing your local server for real Stripe/bKash callbacks (ngrok)

```bash
ngrok http 5000
# then set your Stripe webhook endpoint and BKASH_CALLBACK_URL to the ngrok https URL
```

## 8. API Endpoints

**Auth**: `POST /auth/register`, `POST /auth/login`
**Users**: `GET /users/me`
**Categories**: `GET /categories/tree` (public), `POST` / `PATCH :id` / `DELETE :id` (admin)
**Products**: `GET /products` (search/filter/paginate), `GET /products/:id`, `GET /products/:id/recommendations` (DFS), admin CUD
**Orders**: `POST /orders`, `GET /orders` (mine, or all if admin), `GET /orders/:id`
**Payments**: `POST /payments/:orderId/initiate`, `POST /payments/:orderId/confirm`, `POST /payments/stripe/webhook`, `GET /payments/bkash/callback`, `GET /payments` (mine)

Full request/response schemas: `/api/docs`.

## 9. Key Technical Decisions

- **Stock is checked at order creation, reduced at payment success** — per the assignment's explicit order flow. This means several `PENDING` orders can each pass the initial stock check against the same limited stock; only as many as remain will actually succeed at payment time (later ones surface a clear "out of stock" error from `reduceStockSafely`). A stricter design would place a short-lived reservation on stock at order creation — noted below as a improvement, not implemented, to match the spec's flow exactly rather than silently deviate from it.
- **`OrderItem.price`/`subtotal` are snapshots**, not live joins — an order's total must never drift if a product's price changes later.
- **Both payment providers converge on one `PaymentsService.finalizePayment`** — "mark paid, reduce stock" is implemented and tested exactly once, not duplicated per provider, and the `PaymentEntity` state machine (`SUCCESS`/`FAILED` both terminal) makes that method safely idempotent against duplicate/retried webhook delivery.
- **`bcryptjs` over `bcrypt`** — pure JS, no native compilation step, one less thing that can fail across different build environments (this bit a previous project of mine for exactly this reason).
- **A hand-rolled domain layer, not just NestJS's incidental classes** — the OOP requirement is satisfied by real business-rule-bearing entities (state machines, invariant guards), which is also what made 26 of the 59 unit tests possible with zero mocking at all.

## 10. Challenges & How They Were Solved

- **The classic overselling race condition** — solved with a single atomic `UPDATE ... WHERE stock >= quantity` rather than a separate read-then-write, so two concurrent requests for the last unit can't both succeed. Verified with a simulated-concurrency test in `products.service.spec.ts`.
- **Duplicate webhook delivery** (a real, common Stripe behavior on slow/non-2xx responses) — solved by making payment status transitions a guarded state machine (`PENDING → SUCCESS | FAILED`, both terminal), so a repeat delivery is detected and safely no-ops instead of re-running the stock-reduction logic.
- **bKash has no async webhook**, unlike Stripe — its flow is a browser redirect callback plus an explicit server-side Execute call. Both are documented distinctly in `docs/payment-flows.md` and both still funnel through the same `finalizePayment`.
- **Verifying the bKash REST contract without an SDK** — cross-checked the Tokenized Checkout v1.2.0-beta endpoints, headers, and payload shapes against multiple independent integration write-ups before implementing `BkashHttpClient`; one specific ambiguity (whether Query Payment is GET or POST per bKash's own docs) is flagged directly in that file's doc comment rather than silently guessed.

## 11. What I'd Improve With More Time

- A short-lived stock **reservation** at order creation (not just a check), to avoid the PENDING-order race described above
- A reconciliation job polling `BkashHttpClient.queryPayment` for any payment stuck in `PENDING` past a timeout
- Refresh-token support (access tokens are currently short-lived only)
- Idempotency keys on `POST /orders` itself (currently relies on the client not double-submitting)
- A rate-limit specifically on `/auth/login` distinct from the general throttle

## 12. Deployment

- **Docker**: `docker compose up --build` runs Postgres + Redis + the API together; the image's `CMD` runs `prisma migrate deploy` before starting.
- **Local + ngrok**: run `npm run start:dev`, then `ngrok http 5000`, then point Stripe's webhook config and `BKASH_CALLBACK_URL` at the ngrok HTTPS URL — this is exactly how the assignment's "backend running locally via ngrok" deployment mode is meant to work, since both providers need a real HTTPS endpoint to call back to.
- **Migrations in production**: `npm run prisma:deploy` (uses `prisma migrate deploy`, which applies committed migrations without prompting — the correct command for CI/production, as opposed to `prisma migrate dev`, which is for local schema iteration).
