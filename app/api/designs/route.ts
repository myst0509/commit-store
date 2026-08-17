import { errorResponse, requireSeller } from "@/lib/auth/session";
import { inspectArtwork, validateAgainstBlank, type PlacementSpec } from "@/lib/design/validate";
import { serviceClient } from "@/lib/supabase/client";

/**
 * Uploaded artwork.
 *
 * GET  — the seller's designs and their review status.
 * POST — records a file already in storage, after checking it is printable.
 *
 * The upload itself goes browser → Supabase Storage directly (see
 * ./upload-url), so image bytes never pass through this server. This route
 * then reads the stored file and measures it. Client-reported dimensions are
 * ignored entirely — they are trivially forged, and the consequence of
 * believing them is a blurry garment nobody can return.
 */

export const dynamic = "force-dynamic";

const REFERENCE_PLACEMENTS: PlacementSpec[] = [
  { code: "front", widthIn: 12, heightIn: 16, minDpi: 150 },
  { code: "left_chest", widthIn: 4, heightIn: 4, minDpi: 150 },
  { code: "neck_inner", widthIn: 3, heightIn: 3, minDpi: 150 },
];

export async function GET(req: Request): Promise<Response> {
  try {
    const session = await requireSeller(req);
    const sb = serviceClient();

    const { data } = await sb
      .from("designs")
      .select("id, filename, public_url, width_px, height_px, review_status, review_note, created_at")
      .eq("store_id", session.storeId)
      .order("created_at", { ascending: false });

    return Response.json({
      designs: (data ?? []).map((d) => ({
        id: d.id,
        filename: d.filename,
        url: d.public_url,
        widthPx: d.width_px,
        heightPx: d.height_px,
        // Nothing reaches a vendor unapproved — we are merchant of record, so
        // infringement claims arrive at our door.
        review: d.review_status,
        reviewNote: d.review_note,
        createdAt: d.created_at,
      })),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const session = await requireSeller(req);
    const body = (await req.json().catch(() => ({}))) as {
      storagePath?: string; filename?: string; blankId?: string;
    };

    if (!body.storagePath) {
      return Response.json({ error: "Upload the file first" }, { status: 400 });
    }

    // The path must sit under this seller's folder. Without this check a seller
    // could register someone else's uploaded artwork as their own.
    if (!body.storagePath.startsWith(`${session.storeId}/`)) {
      return Response.json({ error: "That file is not yours" }, { status: 403 });
    }

    const sb = serviceClient();
    const { data: file, error: downloadError } = await sb.storage
      .from("artwork").download(body.storagePath);

    if (downloadError || !file) {
      return Response.json({ error: "We could not read that upload" }, { status: 400 });
    }

    const facts = await inspectArtwork(Buffer.from(await file.arrayBuffer()));

    // Against the chosen blank's real print areas when one is given, otherwise
    // against a standard adult tee — enough to catch artwork unusable anywhere.
    let placements = REFERENCE_PLACEMENTS;
    if (body.blankId) {
      const { data: real } = await sb
        .from("catalog_placements")
        .select("code, width_in, height_in, min_dpi")
        .eq("blank_id", body.blankId);

      if (real?.length) {
        placements = real.map((p) => ({
          code: p.code,
          widthIn: Number(p.width_in),
          heightIn: Number(p.height_in),
          minDpi: p.min_dpi,
        }));
      }
    }

    const verdict = validateAgainstBlank(facts, placements);

    if (!verdict.ok) {
      const front = verdict.byPlacement[placements[0].code];
      return Response.json({
        error: front?.findings.find((f) => f.severity === "error")?.message
          ?? "That artwork is not printable",
        facts: { widthPx: facts.widthPx, heightPx: facts.heightPx },
      }, { status: 400 });
    }

    const { data: existing } = await sb
      .from("designs").select("id")
      .eq("store_id", session.storeId).eq("storage_path", body.storagePath).maybeSingle();

    const { data: pub } = sb.storage.from("artwork").getPublicUrl(body.storagePath);

    let designId = existing?.id;
    if (!designId) {
      const { data, error } = await sb.from("designs").insert({
        store_id: session.storeId,
        filename: body.filename ?? body.storagePath.split("/").pop() ?? "design",
        storage_path: body.storagePath,
        public_url: pub.publicUrl,
        width_px: facts.widthPx,
        height_px: facts.heightPx,
        byte_size: facts.byteSize,
        review_status: "pending",
      }).select("id").single();

      if (error) throw error;
      designId = data.id;
    }

    return Response.json({
      id: designId,
      url: pub.publicUrl,
      dimensions: { widthPx: facts.widthPx, heightPx: facts.heightPx },
      review: "pending",
      // Where it can be used, and how large it can go on each.
      usableOn: verdict.usablePlacements.map((code) => ({
        placement: code,
        maxInches: verdict.byPlacement[code].maxPrintInches,
      })),
      warnings: Object.values(verdict.byPlacement)
        .flatMap((r) => r.findings)
        .filter((f) => f.severity === "warning")
        .map((f) => f.message)
        .filter((m, i, all) => all.indexOf(m) === i),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
