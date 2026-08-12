import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Commit",
  description: "Start your clothing brand. No subscription, no cut of your sales.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
