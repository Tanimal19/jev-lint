import { defineConfig, type ProxyOptions } from "vite";

// api.typesafe.ai rejects browser origins it doesn't know, so the app calls it through the dev/preview server.
const proxy: Record<string, ProxyOptions> = {
  "/jev": {
    target: "https://api.typesafe.ai",
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/jev/, ""),
    configure: (p) => p.on("proxyReq", (req) => req.removeHeader("origin")),
  },
};

export default defineConfig({ server: { proxy }, preview: { proxy } });
