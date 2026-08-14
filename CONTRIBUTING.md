# Contributing to Mail

Mail requires Node.js 22 or newer. Official Node 25+ distributions do not
bundle Corepack, so install it before enabling the reviewed package manager.

```sh
npm install -g corepack
corepack enable
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run check
pnpm test
```

Changes must preserve caller-owned atomicity, mandatory provider idempotency,
separate fenced send/reconcile lanes, monotonic delivery, bounded terminal
states, and conditional retention. Public behavior needs memory-store tests;
concurrency or conditional-storage changes should also run against Azurite.

Do not add a store, collection, partition, provider SDK, template engine,
webhook receipt store, inbound handling, bulk mail, or deliverability
abstraction.
