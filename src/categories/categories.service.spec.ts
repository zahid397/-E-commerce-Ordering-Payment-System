import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CategoriesService, FlatCategory } from './categories.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

// A 3-level tree:
// electronics
//   ├── laptops
//   │     ├── gaming-laptops
//   │     └── ultrabooks
//   └── phones
// home-goods (unrelated root)
const FLAT_CATEGORIES: FlatCategory[] = [
  { id: 'electronics', name: 'Electronics', slug: 'electronics', parentId: null },
  { id: 'laptops', name: 'Laptops', slug: 'laptops', parentId: 'electronics' },
  { id: 'phones', name: 'Phones', slug: 'phones', parentId: 'electronics' },
  { id: 'gaming-laptops', name: 'Gaming Laptops', slug: 'gaming-laptops', parentId: 'laptops' },
  { id: 'ultrabooks', name: 'Ultrabooks', slug: 'ultrabooks', parentId: 'laptops' },
  { id: 'home-goods', name: 'Home Goods', slug: 'home-goods', parentId: null },
];

describe('CategoriesService', () => {
  let service: CategoriesService;
  let prisma: { category: Record<string, jest.Mock>; product: Record<string, jest.Mock> };
  let redis: { get: jest.Mock; set: jest.Mock; del: jest.Mock };

  beforeEach(async () => {
    prisma = {
      category: {
        findMany: jest.fn().mockResolvedValue(FLAT_CATEGORIES),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      product: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    redis = {
      get: jest.fn().mockResolvedValue(null), // cache miss by default
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CategoriesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = moduleRef.get(CategoriesService);
  });

  describe('getDescendantIds (DFS)', () => {
    it('collects every descendant several levels down, not just direct children', async () => {
      const descendants = await service.getDescendantIds('electronics');
      expect(descendants).toEqual(new Set(['laptops', 'phones', 'gaming-laptops', 'ultrabooks']));
    });

    it('does not include the starting node itself', async () => {
      const descendants = await service.getDescendantIds('laptops');
      expect(descendants.has('laptops')).toBe(false);
    });

    it('returns an empty set for a leaf node', async () => {
      const descendants = await service.getDescendantIds('gaming-laptops');
      expect(descendants.size).toBe(0);
    });

    it('does not cross into unrelated branches of the tree', async () => {
      const descendants = await service.getDescendantIds('electronics');
      expect(descendants.has('home-goods')).toBe(false);
    });
  });

  describe('getTree', () => {
    it('nests categories correctly under their parents', async () => {
      const tree = await service.getTree();
      const electronics = tree.find((c) => c.id === 'electronics')!;
      const laptops = electronics.children.find((c) => c.id === 'laptops')!;

      expect(tree).toHaveLength(2); // two roots: electronics, home-goods
      expect(electronics.children.map((c) => c.id).sort()).toEqual(['laptops', 'phones']);
      expect(laptops.children.map((c) => c.id).sort()).toEqual(['gaming-laptops', 'ultrabooks']);
    });
  });

  describe('caching', () => {
    it('queries the database on a cache miss, then caches the result', async () => {
      await service.getTree();
      expect(prisma.category.findMany).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledWith(
        'category:tree:flat',
        FLAT_CATEGORIES,
        expect.any(Number),
      );
    });

    it('serves subsequent calls from cache without hitting the database again', async () => {
      redis.get.mockResolvedValueOnce(null).mockResolvedValue(FLAT_CATEGORIES);

      await service.getTree(); // miss -> populates cache (in the real Redis; here just re-mocked)
      await service.getDescendantIds('electronics'); // should now read from "cache"

      expect(prisma.category.findMany).toHaveBeenCalledTimes(1);
    });

    it('invalidates the cache after creating a category', async () => {
      prisma.category.findUnique.mockResolvedValue(null); // no slug conflict, no parent needed
      prisma.category.create.mockResolvedValue({
        id: 'new',
        name: 'New',
        slug: 'new',
        parentId: null,
      });

      await service.create({ name: 'New', slug: 'new' });

      expect(redis.del).toHaveBeenCalledWith('category:tree:flat');
    });
  });

  describe('update — cycle prevention', () => {
    it('rejects setting a category as its own parent', async () => {
      prisma.category.findUnique.mockResolvedValue(FLAT_CATEGORIES[1]); // laptops exists

      await expect(service.update('laptops', { parentId: 'laptops' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects moving a category under its own descendant (would create a cycle)', async () => {
      prisma.category.findUnique.mockResolvedValue(FLAT_CATEGORIES[0]); // electronics exists

      await expect(service.update('electronics', { parentId: 'gaming-laptops' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws NotFoundException when updating a category that does not exist', async () => {
      prisma.category.findUnique.mockResolvedValue(null);
      await expect(service.update('missing', { name: 'X' })).rejects.toThrow(NotFoundException);
    });
  });
});
