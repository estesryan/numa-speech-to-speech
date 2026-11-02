import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Inter (Numa's typeface), self-hosted from @fontsource-variable/inter: no network at build or run time.
const inter = localFont({
  src: "../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
  variable: "--font-inter",
  weight: "100 900",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Numa — Conversation",
  description:
    "A local-first AI voice assistant: talk with Numa out loud, with every model running on your Mac.",
};

export const viewport: Viewport = {
  themeColor: "#111821",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} h-full`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
