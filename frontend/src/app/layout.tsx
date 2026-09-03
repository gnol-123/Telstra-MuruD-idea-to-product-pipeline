import type { Metadata } from "next";
import "./globals.css";
/* warpper for every page, imports global css, */

export const metadata: Metadata = {
  title: "Sidekick — Telstra Muru-D Team 2",
  description: "Idea-to-prototype build workspace",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="font-sans">{children}</body>
    </html>
  );
}
