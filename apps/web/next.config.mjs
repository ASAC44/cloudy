import { createMDX } from "fumadocs-mdx/next";

/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "standalone",
  turbopack: { root: process.cwd() },
};

export default createMDX()(nextConfig);
