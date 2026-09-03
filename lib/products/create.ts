import { UserError } from "@/lib/errors";
import { PLATFORM_FEE_CENTS } from "@/lib/pricing";
import { serviceClient } from "@/lib/supabase/client";

/**
 * Creating a product from a catalog blank.
 *
 * Lifted out of the launch path's `set_price` step, which was the only way a
 * product could ever be made. That step is presented as one rung of a
 * sequence and shows as completed afterwards, so a seller had no route to a
 * second product — a real limit for someone building a clothing label.
 *
 * Both callers share this, so the price floor and the variant fan-out cannot
 * drift apart between "first product" and "every product after it".
 *
 * Service-role only. Ownership is decided by the caller from the session.
 */

export interface CreateProductInput {
  storeId: string;
  blankId: string;
  name: string;
  retailPriceCents: number;
  designId?: string | null;
}

export interface CreatedProduct {
  productId: string;
  slug: string;
  variantCount: number;
  unitCostCents: number;
  marginCents: number;
}

export function toSlug(name: string): string {
  return name.toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "product";
}

export async function createProductFromBlank(
  input: CreateProductInput,
): Promise<CreatedProduct> {
  const sb = serviceClient();

  const blankId = String(input.blankId ?? "");
  const retailCents = Number(input.retailPriceCents);
  const productName = String(input.name ?? "").trim() || "Untitled";
  const designId = input.designId ? String(input.designId) : null;

  if (!blankId) throw new UserError("Choose a blank first");
  if (!Number.isInteger(retailCents) || retailCents <= 0) {
    throw new UserError("Price must be a whole number of cents");
  }

  const { data: variants, error: vErr } = await sb
    .from("catalog_variants")
    .select("id, base_cost_cents, color, size")
    .eq("blank_id", blankId)
    .eq("in_stock", true);

  if (vErr || !variants?.length) throw new UserError("That blank has no available variants");

  // Priced against the CHEAPEST variant, so the floor is the lowest cost the
  // product can incur. A seller pricing above this can still lose money on a
  // dearer size; that is the pricing model's problem, not this function's.
  const cheapest = Math.min(...variants.map((v) => v.base_cost_cents));
  const unitCost = cheapest + PLATFORM_FEE_CENTS;

  if (retailCents < unitCost) {
    throw new UserError(
      `At $${(retailCents / 100).toFixed(2)} you would lose money — ` +
      `this garment costs you $${(unitCost / 100).toFixed(2)}`,
    );
  }

  const slug = toSlug(productName);

  // Upsert on (store_id, slug) keeps a double-clicked button from making two
  // products. It also means reusing a name EDITS the existing product rather
  // than creating a second one, which callers must tell the seller about.
  const { data: product, error: pErr } = await sb
    .from("products")
    .upsert({
      store_id: input.storeId, blank_id: blankId,
      name: productName, slug,
      decoration: "dtg", status: "draft",
    }, { onConflict: "store_id,slug" })
    .select("id")
    .single();
  if (pErr) throw pErr;

  const { error: pvErr } = await sb.from("product_variants").upsert(
    variants.map((v) => ({
      product_id: product.id,
      catalog_variant_id: v.id,
      retail_price_cents: retailCents,
      base_cost_cents: v.base_cost_cents,
      platform_fee_cents: PLATFORM_FEE_CENTS,
      is_enabled: true,
    })),
    { onConflict: "product_id,catalog_variant_id" },
  );
  if (pvErr) throw pvErr;

  if (designId) {
    await sb.from("product_artwork").upsert({
      product_id: product.id, design_id: designId,
      placement: "front", decoration: "dtg",
    }, { onConflict: "product_id,placement" });
  }

  return {
    productId: product.id,
    slug,
    variantCount: variants.length,
    unitCostCents: unitCost,
    marginCents: retailCents - unitCost,
  };
}

/** Does this store already have a product under this name? */
export async function slugTaken(storeId: string, name: string): Promise<boolean> {
  const sb = serviceClient();
  const { data } = await sb
    .from("products")
    .select("id")
    .eq("store_id", storeId)
    .eq("slug", toSlug(name))
    .maybeSingle();
  return Boolean(data);
}
