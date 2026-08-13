import { cache } from "react";

import { compareSizes } from "@/lib/size";
import { publicClient } from "@/lib/supabase/client";

/**
 * Storefront reads. All of these go through the publishable key, so RLS decides
 * what is visible: published products, of active stores, with enabled variants.
 * There is deliberately no `status` filtering duplicated in application code —
 * if a policy is wrong, that should show up as missing data, not be papered over
 * here.
 */

export interface StorefrontProductSummary {
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  blank: string;
  priceCentsFrom: number | null;
}

export interface StorefrontProduct extends StorefrontProductSummary {
  description: string | null;
  variants: Array<{
    id: string;
    color: string;
    size: string;
    priceCents: number;
    inStock: boolean;
  }>;
}

export const listProducts = cache(
  async (storeId: string): Promise<StorefrontProductSummary[]> => {
    const sb = publicClient();

    const { data, error } = await sb
      .from("products")
      .select(
        `id, name, slug,
         catalog_blanks ( brand, model, image_url ),
         product_variants ( retail_price_cents, is_enabled )`,
      )
      .eq("store_id", storeId)
      .eq("status", "published")
      .order("created_at", { ascending: false });

    if (error || !data) return [];

    return data.map((p) => {
      const blank = first(p.catalog_blanks);
      const prices = (p.product_variants ?? [])
        .filter((v: { is_enabled: boolean }) => v.is_enabled)
        .map((v: { retail_price_cents: number }) => v.retail_price_cents);

      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        imageUrl: blank?.image_url ?? null,
        blank: [blank?.brand, blank?.model].filter(Boolean).join(" ").trim(),
        priceCentsFrom: prices.length ? Math.min(...prices) : null,
      };
    });
  },
);

export const getProduct = cache(
  async (storeId: string, slug: string): Promise<StorefrontProduct | null> => {
    const sb = publicClient();

    const { data, error } = await sb
      .from("products")
      .select(
        `id, name, slug, description,
         catalog_blanks ( brand, model, image_url ),
         product_variants (
           id, retail_price_cents, is_enabled,
           catalog_variants ( color, size, in_stock )
         )`,
      )
      .eq("store_id", storeId)
      .eq("slug", slug)
      .eq("status", "published")
      .maybeSingle();

    if (error || !data) return null;

    const blank = first(data.catalog_blanks);

    const variants = (data.product_variants ?? [])
      .filter((v: { is_enabled: boolean }) => v.is_enabled)
      .map((v: VariantRow) => {
        const cv = first(v.catalog_variants);
        return {
          id: v.id,
          color: cv?.color ?? "",
          size: cv?.size ?? "",
          priceCents: v.retail_price_cents,
          inStock: cv?.in_stock ?? false,
        };
      })
      // Colour groups the picker; size orders within it. Sorting sizes as plain
      // strings puts XS after L, which is why compareSizes exists.
      .sort((a, b) => a.color.localeCompare(b.color) || compareSizes(a.size, b.size));

    return {
      id: data.id,
      name: data.name,
      slug: data.slug,
      description: data.description,
      imageUrl: blank?.image_url ?? null,
      blank: [blank?.brand, blank?.model].filter(Boolean).join(" ").trim(),
      priceCentsFrom: variants.length ? Math.min(...variants.map((v) => v.priceCents)) : null,
      variants,
    };
  },
);

/* PostgREST returns an embedded to-one relation as either an object or a
 * single-element array depending on how it infers the relationship. Normalizing
 * once here keeps that quirk out of the components. */
function first<T>(rel: T | T[] | null | undefined): T | undefined {
  if (!rel) return undefined;
  return Array.isArray(rel) ? rel[0] : rel;
}

interface VariantRow {
  id: string;
  retail_price_cents: number;
  is_enabled: boolean;
  catalog_variants: { color: string; size: string; in_stock: boolean } | Array<{
    color: string;
    size: string;
    in_stock: boolean;
  }> | null;
}
