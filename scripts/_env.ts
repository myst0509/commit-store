import fs from "node:fs";
import path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Standalone scripts get no Next.js env loading, so read .env.local directly.
 * Anything already in the real environment wins, so CI can override.
 */
export function loadEnv(): void {
  const file = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return;

  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

export function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Set it in .env.local.`);
    process.exit(1);
  }
  return v;
}

/**
 * Service-role client. Bypasses RLS and all column grants — correct for scripts,
 * which act on behalf of the platform rather than a user. Never in app code.
 */
export function adminClient(): SupabaseClient {
  loadEnv();
  return createClient(
    required("NEXT_PUBLIC_SUPABASE_URL"),
    required("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );
}

/**
 * Deletes a store and everything under it, in dependency order.
 *
 * A plain `delete from stores` FAILS. The cascade reaches `designs`, but
 * `product_artwork.design_id` is ON DELETE RESTRICT — deliberately, so a seller
 * cannot delete a design that is live on a product. Postgres has no way to know
 * the artwork rows are about to be cascaded away too.
 *
 * So products go first (taking their artwork and variants with them), then
 * designs, then the store.
 *
 * NOTE: this refuses to run if the store has orders. Order history is financial
 * record — account closure has to anonymise it, not erase it, and that is a
 * different operation than this.
 */
export async function deleteStoreCompletely(
  sb: SupabaseClient,
  storeId: string,
): Promise<void> {
  const { count } = await sb
    .from("orders").select("id", { count: "exact", head: true }).eq("store_id", storeId);

  if (count) {
    throw new Error(
      `Store ${storeId} has ${count} order(s); refusing to delete financial records`,
    );
  }

  const steps: Array<[string, () => PromiseLike<{ error: unknown }>]> = [
    ["products", () => sb.from("products").delete().eq("store_id", storeId)],
    ["designs", () => sb.from("designs").delete().eq("store_id", storeId)],
    ["drops", () => sb.from("drops").delete().eq("store_id", storeId)],
    ["stores", () => sb.from("stores").delete().eq("id", storeId)],
  ];

  for (const [label, run] of steps) {
    const { error } = await run();
    // Checked, not assumed. A silently failed cleanup leaves rows that collide
    // with the next run under a unique constraint.
    if (error) throw new Error(`Failed deleting ${label}: ${JSON.stringify(error)}`);
  }
}

/** Minimal flag parsing, so scripts do not pull in an arg-parsing dependency. */
export function args(argv = process.argv.slice(2)) {
  return {
    has: (name: string) => argv.includes(`--${name}`),
    get: (name: string) =>
      argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3),
    all: argv,
  };
}
