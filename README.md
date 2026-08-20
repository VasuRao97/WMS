# WMS MVP

Modular monolith Warehouse Management System.
Stack: NestJS (TypeScript) + Prisma + PostgreSQL + React/Vite.

## Architecture principle

`stock_movements` is an append-only ledger. No code path ever runs
`UPDATE` on a stock quantity directly. Every receipt, putaway, pick,
dispatch, and adjustment inserts a new row. Current stock at any
location is always:

```sql
SELECT sku_id, location_id, SUM(quantity) AS on_hand
FROM stock_movements
GROUP BY sku_id, location_id;
```

## Modules (in build order)

1. Master Data — warehouses, locations/bins, SKUs, users/roles
2. Inbound — receipts
3. Putaway — moving received stock into storage bins
4. Inventory — the ledger + live stock views
5. Outbound — orders, allocation
6. Picking — pick tasks
7. Dispatch
8. Returns
9. Analytics — dashboards (built last, on top of everything above)

## Getting started (local dev)

### 1. Start Postgres
```bash
docker compose up -d
```
This gives you a Postgres instance at `localhost:5432`
(user `wms`, password `wms_dev_password`, db `wms`).

### 2. Scaffold the NestJS backend
```bash
cd backend
npx @nestjs/cli new . --skip-git --package-manager npm
npm install prisma @prisma/client --save
npm install @nestjs/config bcrypt @nestjs/jwt passport passport-jwt --save
npx prisma generate
```
The `prisma/schema.prisma` file is already written — covers all
core tables for every module above.

Create `backend/.env`:
```
DATABASE_URL="postgresql://wms:wms_dev_password@localhost:5432/wms?schema=public"
JWT_SECRET="change-me-in-production"
```

Run the first migration:
```bash
npx prisma migrate dev --name init
```

### 3. Scaffold the frontend
```bash
cd frontend
npm create vite@latest . -- --template react-ts
npm install
npm install tailwindcss @tailwindcss/vite
npx shadcn@latest init
```

## Next steps
We build one module at a time, in the order above, each one working
end-to-end (API + DB + UI) before moving to the next. Month 1 target:
Master Data → Inbound → Putaway → live inventory view.
