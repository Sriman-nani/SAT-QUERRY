import type { Plugin } from "vite";
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

function analyzeApiPlugin(): Plugin {
  return {
    name: "satquery:analyze-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathOnly = (req.url ?? "").split("?", 1)[0] ?? "";
        if (pathOnly !== "/api/analyze" || req.method !== "POST") {
          next();
          return;
        }
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const bodyText = Buffer.concat(chunks).toString("utf8");
          const payload = JSON.parse(bodyText || "{}");
          const mod = (await server.ssrLoadModule("/src/lib/analyze.server.ts")) as {
            runAnalyzeServer: (data: unknown) => Promise<unknown>;
          };
          const result = await mod.runAnalyzeServer(payload);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(result));
        } catch (err) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(
            JSON.stringify({
              ok: false,
              error: err instanceof Error ? err.message : "Analyze request failed",
            }),
          );
        }
      });
    },
  };
}

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    allowedHosts: true,
  },
  preview: {
    host: "0.0.0.0",
    port: 3000,
  },
  resolve: { tsconfigPaths: true },
  plugins: [analyzeApiPlugin(), tailwindcss(), viteReact()],
});
