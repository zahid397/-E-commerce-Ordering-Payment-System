import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

const CACHE_KEY = 'category:tree:flat';
const CACHE_TTL_SECONDS = 300;

export interface FlatCategory {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
}

export interface CategoryTreeNode extends FlatCategory {
  children: CategoryTreeNode[];
}

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async create(dto: CreateCategoryDto) {
    if (dto.parentId) {
      const parent = await this.prisma.category.findUnique({ where: { id: dto.parentId } });
      if (!parent) {
        throw new BadRequestException('parentId does not reference an existing category');
      }
    }
    const existing = await this.prisma.category.findUnique({ where: { slug: dto.slug } });
    if (existing) {
      throw new ConflictException('A category with this slug already exists');
    }

    const category = await this.prisma.category.create({ data: dto });
    await this.invalidateCache();
    return category;
  }

  async update(id: string, dto: UpdateCategoryDto) {
    await this.findOneOrThrow(id);

    if (dto.parentId) {
      if (dto.parentId === id) {
        throw new BadRequestException('A category cannot be its own parent');
      }
      // Prevent creating a cycle: the new parent can't be a descendant of
      // this category, or the tree stops being a tree. Reuses the same DFS
      // machinery as recommendations, just walking downward from `id`.
      const descendantIds = await this.getDescendantIds(id);
      if (descendantIds.has(dto.parentId)) {
        throw new BadRequestException('Cannot move a category under its own descendant');
      }
    }

    const category = await this.prisma.category.update({ where: { id }, data: dto });
    await this.invalidateCache();
    return category;
  }

  async remove(id: string) {
    await this.findOneOrThrow(id);
    await this.prisma.category.delete({ where: { id } });
    await this.invalidateCache();
    return { message: 'Category deleted successfully' };
  }

  /** Returns the full category tree, nested. Reads the flat list from cache
   * when possible (see getFlatList) and builds the nested shape in memory —
   * building the tree itself never touches the database. */
  async getTree(): Promise<CategoryTreeNode[]> {
    const flat = await this.getFlatList();
    return this.buildTree(flat, null);
  }

  /**
   * DFS traversal of the category hierarchy, starting at `categoryId` and
   * walking down through every descendant. Used to power "related
   * products": a product in category X is related to products anywhere in
   * X's subtree, not just X itself.
   *
   * Explicit stack-based DFS (not recursion, so it can't stack-overflow on
   * a pathologically deep tree, and not a recursive SQL query — the whole
   * point of caching the flat list is to make repeated traversals free of
   * additional DB round-trips).
   */
  async getDescendantIds(categoryId: string): Promise<Set<string>> {
    const flat = await this.getFlatList();
    const childrenByParent = new Map<string, string[]>();
    for (const category of flat) {
      if (category.parentId) {
        const siblings = childrenByParent.get(category.parentId) ?? [];
        siblings.push(category.id);
        childrenByParent.set(category.parentId, siblings);
      }
    }

    const visited = new Set<string>();
    const stack: string[] = [categoryId];

    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (visited.has(current)) continue;
      visited.add(current);

      const children = childrenByParent.get(current) ?? [];
      for (const childId of children) {
        if (!visited.has(childId)) {
          stack.push(childId);
        }
      }
    }

    visited.delete(categoryId); // "descendants", not including the node itself
    return visited;
  }

  /** Related products = active products anywhere in this category's DFS
   * subtree, cheapest-to-read-first excluded, capped at `limit`. */
  async getRelatedProducts(categoryId: string, excludeProductId?: string, limit = 8) {
    await this.findOneOrThrow(categoryId);
    const descendantIds = await this.getDescendantIds(categoryId);
    const categoryIds = [categoryId, ...descendantIds];

    return this.prisma.product.findMany({
      where: {
        categoryId: { in: categoryIds },
        status: 'ACTIVE',
        ...(excludeProductId && { id: { not: excludeProductId } }),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  private async findOneOrThrow(id: string) {
    const category = await this.prisma.category.findUnique({ where: { id } });
    if (!category) {
      throw new NotFoundException('Category not found');
    }
    return category;
  }

  /** The single read path for the flat category list: Redis first, DB (and
   * re-cache) on a miss. Every method above goes through this, so there is
   * exactly one cache-population code path to reason about. */
  private async getFlatList(): Promise<FlatCategory[]> {
    const cached = await this.redis.get<FlatCategory[]>(CACHE_KEY);
    if (cached) {
      return cached;
    }

    const categories = await this.prisma.category.findMany({
      select: { id: true, name: true, slug: true, parentId: true },
      orderBy: { name: 'asc' },
    });
    await this.redis.set(CACHE_KEY, categories, CACHE_TTL_SECONDS);
    return categories;
  }

  private buildTree(flat: FlatCategory[], parentId: string | null): CategoryTreeNode[] {
    return flat
      .filter((category) => category.parentId === parentId)
      .map((category) => ({
        ...category,
        children: this.buildTree(flat, category.id),
      }));
  }

  private async invalidateCache(): Promise<void> {
    await this.redis.del(CACHE_KEY);
  }
}
