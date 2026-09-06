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

/**
 * Decoration codes are stored as an array and were being rendered straight
 * out, which concatenated into "dtgembroiderydtf" on screen. These are the
 * names a seller would recognise.
 */
const DECORATION_LABELS: Record<string, string> = {
  dtg: "Direct-to-garment print",
  dtf: "Transfer print",
  screen_print: "Screen print",
  embroidery: "Embroidery",
  applique: "Appliqué",
  sublimation: "Sublimation",
};

function decorationLabel(codes: string[] | null): string {
  return (codes ?? [])
    .map((c) => DECORATION_LABELS[c] ?? c)
    .join(" · ");
}

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
          .select("id, brand, model, display_name, garment_type, description, supported_decoration, image_url, is_enabled")
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
        name: blank.data.display_name || blank.data.model,
        garmentType: blank.data.garment_type,
        decorationLabel: decorationLabel(blank.data.supported_decoration),
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
      .select("id, brand, model, display_name, garment_type, supported_decoration, image_url")
      .eq("is_enabled", true)
      .order("brand");

    const ids = (blanks ?? []).map((b) => b.id);

    // Paged deliberately. PostgREST caps a response at 1000 rows by default,
    // and an unpaged fetch silently returned exactly 1000 — enough for six of
    // twelve blanks, so half the catalog showed no price at all and nothing
    // errored. Enabled blanks alone hold well over 2,000 variants.
    const cheapest = new Map<string, number>();
    const PAGE = 1000;

    for (let from = 0; ; from += PAGE) {
      const { data: page, error: pageError } = await sb
        .from("catalog_variants")
        .select("blank_id, base_cost_cents")
        .in("blank_id", ids)
        .range(from, from + PAGE - 1);

      if (pageError) throw pageError;
      if (!page?.length) break;

      for (const v of page) {
        const current = cheapest.get(v.blank_id);
        if (current === undefined || v.base_cost_cents < current) {
          cheapest.set(v.blank_id, v.base_cost_cents);
        }
      }

      if (page.length < PAGE) break;
    }

    return Response.json({
      blanks: (blanks ?? []).map((b) => ({
        id: b.id,
        brand: b.brand,
        model: b.model,
        // "Unisex Staple T-Shirt" rather than "3001". Falls back to the model
        // for anything cached before the catalogue was re-synced.
        name: b.display_name || b.model,
        garmentType: b.garment_type,
        decoration: b.supported_decoration,
        // Already joined and readable. Rendering the raw array concatenated
        // gave "dtgembroiderydtf" on screen.
        decorationLabel: decorationLabel(b.supported_decoration),
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
