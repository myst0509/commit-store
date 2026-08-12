import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";

import { formatUsd } from "@/lib/money";
import { getProduct } from "@/lib/store/products";
import { resolveStore } from "@/lib/store/resolve";

type Props = { params: Promise<{ host: string; slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { host, slug } = await params;
  const store = await resolveStore(decodeURIComponent(host));
  if (!store) return {};

  const product = await getProduct(store.id, slug);
  if (!product) return {};

  return {
    title: `${product.name} — ${store.name}`,
    description: product.description ?? undefined,
    openGraph: {
      title: product.name,
      description: product.description ?? undefined,
      images: product.imageUrl ? [product.imageUrl] : undefined,
      type: "website",
    },
  };
}

export default async function ProductPage({ params }: Props) {
  const { host, slug } = await params;
  const store = await resolveStore(decodeURIComponent(host));
  if (!store) notFound();

  const product = await getProduct(store.id, slug);
  if (!product) notFound();

  // Grouped for the picker. Colour first, since that is the choice a buyer makes
  // before size.
  const byColor = new Map<string, typeof product.variants>();
  for (const v of product.variants) {
    if (!byColor.has(v.color)) byColor.set(v.color, []);
    byColor.get(v.color)!.push(v);
  }

  return (
    <main className="mx-auto grid max-w-5xl gap-12 px-6 py-12 md:grid-cols-2">
      <div
        className="aspect-square overflow-hidden bg-black/5"
        style={{ borderRadius: "var(--store-radius)" }}
      >
        {product.imageUrl && (
          <Image
            src={product.imageUrl}
            alt={product.name}
            width={900}
            height={900}
            className="h-full w-full object-cover"
            priority
          />
        )}
      </div>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{product.name}</h1>
        {product.blank && (
          <p className="mt-1 text-sm text-[var(--store-muted)]">{product.blank}</p>
        )}

        <p className="mt-4 text-xl">
          {product.priceCentsFrom === null
            ? "Unavailable"
            : formatUsd(product.priceCentsFrom)}
        </p>

        {product.description && (
          <p className="mt-6 whitespace-pre-line text-[var(--store-muted)]">
            {product.description}
          </p>
        )}

        <div className="mt-8 space-y-4">
          {[...byColor.entries()].map(([color, variants]) => (
            <div key={color}>
              <h3 className="text-sm font-medium">{color}</h3>
              <ul className="mt-2 flex flex-wrap gap-2">
                {variants.map((v) => (
                  <li
                    key={v.id}
                    className={
                      "border px-3 py-1.5 text-sm " +
                      (v.inStock
                        ? "border-black/20"
                        : "border-black/10 text-[var(--store-muted)] line-through")
                    }
                    style={{ borderRadius: "var(--store-radius)" }}
                  >
                    {v.size}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/*
          No add-to-cart yet. Checkout is step 5 and is gated on step 2 being
          proven with a real vendor order — putting a buy button here before that
          would mean taking money for something we have never successfully
          manufactured.
        */}
        <p className="mt-10 text-sm text-[var(--store-muted)]">
          Checkout is not wired up yet.
        </p>
      </div>
    </main>
  );
}
