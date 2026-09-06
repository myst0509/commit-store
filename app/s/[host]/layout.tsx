import { notFound } from "next/navigation";

import { resolveStore, themeStyle } from "@/lib/store/resolve";
import { SOCIAL_PLATFORMS, socialUrl, type SocialPlatform } from "@/lib/store/settings";

/** What each handle is called on the storefront. */
const SOCIAL_LABELS: Record<string, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  x: "X",
  website: "Website",
};

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

  // Handles are stored, never URLs, so the destination is built here. A seller
  // cannot label a link "Instagram" and point it somewhere else.
  const links = SOCIAL_PLATFORMS
    .filter((p) => store.social[p])
    .map((p) => ({
      label: SOCIAL_LABELS[p] ?? p,
      href: socialUrl(p as SocialPlatform, store.social[p]),
    }));

  if (store.social.website) {
    links.push({ label: SOCIAL_LABELS.website, href: store.social.website });
  }

  return (
    <div style={themeStyle(store.theme)} className="min-h-screen">
      <header className="border-b border-black/10">
        <div className="mx-auto max-w-5xl px-6 py-5">
          <a href="/" className="text-lg font-semibold tracking-tight">
            {store.name}
          </a>
        </div>
      </header>

      {/* The seller wrote this in the guide's "Say who you are" step. Before
          this it was stored and never shown, which made the step pointless. */}
      {store.bio && (
        <section className="mx-auto max-w-5xl px-6 pt-10">
          <p className="max-w-2xl text-base leading-relaxed text-[var(--store-muted)]">
            {store.bio}
          </p>
        </section>
      )}

      {children}

      <footer className="mt-24 border-t border-black/10">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-8 text-sm text-[var(--store-muted)] sm:flex-row sm:items-center sm:justify-between">
          <span>{store.name}</span>

          {links.length > 0 && (
            <nav className="flex flex-wrap gap-x-5 gap-y-2">
              {links.map((l) => (
                <a
                  key={l.label}
                  href={l.href}
                  target="_blank"
                  // noopener because these point off-site to somewhere the
                  // seller chose; noreferrer keeps the customer's browsing off
                  // the destination's analytics.
                  rel="noopener noreferrer nofollow"
                  className="underline underline-offset-4 hover:no-underline"
                >
                  {l.label}
                </a>
              ))}
            </nav>
          )}
        </div>
      </footer>
    </div>
  );
}
