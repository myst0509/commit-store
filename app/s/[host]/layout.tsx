import { notFound } from "next/navigation";

import { resolveStore, themeStyle } from "@/lib/store/resolve";

export default async function StorefrontLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ host: string }>;
}) {
  const { host } = await params;
  const store = await resolveStore(decodeURIComponent(host));

  // An unclaimed host is a 404, not a redirect to our marketing site. A parked
  // custom domain should look empty, not like it belongs to someone else.
  if (!store) notFound();

  return (
    <div style={themeStyle(store.theme)} className="min-h-screen">
      <header className="border-b border-black/10">
        <div className="mx-auto max-w-5xl px-6 py-5">
          <a href="/" className="text-lg font-semibold tracking-tight">
            {store.name}
          </a>
        </div>
      </header>

      {children}

      <footer className="mt-24 border-t border-black/10">
        <div className="mx-auto max-w-5xl px-6 py-8 text-sm text-[var(--store-muted)]">
          {store.name}
        </div>
      </footer>
    </div>
  );
}
