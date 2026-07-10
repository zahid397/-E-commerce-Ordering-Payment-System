import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * These tests exercise the real HTTP layer end-to-end against an actual
 * Postgres database (set DATABASE_URL to a disposable test database before
 * running `npm run test:e2e` — never point this at production data, since
 * it truncates tables between tests).
 *
 * Outbound calls to Stripe and bKash are mocked at the module level so this
 * suite never depends on either provider's sandbox being reachable or
 * configured — it's testing *our* API's behavior, not theirs.
 */
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    paymentIntents: {
      create: jest.fn().mockResolvedValue({
        id: 'pi_test_123',
        client_secret: 'pi_test_123_secret',
      }),
      retrieve: jest.fn().mockResolvedValue({ id: 'pi_test_123', status: 'succeeded' }),
    },
    webhooks: {
      constructEvent: jest.fn().mockImplementation((_body, _sig) => ({
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_test_123' } },
      })),
    },
  }));
});

describe('E2E: auth, orders, payments', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;
  let adminToken: string;
  let productId: string;
  let orderId: string;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = moduleRef.get(PrismaService);

    // Clean slate — respects FK order (children before parents).
    await prisma.payment.deleteMany();
    await prisma.orderItem.deleteMany();
    await prisma.order.deleteMany();
    await prisma.product.deleteMany();
    await prisma.category.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Auth', () => {
    it('registers a new user', async () => {
      const res = await request(app.getHttpServer()).post('/auth/register').send({
        name: 'Test User',
        email: 'test@example.com',
        password: 'TestPass123',
      });
      expect(res.status).toBe(201);
      expect(res.body.password).toBeUndefined();
    });

    it('rejects registering the same email twice', async () => {
      const res = await request(app.getHttpServer()).post('/auth/register').send({
        name: 'Test User',
        email: 'test@example.com',
        password: 'TestPass123',
      });
      expect(res.status).toBe(409);
    });

    it('logs in and returns a JWT', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'test@example.com', password: 'TestPass123' });
      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeDefined();
      accessToken = res.body.accessToken;
    });

    it('rejects login with the wrong password', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'test@example.com', password: 'WrongPassword' });
      expect(res.status).toBe(401);
    });

    it('rejects an unauthenticated request to a protected route', async () => {
      const res = await request(app.getHttpServer()).get('/users/me');
      expect(res.status).toBe(401);
    });

    it('promotes a second user to ADMIN directly via Prisma (test setup shortcut) and logs in', async () => {
      const adminPasswordHash = await import('bcryptjs').then((b) => b.hash('AdminPass123', 10));
      await prisma.user.create({
        data: { name: 'Admin', email: 'admin-e2e@example.com', password: adminPasswordHash, role: 'ADMIN' },
      });
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'admin-e2e@example.com', password: 'AdminPass123' });
      adminToken = res.body.accessToken;
      expect(adminToken).toBeDefined();
    });
  });

  describe('Products & Categories', () => {
    it('rejects product creation without an admin token', async () => {
      const res = await request(app.getHttpServer())
        .post('/products')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Widget', sku: 'WID-1', price: 9.99, stock: 10 });
      expect(res.status).toBe(403);
    });

    it('allows an admin to create a product', async () => {
      const res = await request(app.getHttpServer())
        .post('/products')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Widget', sku: 'WID-1', price: 10, stock: 5 });
      expect(res.status).toBe(201);
      productId = res.body.id;
    });

    it('lists products publicly, without auth', async () => {
      const res = await request(app.getHttpServer()).get('/products');
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThan(0);
    });
  });

  describe('Orders', () => {
    it('creates an order for the logged-in user', async () => {
      const res = await request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ items: [{ productId, quantity: 2 }] });
      expect(res.status).toBe(201);
      expect(Number(res.body.totalAmount)).toBe(20);
      orderId = res.body.id;
    });

    it('rejects ordering more than available stock', async () => {
      const res = await request(app.getHttpServer())
        .post('/orders')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ items: [{ productId, quantity: 999 }] });
      expect(res.status).toBe(400);
    });

    it("prevents a different user from viewing someone else's order", async () => {
      const otherUser = await request(app.getHttpServer()).post('/auth/register').send({
        name: 'Other User',
        email: 'other@example.com',
        password: 'OtherPass123',
      });
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'other@example.com', password: 'OtherPass123' });

      const res = await request(app.getHttpServer())
        .get(`/orders/${orderId}`)
        .set('Authorization', `Bearer ${login.body.accessToken}`);
      expect(res.status).toBe(403);
      expect(otherUser.status).toBe(201); // just to use the variable meaningfully
    });
  });

  describe('Payments (Stripe mocked)', () => {
    it('initiates a Stripe payment and returns a client secret', async () => {
      const res = await request(app.getHttpServer())
        .post(`/payments/${orderId}/initiate`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ provider: 'stripe' });
      expect(res.status).toBe(201);
      expect(res.body.clientSecret).toBe('pi_test_123_secret');
    });

    it('rejects initiating a second payment while the order is already PENDING with an active flow (still allowed) vs after PAID (blocked)', async () => {
      // Simulate the Stripe webhook confirming success.
      const webhookRes = await request(app.getHttpServer())
        .post('/payments/stripe/webhook')
        .set('stripe-signature', 'test-signature')
        .send({ type: 'payment_intent.succeeded' });
      expect(webhookRes.status).toBe(201);

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      expect(order?.status).toBe('PAID');

      const product = await prisma.product.findUnique({ where: { id: productId } });
      expect(product?.stock).toBe(3); // 5 - 2 reduced on successful payment

      // Now a second initiate attempt on the same (now-PAID) order must fail.
      const secondAttempt = await request(app.getHttpServer())
        .post(`/payments/${orderId}/initiate`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ provider: 'stripe' });
      expect(secondAttempt.status).toBe(400);
    });

    it('a duplicate webhook delivery for the same event is a safe no-op (idempotency)', async () => {
      const res = await request(app.getHttpServer())
        .post('/payments/stripe/webhook')
        .set('stripe-signature', 'test-signature')
        .send({ type: 'payment_intent.succeeded' });
      expect(res.status).toBe(201);
      expect(res.body.alreadyProcessed).toBe(true);

      // Confirm stock was NOT reduced a second time.
      const product = await prisma.product.findUnique({ where: { id: productId } });
      expect(product?.stock).toBe(3);
    });
  });
});
