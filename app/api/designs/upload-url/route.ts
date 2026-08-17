import { errorResponse, requireSeller } from "@/lib/auth/session";
import { serviceClient } from "@/lib/supabase/client";

/**
 * A one-time URL for uploading artwork straight to storage.
 *
 * The browser uploads to Supabase directly rather than through us. Two reasons:
 * a 40MB design would otherwise cross our servers twice for no benefit, and
 * serverless request bodies are size-capped in ways that would reject perfectly
 * valid artwork.
 *
 * The path is built here, never accepted from the caller. It is always
 * `<storeId>/<name>`, which is the same shape the storage RLS policy checks —
 * so even a signed URL cannot be pointed at another seller's folder.
 */

export const dynamic = "force-dynamic";

const ALLOWED = new Set(["png", "jpg", "jpeg", "webp", "svg"]);

export async function POST(req: Request): Promise<Response> {
  try {
    const session = await requireSeller(req);
    const body = (await req.json().catch(() => ({}))) as { filename?: string };

    const raw = (body.filename ?? "design.png").trim();
    const extension = raw.split(".").pop()?.toLowerCase() ?? "";

    if (!ALLOWED.has(extension)) {
      return Response.json(
        { error: `Use a PNG, JPG, WEBP or SVG — not .${extension || "unknown"}` },
        { status: 400 },
      );
    }

    // Sanitised, and prefixed with a random segment so two uploads of "logo.png"
    // do not overwrite each other.
    const safe = raw
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "design";

    const path = `${session.storeId}/${crypto.randomUUID().slice(0, 8)}-${safe}.${extension}`;

    const sb = serviceClient();
    const { data, error } = await sb.storage.from("artwork").createSignedUploadUrl(path);

    if (error) throw error;

    return Response.json({
      uploadUrl: data.signedUrl,
      token: data.token,
      // Send this back to POST /api/designs once the upload finishes — that is
      // where the file is actually measured and checked.
      storagePath: path,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
