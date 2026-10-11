# shop-api — Cartograph sample project

A deliberately small but realistic TypeScript service. It exists so Cartograph's
pipeline can be demonstrated and tested end to end on something that compiles
and has real dependencies between its parts.

Layout:

```
src/index.ts        entry point: builds the server and registers routes
src/api/            HTTP server and route table
src/auth/           login, password hashing, tokens — and session handling
src/db/             database client and the user/order queries
src/payments/       checkout flow
src/utils/          logger and id generation
src/types/          shared types
```

Both checks run with no `npm install` (Node 22.6+ runs the TypeScript directly):

```
npm test
npx tsc --noEmit
```

The intended demo edit is to pull the session functions out of `src/auth` into a
new `Session Management` module — see the repository README.
