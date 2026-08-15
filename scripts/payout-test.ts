/**
 * Tests the payout run against real Stripe test mode and the real database.
 *
 *   npx tsx scripts/payout-test.ts
 *
 * The transfer itself cannot succeed here — a freshly created Express account
 * has not completed onboarding, and the platform test balance is empty. That is
 * useful rather than limiting: the failure path is the one that matters. A
 * failed transfer must RELEASE the seller's ledger entries, or their money is
 * stranded and no future run will ever pay it.
 */

import { ensureConnectAccount, syncConnectStatus } from "../lib/payouts/connect";
import { findPayableStores, runPayouts } from "../lib/payouts/run";
import { isTestMode, stripe } from "../lib/stripe/client";
import { adminClient, args, loadEnv } from "./_env";

loadEnv();

if (!isTestMode()) {
  console.error("STRIPE_SECRET_KEY is not a test key. Refusing to run.");
  process.exit(1);
}

const sb = adminClient();
const a = args();

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok || !detail ? "" : `  — ${detail}`}`);
  ok ? pass++ : fail++;
};

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
let storeId = "";
let accountId = "";
const entryIds: string[] = [];

async function credit(amountCents: number, availableAt: Date) {
  const { data } = await sb.from("ledger_entries").insert({
    store_id: storeId, kind: "seller_margin", amount_cents: amountCents,
    available_at: availableAt.toISOString(), description: "payout test",
  }).select("id").single();
  entryIds.push(data!.id);
  return data!.id;
}

async function main() {
  const { data: store } = await sb.from("stores").select("id").eq("subdomain", "demo").single();
  storeId = store!.id;

  console.log("Connect onboarding");
  let connectEnabled = true;
  try {
    accountId = await ensureConnectAccount(storeId);
    check("an Express account is created", accountId.startsWith("acct_"), accountId);

    const again = await ensureConnectAccount(storeId);
    check("a second call reuses it rather than creating a duplicate", again === accountId);

    const status = await syncConnectStatus(storeId);
    check("payouts are not enabled before onboarding", status.payoutsEnabled === false);
    console.log(`        requirements outstanding: ${status.requirements.length}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/signed up for Connect/i.test(message)) {
      connectEnabled = false;
      console.log("  --    Connect is not enabled on this Stripe account.");
      console.log("        Enable it at https://dashboard.stripe.com/connect (test mode),");
      console.log("        then re-run to cover onboarding and the transfer path.");
      console.log("        Everything below still runs against a placeholder account id.\n");
      // Stand in for a connected account so the payout guards are still exercised.
      accountId = "";
      await sb.from("stores").update({ stripe_account_id: "acct_placeholder_test" }).eq("id", storeId);
    } else {
      throw e;
    }
  }
  void connectEnabled;

  console.log("\nWhat is payable");
  // Earned but still inside net-14: not payable.
  await credit(5000, new Date(Date.now() + 7 * 86_400_000));
  let payable = await findPayableStores();
  check("future-dated earnings are not payable yet",
    !payable.some((p) => p.storeId === storeId), "net-14 window ignored");

  // Earned and matured.
  await credit(2500, new Date(Date.now() - 86_400_000));
  payable = await findPayableStores();
  const mine = payable.find((p) => p.storeId === storeId);
  check("matured earnings become payable", mine?.payableCents === 2500, `${mine?.payableCents}`);

  console.log("\nGuards");
  await sb.from("stores").update({ payouts_held: true }).eq("id", storeId);
  let run = await runPayouts();
  let result = run.results.find((r) => r.storeId === storeId);
  check("a held store is not paid", result?.status === "skipped", result?.note);
  console.log(`        ${result?.note}`);

  await sb.from("stores").update({ payouts_held: false, stripe_payouts_enabled: false }).eq("id", storeId);
  run = await runPayouts();
  result = run.results.find((r) => r.storeId === storeId);
  check("a store with incomplete onboarding is not paid", result?.status === "skipped");
  console.log(`        ${result?.note}`);

  // Pretend onboarding finished, so the transfer path is actually reached.
  await sb.from("stores").update({ stripe_payouts_enabled: true }).eq("id", storeId);

  console.log("\nBelow the minimum");
  await sb.from("ledger_entries").update({ amount_cents: 500 }).eq("id", entryIds[1]);
  run = await runPayouts();
  result = run.results.find((r) => r.storeId === storeId);
  check("small balances roll forward instead of being paid", result?.status === "skipped");
  console.log(`        ${result?.note}`);

  const { data: stillUnclaimed } = await sb
    .from("ledger_entries").select("payout_id").eq("id", entryIds[1]).single();
  check("  and the entry is left unclaimed", stillUnclaimed?.payout_id === null);

  console.log("\nA transfer that fails must not strand the money");
  await sb.from("ledger_entries").update({ amount_cents: 2500 }).eq("id", entryIds[1]);
  run = await runPayouts();
  result = run.results.find((r) => r.storeId === storeId);
  console.log(`        ${result?.status}: ${result?.note?.slice(0, 110)}`);

  if (result?.status === "paid") {
    check("transfer succeeded (platform balance was funded)", true);
  } else {
    check("the failure is reported, not swallowed", result?.status === "failed");

    const { data: released } = await sb
      .from("ledger_entries").select("payout_id").eq("id", entryIds[1]).single();
    check("the seller's entry is RELEASED, not stranded", released?.payout_id === null,
      "a stranded entry means money nobody will ever pay out");

    const payableAgain = await findPayableStores();
    check("the balance is payable again on the next run",
      payableAgain.find((p) => p.storeId === storeId)?.payableCents === 2500);

    const { data: payoutRow } = await sb
      .from("payouts").select("status, failure_reason").eq("id", result!.payoutId!).single();
    check("the attempt is recorded as failed with a reason", payoutRow?.status === "failed",
      payoutRow?.status);
    console.log(`        recorded reason: ${(payoutRow?.failure_reason ?? "").slice(0, 90)}`);
  }

  console.log("\nNegative balances");
  await credit(-3000, new Date(Date.now() - 86_400_000));
  run = await runPayouts();
  result = run.results.find((r) => r.storeId === storeId);
  check("a clawed-back balance is not paid out", result?.status === "skipped", result?.note);
  console.log(`        ${result?.note}`);
}

main()
  .catch((e) => { console.error("\nFAILED:", e instanceof Error ? e.message : e); fail++; })
  .finally(async () => {
    if (!a.has("keep")) {
      await sb.from("ledger_entries").delete().eq("store_id", storeId);
      await sb.from("payouts").delete().eq("store_id", storeId);
      await sb.from("stores")
        .update({ stripe_account_id: null, stripe_payouts_enabled: false, payouts_held: true })
        .eq("id", storeId);
      if (accountId) await stripe().accounts.del(accountId).catch(() => {});
      console.log("\n(ledger, payouts and the test Connect account removed)");
    }
    console.log(fail ? `\n${fail} CHECK(S) FAILED` : `\nAll ${pass} checks passed.`);
    process.exit(fail ? 1 : 0);
  });
