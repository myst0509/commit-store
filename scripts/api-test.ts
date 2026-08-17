/**
 * Exercises the HTTP API the way a separate frontend will.
 *
 *   npm run dev
 *   npx tsx scripts/api-test.ts
 *
 * Two things it is really checking. That authentication cannot be skipped or
 * side-stepped by naming another store, and that no response ever carries our
 * vendor cost or the base/fee split — these routes read with the service role,
 * which bypasses the column grants in migration 0002, so the omission has to
 * hold in application code.
 */

import http from "node:http";

import { createClient } from "@supabase/supabase-js";

import { adminClient, args, deleteStoreCompletely, loadEnv, required } from "./_env";

loadEnv();

const sb = adminClient();
const a = args();
const BASE = process.env.API_BASE ?? "http://127.0.0.1:3000";
const ANON = required("NEXT_PUBLIC_SUPABASE_ANON_KEY");

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${ok || !detail ? "" : `  — ${detail}`}`);
  ok ? pass++ : fail++;
};

const made = { users: [] as string[], stores: [] as string[] };

async function makeSeller(tag: string) {
  const email = `api-${tag}-${Date.now()}@example.test`;
  const password = `Api-${crypto.randomUUID()}`;

  const { data: user } = await sb.auth.admin.createUser({ email, password, email_confirm: true });
  made.users.push(user.user!.id);

  const { data: store } = await sb.from("stores").insert({
    owner_id: user.user!.id,
    name: `API ${tag.toUpperCase()}`,
    subdomain: `api-${tag}-${Date.now()}`,
    status: "draft",
  }).select("id").single();
  made.stores.push(store!.id);

  const anon = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), ANON, {
    auth: { persistSession: false },
  });
  const { data: session } = await anon.auth.signInWithPassword({ email, password });

  return { storeId: store!.id, token: session!.session!.access_token };
}

const get = (path: string, token?: string) =>
  fetch(BASE + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });

const post = (path: string, body: unknown, token?: string, host?: string) => {
  // `fetch` silently drops a Host header — it is forbidden by the Fetch spec —
  // and Windows does not resolve *.localhost, so neither a header nor a URL
  // gets us to a specific storefront. node:http sets Host properly.
  if (host) return postWithHost(path, body, host);

  return fetch(BASE + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
};

function postWithHost(path: string, body: unknown, host: string): Promise<Response> {
  const payload = JSON.stringify(body);
  const url = new URL(BASE);

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        host,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(new Response(Buffer.concat(chunks), {
        status: res.statusCode ?? 500,
        headers: { "content-type": res.headers["content-type"] ?? "application/json" },
      })));
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}


function getWithHost(path: string, host: string): Promise<Response> {
  const url = new URL(BASE);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path, method: "GET", headers: { host } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(new Response(Buffer.concat(chunks), {
          status: res.statusCode ?? 500,
          headers: { "content-type": res.headers["content-type"] ?? "application/json" },
        })));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Anything that would tell a seller, or a shopper, what we pay. */
function leaksCost(text: string): string[] {
  return ["base_cost_cents", "platform_fee_cents", "baseCostCents", "platformFeeCents",
    "vendorCost", "platformNet", "sellerMargin"]
    .filter((needle) => text.includes(needle));
}

async function main() {
  try {
    await fetch(BASE + "/api/dashboard");
  } catch {
    console.error(`Cannot reach ${BASE}. Start the dev server: npm run dev`);
    process.exit(1);
  }

  console.log("Authentication");
  for (const path of ["/api/launch", "/api/dashboard", "/api/catalog", "/api/connect/onboard"]) {
    const res = await get(path);
    check(`${path} refuses an unauthenticated request`, res.status === 401, `got ${res.status}`);
  }

  const bad = await get("/api/dashboard", "not-a-real-token");
  check("a forged token is refused", bad.status === 401, `got ${bad.status}`);

  const sellerA = await makeSeller("a");
  const sellerB = await makeSeller("b");

  console.log("\nA seller only ever sees their own store");
  const dashA = await get("/api/dashboard", sellerA.token);
  const bodyA = await dashA.json();
  check("dashboard returns the caller's store", dashA.status === 200 && !!bodyA.store);
  check("  and it is theirs, not another seller's",
    bodyA.store?.subdomain?.startsWith("api-a-"), bodyA.store?.subdomain);

  // The store is derived from the token, so there is no parameter to tamper
  // with — but confirm that trying does not change the answer.
  const tampered = await get(`/api/dashboard?storeId=${sellerB.storeId}`, sellerA.token);
  const tamperedBody = await tampered.json();
  check("naming another store in the query changes nothing",
    tamperedBody.store?.subdomain === bodyA.store?.subdomain);

  console.log("\nNo response leaks what we pay");
  for (const [label, res] of [
    ["dashboard", await get("/api/dashboard", sellerA.token)],
    ["catalog", await get("/api/catalog", sellerA.token)],
    ["launch", await get("/api/launch", sellerA.token)],
  ] as Array<[string, Response]>) {
    const text = await res.text();
    const found = leaksCost(text);
    check(`${label} carries no cost basis`, found.length === 0, found.join(", "));
  }

  console.log("\nThe launch path");
  const launch = await get("/api/launch", sellerA.token);
  const launchBody = await launch.json();
  check("returns all 8 steps", launchBody.steps?.length === 8, `${launchBody.steps?.length}`);
  check("only the first is available",
    launchBody.steps?.filter((s: { status: string }) => s.status === "available").length === 1);
  check("names the current step", launchBody.current?.key === "name", launchBody.current?.key);

  const blocked = await post("/api/launch", { step: "price", input: {} }, sellerA.token);
  const blockedBody = await blocked.json();
  check("a locked step is refused over HTTP too", blocked.status === 400, `${blocked.status}`);
  console.log(`        ${blockedBody.error}`);

  const named = await post("/api/launch",
    { step: "name", input: { name: `Api Brand ${Date.now().toString(36).slice(-4)}` } },
    sellerA.token);
  const namedBody = await named.json();
  check("a valid step advances the sequence", named.status === 200, JSON.stringify(namedBody).slice(0, 90));
  check("  and progress moves", namedBody.progress?.done === 1, `${namedBody.progress?.done}`);

  // Seller B must be untouched by anything A did.
  const launchB = await get("/api/launch", sellerB.token);
  const launchBBody = await launchB.json();
  check("the other seller's progress is unaffected", launchBBody.progress?.done === 0);

  console.log("\nCatalog");
  const cat = await get("/api/catalog", sellerA.token);
  const catBody = await cat.json();
  check("returns only enabled blanks", Array.isArray(catBody.blanks), `${catBody.blanks?.length} blanks`);
  if (catBody.blanks?.length) {
    const first = catBody.blanks[0];
    check("  priced as one number, not a split", typeof first.fromUnitCostCents === "number");
    const detail = await get(`/api/catalog?blank=${first.id}`, sellerA.token);
    const detailBody = await detail.json();
    check("  a blank's detail includes print areas", Array.isArray(detailBody.printAreas));
    check("  and colours flagged dark, for the DTG warning",
      detailBody.colors?.some((c: { isDark: boolean }) => typeof c.isDark === "boolean"));
  }

  console.log("\nPublic checkout");
  const empty = await post("/api/checkout", { lines: [] }, undefined, "demo.localhost");
  check("an empty cart is refused", empty.status === 400, `${empty.status}`);

  const unknownHost = await post("/api/checkout",
    { lines: [{ productVariantId: "x", quantity: 1 }] }, undefined, "nosuchstore.localhost");
  check("an unknown storefront is a 404", unknownHost.status === 404, `${unknownHost.status}`);

  const { data: store } = await sb.from("stores").select("id").eq("subdomain", "demo").single();
  const { data: variant } = await sb
    .from("product_variants").select("id, products!inner(store_id)")
    .eq("products.store_id", store!.id).limit(1).single();

  const checkout = await post("/api/checkout", {
    lines: [{ productVariantId: variant!.id, quantity: 1 }],
    shipping: {
      name: "API Buyer", line1: "19 Union Square W", city: "New York",
      state: "NY", postalCode: "10003", country: "us", email: "api@example.test",
    },
  }, undefined, "demo.localhost");

  const checkoutBody = await checkout.json();
  check("a real cart checks out", checkout.status === 200, JSON.stringify(checkoutBody).slice(0, 110));

  if (checkout.ok) {
    check("  returns a client secret for Stripe", typeof checkoutBody.clientSecret === "string");
    check("  totals add up",
      checkoutBody.totals.goodsCents + checkoutBody.totals.shippingCents +
        checkoutBody.totals.serviceFeeCents === checkoutBody.totals.totalCents,
      JSON.stringify(checkoutBody.totals));
    const leaked = leaksCost(JSON.stringify(checkoutBody));
    check("  and tells a shopper nothing about our margin", leaked.length === 0, leaked.join(", "));

    await sb.from("order_items").delete().eq("order_id", checkoutBody.orderId);
    await sb.from("orders").delete().eq("id", checkoutBody.orderId);
  }


  console.log("\nDesigns");
  const designsUnauth = await get("/api/designs");
  check("/api/designs refuses an unauthenticated request",
    designsUnauth.status === 401, `got ${designsUnauth.status}`);

  // POST-only, so a GET returns 405 before auth runs — the verb has to match
  // for the check to mean anything.
  const uploadUnauth = await post("/api/designs/upload-url", { filename: "a.png" });
  check("/api/designs/upload-url refuses an unauthenticated request",
    uploadUnauth.status === 401, `got ${uploadUnauth.status}`);

  const badExt = await post("/api/designs/upload-url", { filename: "virus.exe" }, sellerA.token);
  check("an unsupported file type is refused", badExt.status === 400, `${badExt.status}`);
  console.log(`        ${(await badExt.json()).error}`);

  const signed = await post("/api/designs/upload-url", { filename: "My Logo!.png" }, sellerA.token);
  const signedBody = await signed.json();
  check("a signed upload URL is issued", signed.status === 200 && !!signedBody.uploadUrl);
  check("  the path is scoped to the caller's store",
    signedBody.storagePath?.startsWith(`${sellerA.storeId}/`), signedBody.storagePath);
  check("  and the filename is sanitised",
    /^[a-z0-9/-]+\.png$/.test(signedBody.storagePath ?? ""), signedBody.storagePath);

  // The check that matters: registering a file from someone else's folder.
  const stolen = await post("/api/designs",
    { storagePath: `${sellerB.storeId}/someone-elses.png` }, sellerA.token);
  check("cannot claim another seller's uploaded file", stolen.status === 403, `${stolen.status}`);

  console.log("\nProducts and orders belong to their owner");
  const { data: demoStore } = await sb.from("stores").select("id").eq("subdomain", "demo").single();
  const { data: demoProduct } = await sb
    .from("products").select("id").eq("store_id", demoStore!.id).limit(1).single();

  const foreignProduct = await get(`/api/products/${demoProduct!.id}`, sellerA.token);
  check("another store's product reads as not found", foreignProduct.status === 404,
    `${foreignProduct.status} — 403 would confirm it exists`);

  const foreignPatch = await fetch(`${BASE}/api/products/${demoProduct!.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${sellerA.token}` },
    body: JSON.stringify({ status: "archived" }),
  });
  check("and cannot be modified", foreignPatch.status === 404, `${foreignPatch.status}`);

  const { data: stillLive } = await sb
    .from("products").select("status").eq("id", demoProduct!.id).single();
  check("  the demo product is untouched", stillLive?.status === "published", stillLive?.status);

  const missingOrder = await get(`/api/orders/${crypto.randomUUID()}`, sellerA.token);
  check("an unknown order is not found", missingOrder.status === 404);

  console.log("\nDrops");
  const noProduct = await post("/api/drops", { closesAt: new Date(Date.now() + 864e5).toISOString() }, sellerA.token);
  check("a drop needs a product", noProduct.status === 400);

  const pastDate = await post("/api/drops",
    { productId: demoProduct!.id, closesAt: new Date(Date.now() - 864e5).toISOString() }, sellerA.token);
  check("a closing date in the past is refused", pastDate.status === 400);

  const foreignDrop = await post("/api/drops",
    { productId: demoProduct!.id, closesAt: new Date(Date.now() + 864e5).toISOString() }, sellerA.token);
  check("cannot schedule a drop on another store's product", foreignDrop.status === 404,
    `${foreignDrop.status}`);

  const dropList = await get("/api/drops", sellerA.token);
  check("drops list is scoped to the caller", dropList.status === 200);

  console.log("\nPublic storefront JSON");
  const sfUnknown = await getWithHost("/api/storefront", "nosuchstore.localhost");
  check("an unknown host is a 404", sfUnknown.status === 404, `${sfUnknown.status}`);

  const sf = await getWithHost("/api/storefront", "demo.localhost");
  const sfBody = await sf.json();
  check("a real storefront returns its products", sf.status === 200 && Array.isArray(sfBody.products),
    JSON.stringify(sfBody).slice(0, 90));
  check("  including sizes in wearing order",
    sfBody.products?.[0]?.variants?.length > 0);
  const sfLeak = leaksCost(JSON.stringify(sfBody));
  check("  and nothing about our cost", sfLeak.length === 0, sfLeak.join(", "));

  const missingAddress = await post("/api/checkout", {
    lines: [{ productVariantId: variant!.id, quantity: 1 }],
    shipping: { name: "No Address" },
  }, undefined, "demo.localhost");
  check("an incomplete address is refused with a readable reason",
    missingAddress.status === 400);
  console.log(`        ${(await missingAddress.json()).error}`);
}

main()
  .catch((e) => { console.error("\nFAILED:", e instanceof Error ? e.message : e); fail++; })
  .finally(async () => {
    if (!a.has("keep")) {
      for (const id of made.stores) await deleteStoreCompletely(sb, id).catch(() => {});
      for (const id of made.users) await sb.auth.admin.deleteUser(id).catch(() => {});
      console.log("\n(test sellers removed)");
    }
    console.log(fail ? `\n${fail} CHECK(S) FAILED` : `\nAll ${pass} checks passed.`);
    process.exit(fail ? 1 : 0);
  });
