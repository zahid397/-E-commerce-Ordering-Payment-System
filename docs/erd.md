# Entity-Relationship Diagram

```mermaid
erDiagram
    User ||--o{ Order : places
    Category ||--o{ Category : "parent / children"
    Category ||--o{ Product : contains
    Order ||--o{ OrderItem : contains
    Product ||--o{ OrderItem : "ordered as"
    Order ||--o{ Payment : "paid via"

    User {
        string id PK
        string name
        string email UK
        string password
        enum role "USER | ADMIN"
        datetime createdAt
        datetime updatedAt
    }

    Category {
        string id PK
        string name
        string slug UK
        string parentId FK "nullable, self-referencing"
        datetime createdAt
        datetime updatedAt
    }

    Product {
        string id PK
        string name
        string sku UK
        string description
        decimal price
        int stock
        enum status "ACTIVE | INACTIVE"
        string categoryId FK "nullable"
        datetime createdAt
        datetime updatedAt
    }

    Order {
        string id PK
        string userId FK
        decimal totalAmount
        enum status "PENDING | PAID | CANCELED"
        datetime createdAt
        datetime updatedAt
    }

    OrderItem {
        string id PK
        string orderId FK
        string productId FK
        int quantity
        decimal price "unit price snapshot at order time"
        decimal subtotal "quantity x price"
        datetime createdAt
    }

    Payment {
        string id PK
        string orderId FK
        enum provider "STRIPE | BKASH"
        string transactionId UK
        enum status "PENDING | SUCCESS | FAILED"
        json rawResponse
        datetime createdAt
        datetime updatedAt
    }
```

## Indexes (see `prisma/schema.prisma` for the authoritative source)

| Table | Index | Why |
|---|---|---|
| `categories` | `parentId` | every DFS traversal and tree build starts by grouping children by parent |
| `products` | `categoryId`, `status` | recommendation queries and the public product-list filter |
| `orders` | `userId`, `status` | "my orders" listing, and initiate-payment's status guard |
| `order_items` | `orderId`, `productId` | order detail joins, and per-product order history |
| `payments` | `orderId` | listing a user's payments joined through their orders |
| `payments.transactionId` | unique | the webhook/callback lookup key — must resolve in O(1) and reject duplicate provider transaction ids |

## Design notes

- **`Category` is self-referencing** (`parentId → Category.id`) rather than a separate closure table, since the tree depth here is small and the DFS traversal + Redis-cached flat list (see `CategoriesService`) makes repeated traversals cheap without needing a more complex nested-set or closure-table structure.
- **`OrderItem.price` is a snapshot**, not a live join to `Product.price` — an order's total must never change retroactively if a product's price changes later. This is also why `OrderItem.subtotal` is stored rather than always recomputed: it's the historical record of what was actually charged.
- **`Payment.transactionId` is globally unique** across both providers — this is what makes `PaymentsService.finalizePayment` a safe, idempotent lookup key for both Stripe's webhook and bKash's callback.
