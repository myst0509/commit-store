/**
 * Provider registry and routing.
 *
 * Application code calls getProvider() or routeForProduct(). It never imports
 * a vendor adapter directly.
 */

import type {
  DecorationMethod,
  FulfillmentProvider,
  ProviderId,
} from "./types";
import { PrintfulProvider } from "./printful";
import { ApliiqProvider } from "./apliiq";

let registry: Map<ProviderId, FulfillmentProvider> | null = null;

function getRegistry(): Map<ProviderId, FulfillmentProvider> {
  if (registry) return registry;

  registry = new Map();
  registry.set("printful", new PrintfulProvider());

  // Apliiq's API was never broken — see lib/fulfillment/apliiq.ts. Its catalog
  // is verified working; its order path is not.
  //
  // CAUTION: routeForProduct below prefers Apliiq for private label, and its
  // quoteShipping/estimateCost/cancelOrder throw because Apliiq does not
  // publish those endpoints. Nothing reaches them today — no product sets
  // privateLabel — but do not enable private-label products until they exist.
  registry.set("apliiq", new ApliiqProvider());

  return registry;
}

export function getProvider(id: ProviderId): FulfillmentProvider {
  const p = getRegistry().get(id);
  if (!p) throw new Error(`Provider not enabled: ${id}`);
  return p;
}

export function enabledProviders(): FulfillmentProvider[] {
  return [...getRegistry().values()];
}

/**
 * Pick a provider for a product's requirements.
 *
 * Routing intent once both vendors are live:
 *   - private label or embroidery  -> Apliiq (better finishing, core to positioning)
 *   - everything else              -> Printful (faster, more reliable)
 *
 * Falls back to any provider that satisfies the requirements. Throws if none do,
 * rather than silently downgrading the product — a seller who ordered a neck tag
 * must not receive a garment without one.
 */
export function routeForProduct(req: {
  decoration: DecorationMethod;
  privateLabel: boolean;
}): FulfillmentProvider {
  const candidates = enabledProviders().filter((p) => {
    const c = p.capabilities();
    if (!c.decorationMethods.includes(req.decoration)) return false;
    if (req.privateLabel && !c.privateLabel) return false;
    return true;
  });

  if (candidates.length === 0) {
    throw new Error(
      `No enabled provider supports decoration=${req.decoration} privateLabel=${req.privateLabel}`,
    );
  }

  const preference: ProviderId[] = req.privateLabel
    ? ["apliiq", "printful"]
    : ["printful", "apliiq"];

  for (const id of preference) {
    const match = candidates.find((p) => p.id === id);
    if (match) return match;
  }
  return candidates[0];
}

/**
 * DTG on dark garments is the most common print-quality complaint across every
 * POD vendor. Sellers should never be able to select that combination.
 */
export function forceDecorationForColor(
  requested: DecorationMethod,
  colorIsDark: boolean,
  supported: DecorationMethod[],
): DecorationMethod {
  if (requested !== "dtg" || !colorIsDark) return requested;
  for (const alt of ["dtf", "screen_print"] as DecorationMethod[]) {
    if (supported.includes(alt)) return alt;
  }
  return requested;
}

export * from "./types";
