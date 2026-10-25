import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.PITCHROOM_ISOLATED_QA === "1" ? ".next-qa" : ".next",
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
