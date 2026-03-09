import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "aacyn — Infrastructure Monitoring",
  description:
    "5 million events per second on consumer hardware. No cloud cluster. No Kafka. One box.",
  icons: {
    icon: "/favicon.png",
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title: "aacyn — Infrastructure Monitoring",
    description:
      "5 million events per second on consumer hardware. No cloud cluster. No Kafka. One box.",
    url: "https://aacyn.com",
    siteName: "aacyn",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "aacyn — 5 million events per second. One box.",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "aacyn — Infrastructure Monitoring",
    description:
      "5 million events per second on consumer hardware. No cloud cluster. No Kafka. One box.",
    images: ["/og-image.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
