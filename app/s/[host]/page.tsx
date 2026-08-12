import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";

import { formatUsd } from "@/lib/money";
import { listProducts } from "@/lib/store/products";
import { resolveStore } from "@/lib/store/resolve";

type Props = { params: Promise<{ host: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { host } = await params;
  const store = await resolveStore(decodeURIComponent(host));
  if (!store) return {};

  return {
    title: store.name,
    openGraph: { title: store.name, type: "website" },
  };
}

export default async function StorefrontHome({ params }: Props) {
  const { host } = await params;
  const store = await resolveStore(decodeURIComponent(host));
  if (!store) notFound();

  const products = await listProducts(store.id);

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      {products.length === 0 ? (
        <p className="text-[var(--store-muted)]">Nothing here yet.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => (
            <li key={p.id}>
              <a href={`/p/${p.slug}`} className="group block">
                <div
                  className="aspect-square overflow-hidden bg-black/5"
                  style={{ borderRadius: "var(--store-radius)" }}
                >
                  {p.imageUrl && (
                    <Image
                      src={p.imageUrl}
                      alt={p.name}
                      width={600}
                      height={600}
                      className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]"
                    />
                  )}
                </div>
                <h2 className="mt-3 font-medium">{p.name}</h2>
                <p className="text-sm text-[var(--store-muted)]">
                  {p.priceCentsFrom === null ? "Unavailable" : formatUsd(p.priceCentsFrom)}
                </p>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
