import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  // Cloudflare Pages serves from aacyn.com root, no basePath needed.
  // All API calls use absolute URLs to NEXT_PUBLIC_AACYN_API_URL.
  images: { unoptimized: true },
};

export default nextConfig;
