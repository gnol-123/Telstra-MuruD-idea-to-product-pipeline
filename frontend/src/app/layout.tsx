import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Mesh — Telstra Muru-D Team 2",
  description: "Canvas of agent and tool nodes for the idea-to-prototype pipeline",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
