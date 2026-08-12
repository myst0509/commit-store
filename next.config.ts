import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Storefronts are served from *.ourdomain.com and from custom domains, and
  // product imagery is fetched from Printful's CDN and Supabase Storage. Both
  // hosts have to be allowed explicitly before next/image will serve them.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "files.cdn.printful.com" },
      { protocol: "https", hostname: "*.supabase.co" },
    ],
  },
};

export default nextConfig;
