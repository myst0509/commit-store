/**
 * Walks a brand-new seller through the entire launch path, against the real
 * database, and prints what each button actually does.
 *
 *   npx tsx scripts/launch-walkthrough.ts
 *   npx tsx scripts/launch-walkthrough.ts --keep
 *
 * This is the sequence PROJECT.md calls the product's main differentiator, so it
 * is worth being able to watch it run. Everything created is removed at the end.
 */

import { getLaunchState, performStep } from "../lib/launch/actions";
import type { StepKey } from "../lib/launch/steps";
import { adminClient, args, loadEnv } from "./_env";

loadEnv();
const sb = adminClient();
const a = args();

const created = { userId: "", storeId: "" };

function bar(percent: number): string {
  const filled = Math.round(percent / 5);
  return `[${"█".repeat(filled)}${"·".repeat(20 - filled)}] ${String(percent).padStart(3)}%`;
}

async function step(key: StepKey, input: Record<string, unknown> = {}) {
  const before = await getLaunchState(created.storeId);
  const def = before.steps.find((s) => s.key === key)!;

  try {
    const { result } = await performStep(created.storeId, key, input);
    const after = await getLaunchState(created.storeId);
    console.log(`  ✓ ${def.title.padEnd(28)} ${bar(after.summary.percent)}`);
    console.log(`      ${def.outcome}`);
    for (const [k, v] of Object.entries(result)) {
      console.log(`      ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
    }
  } catch (e) {
    console.log(`  ✗ ${def.title.padEnd(28)} blocked`);
    console.log(`      ${e instanceof Error ? e.message : e}`);
    throw e;
  }
  console.log();
}

async function main() {
  // A seller who has just signed up: an account and an empty store row.
  const email = `walkthrough-${Date.now()}@example.test`;
  const { data: user, error: uErr } = await sb.auth.admin.createUser({
    email, password: crypto.randomUUID(), email_confirm: true,
  });
  if (uErr) throw uErr;
  created.userId = user.user!.id;

  const { data: store, error: sErr } = await sb
    .from("stores")
    .insert({
      owner_id: created.userId,
      name: "Untitled", subdomain: `pending-${Date.now()}`, status: "draft",
    })
    .select("id").single();
  if (sErr) throw sErr;
  created.storeId = store.id;

  console.log("New seller, empty store.\n");

  const initial = await getLaunchState(created.storeId);
  console.log(`Start   ${bar(initial.summary.percent)}   next: ${initial.current?.title}\n`);

  // Blocked steps are refused server-side, not merely hidden in the UI.
  try {
    await performStep(created.storeId, "price", { retailPriceCents: 3200 });
    console.log("  !! a locked step was allowed to run — prerequisites are not enforced\n");
  } catch (e) {
    console.log(`Guard   ${e instanceof Error ? e.message : e}\n`);
  }

  await step("name", { name: "Union Made" });

  await step("design", {
    filename: "logo.png",
    storagePath: `${created.storeId}/logo.png`,
    publicUrl: "https://example.test/logo.png",
    widthPx: 4500, heightPx: 5400,
  });

  const { data: blank } = await sb
    .from("catalog_blanks").select("id").eq("is_enabled", true).limit(1).single();
  if (!blank) throw new Error("No enabled blanks. Run: npm run curate -- --enable --starter --apply");

  const { data: design } = await sb
    .from("designs").select("id").eq("store_id", created.storeId).limit(1).single();
  if (!design) throw new Error("Design step did not record a design");

  await step("blank", { blankId: blank.id });

  // Underpricing is refused with a message that names the real cost.
  try {
    await performStep(created.storeId, "price", {
      blankId: blank.id, retailPriceCents: 300, name: "Too Cheap",
    });
    console.log("  !! a loss-making price was accepted\n");
  } catch (e) {
    console.log(`Guard   ${e instanceof Error ? e.message : e}\n`);
  }

  await step("price", {
    blankId: blank.id, designId: design.id,
    name: "First Drop", retailPriceCents: 3200,
  });

  // Samples are deliberately not built — see the handler for why.
  try {
    await performStep(created.storeId, "sample");
  } catch (e) {
    console.log(`  ⏭ Order your sample            skipped`);
    console.log(`      ${e instanceof Error ? e.message : e}\n`);
    await sb.from("store_progress").upsert({
      store_id: created.storeId, step_key: "sample",
      status: "skipped", completed_at: new Date().toISOString(), result: {},
    }, { onConflict: "store_id,step_key" });
  }

  const { data: product } = await sb
    .from("products").select("id").eq("store_id", created.storeId).limit(1).single();
  if (!product) throw new Error("Pricing step did not create a product");

  const closesAt = new Date(Date.now() + 14 * 86_400_000).toISOString();
  await step("drop_date", { productId: product.id, closesAt, thresholdUnits: 25 });
  await step("waitlist");
  await step("launch");

  const final = await getLaunchState(created.storeId);
  console.log(`Finish  ${bar(final.summary.percent)}   ${final.current ? `next: ${final.current.title}` : "complete"}`);

  const { data: liveStore } = await sb
    .from("stores").select("subdomain, status").eq("id", created.storeId).single();
  const { data: liveProduct } = await sb
    .from("products").select("status").eq("id", product.id).single();

  console.log(`\nStore is ${liveStore?.status} at ${liveStore?.subdomain}, product is ${liveProduct?.status}.`);
}

main()
  .catch((e) => { console.error("\n", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(async () => {
    if (a.has("keep")) {
      console.log(`\n(kept: store ${created.storeId})`);
      return;
    }
    if (created.storeId) await sb.from("stores").delete().eq("id", created.storeId);
    if (created.userId) await sb.auth.admin.deleteUser(created.userId);
    console.log("\n(walkthrough store removed)");
  });
