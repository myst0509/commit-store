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
