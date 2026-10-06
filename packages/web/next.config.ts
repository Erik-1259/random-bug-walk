import type { NextConfig } from "next";

const config: NextConfig = {
  // The record packages read their schema files next to their sources at load time, so Node
  // loads them from the workspace instead of the bundler.
  serverExternalPackages: ["@rbw/schema", "@rbw/admission"],
  poweredByHeader: false,
};

export default config;
