import "./globals.css";
import { Inter } from "next/font/google";
import Analytics from "@/components/Analytics";

export const metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  title: {
    default: "discord-magiceden-tracker",
    template: "%s | discord-magiceden-tracker"
  },
  description: "simple node.js project to track sell/buy/listings from magiceden, sending notifications to discord",
  alternates: {
    canonical: "/"
  }
};

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${inter.variable} min-h-screen font-sans antialiased p-8`}>
        <div className="max-w-3xl mx-auto">{children}</div>
        <Analytics />
      </body>
    </html>
  );
}
