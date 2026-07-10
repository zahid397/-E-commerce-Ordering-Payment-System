import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const adminPasswordHash = await bcrypt.hash('AdminPass123', 10);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      name: 'Admin User',
      email: 'admin@example.com',
      password: adminPasswordHash,
      role: 'ADMIN',
    },
  });

  const customerPasswordHash = await bcrypt.hash('CustomerPass123', 10);
  await prisma.user.upsert({
    where: { email: 'customer@example.com' },
    update: {},
    create: {
      name: 'Sample Customer',
      email: 'customer@example.com',
      password: customerPasswordHash,
      role: 'USER',
    },
  });

  // Category hierarchy: Electronics > Laptops > {Gaming Laptops, Ultrabooks}
  const electronics = await prisma.category.upsert({
    where: { slug: 'electronics' },
    update: {},
    create: { name: 'Electronics', slug: 'electronics' },
  });
  const laptops = await prisma.category.upsert({
    where: { slug: 'laptops' },
    update: {},
    create: { name: 'Laptops', slug: 'laptops', parentId: electronics.id },
  });
  const gamingLaptops = await prisma.category.upsert({
    where: { slug: 'gaming-laptops' },
    update: {},
    create: { name: 'Gaming Laptops', slug: 'gaming-laptops', parentId: laptops.id },
  });
  const ultrabooks = await prisma.category.upsert({
    where: { slug: 'ultrabooks' },
    update: {},
    create: { name: 'Ultrabooks', slug: 'ultrabooks', parentId: laptops.id },
  });

  const products = [
    { name: 'Vortex Gaming Laptop 15"', sku: 'LAP-GAM-001', price: 1499.99, stock: 12, categoryId: gamingLaptops.id },
    { name: 'Vortex Gaming Laptop 17"', sku: 'LAP-GAM-002', price: 1899.99, stock: 6, categoryId: gamingLaptops.id },
    { name: 'Featherlight Ultrabook 13"', sku: 'LAP-ULT-001', price: 1099.0, stock: 20, categoryId: ultrabooks.id },
    { name: 'Featherlight Ultrabook 14"', sku: 'LAP-ULT-002', price: 1199.0, stock: 15, categoryId: ultrabooks.id },
    { name: 'Mechanical Keyboard', sku: 'ACC-KEY-001', price: 89.99, stock: 100, categoryId: electronics.id },
  ];

  for (const product of products) {
    await prisma.product.upsert({
      where: { sku: product.sku },
      update: {},
      create: { ...product, description: `${product.name} — seeded sample product.` },
    });
  }

  // eslint-disable-next-line no-console
  console.log('✅ Seed complete.');
  // eslint-disable-next-line no-console
  console.log(`   Admin login: admin@example.com / AdminPass123 (userId: ${admin.id})`);
  // eslint-disable-next-line no-console
  console.log('   Customer login: customer@example.com / CustomerPass123');
  // eslint-disable-next-line no-console
  console.log(`   Seeded ${products.length} products across 4 categories.`);
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
