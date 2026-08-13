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

/** Minimal flag parsing, so scripts do not pull in an arg-parsing dependency. */
export function args(argv = process.argv.slice(2)) {
  return {
    has: (name: string) => argv.includes(`--${name}`),
    get: (name: string) =>
      argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3),
    all: argv,
  };
}
