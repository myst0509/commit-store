Read PROJECT.md before any task. It defines the business model and the
architectural constraints, which are not obvious from the code.

Then read PROGRESS.md for current state: what is done, what is verified vs merely
written, and which decisions are already settled. Update it when something lands.

Hard rules:
- All money is integer cents. Never floats, never numeric.
- No vendor SDK, endpoint, or field name outside lib/fulfillment/.
- Every user-facing query goes through RLS. Service role is server-only.
- Vendor submissions are idempotent on orders.idempotency_key.
- Ask before adding a dependency.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
