import { errorResponse, requireSeller } from "@/lib/auth/session";
import { PLATFORM_FEE_CENTS } from "@/lib/pricing";
import { serviceClient } from "@/lib/supabase/client";

/**
 * The blanks a seller can build on.
 *
 * Reads with the service role and returns `unitCostCents` — vendor base plus
 * our fee, as one number. The two components are never sent. That is the same
 * rule migration 0002 enforces at the database, applied again here because the
 * service role bypasses it.
 *
 * Only enabled blanks. The catalog holds 167; what a seller sees is whatever
 * has been deliberately curated, because 167 choices in front of someone
 * starting their first label is a maze rather than a catalogue.
 */

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    await requireSeller(req);
    const sb = serviceClient();
    const url = new URL(req.url);
    const blankId = url.searchParams.get("blank");

    // One blank, in full — colours, sizes and print areas for the design tool.
    if (blankId) {
      const [blank, colors, placements, variants] = await Promise.all([
        sb.from("catalog_blanks")
          .select("id, brand, model, description, supported_decoration, image_url, is_enabled")
          .eq("id", blankId).single(),
        sb.from("catalog_colors").select("name, hex, is_dark").eq("blank_id", blankId),
        sb.from("catalog_placements")
          .select("code, width_in, height_in, min_dpi").eq("blank_id", blankId),
        sb.from("catalog_variants")
          .select("id, color, size, in_stock, base_cost_cents").eq("blank_id", blankId),
      ]);

      if (!blank.data?.is_enabled) {
        return Response.json({ error: "That blank is not available" }, { status: 404 });
      }

      const rows = variants.data ?? [];

      return Response.json({
        id: blank.data.id,
        brand: blank.data.brand,
        model: blank.data.model,
        description: blank.data.description,
        decoration: blank.data.supported_decoration,
        imageUrl: blank.data.image_url,
        colors: (colors.data ?? []).map((c) => ({
          name: c.name, hex: c.hex,
          // Drives the design tool's warning about DTG on darks.
          isDark: c.is_dark,
        })),
        printAreas: (placements.data ?? []).map((p) => ({
          placement: p.code,
          widthIn: Number(p.width_in),
          heightIn: Number(p.height_in),
          minDpi: p.min_dpi,
        })),
        variants: rows.map((v) => ({
          id: v.id, color: v.color, size: v.size, inStock: v.in_stock,
          // Base + fee, collapsed. Never the split.
          unitCostCents: v.base_cost_cents + PLATFORM_FEE_CENTS,
        })),
      });
    }

    // The list.
    const { data: blanks } = await sb
      .from("catalog_blanks")
      .select("id, brand, model, supported_decoration, image_url")
      .eq("is_enabled", true)
      .order("brand");

    const ids = (blanks ?? []).map((b) => b.id);
    const { data: variants } = await sb
      .from("catalog_variants")
      .select("blank_id, base_cost_cents")
      .in("blank_id", ids);

    const cheapest = new Map<string, number>();
    for (const v of variants ?? []) {
      const current = cheapest.get(v.blank_id);
      if (current === undefined || v.base_cost_cents < current) {
        cheapest.set(v.blank_id, v.base_cost_cents);
      }
    }

    return Response.json({
      blanks: (blanks ?? []).map((b) => ({
        id: b.id,
        brand: b.brand,
        model: b.model,
        decoration: b.supported_decoration,
        imageUrl: b.image_url,
        fromUnitCostCents: cheapest.has(b.id)
          ? cheapest.get(b.id)! + PLATFORM_FEE_CENTS
          : null,
      })),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
