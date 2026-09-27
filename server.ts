import { createServer as createHttpServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const isDevFlag = process.argv.includes("--dev");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const SYSTEM = `You are SatQuery AI, a vision-language model (VLM) for Earth observation and satellite image extraction.
Every turn is a VLM query: the attached satellite image(s) are primary evidence; text is the user's request.
CRITICAL RULE: Whenever the user asks about ANY object, feature, land class, structure, or phenomenon in the image, you MUST locate all visible instances of it, highlight them by returning their normalized bounding boxes [x, y, width, height] in "detections" with clear labels matching what the user asked for, set "highlightedTarget" to the name of what was requested, and directly present the findings to the user.
Reply with ONLY compact JSON:
{
  "answer": "plain language answer (2-5 sentences) confirming what was highlighted and extracted for the user",
  "sceneSummary": "one line summary",
  "highlightedTarget": "name of the highlighted feature/object requested by the user",
  "intent": "detect" | "segment" | "stats" | "change" | "describe",
  "detections": [{"id":"d1","label":"building","confidence":0.89,"bbox":[0.12,0.24,0.06,0.08]}],
  "segments": [{"label":"vegetation","coveragePct":34.2,"color":"#4a8a5a"}],
  "statistics": [{"name":"Highlighted count","value":"12","hint":"matched regions"}],
  "change": {"percent":12.4,"summary":"...","regions":[{"label":"clearing","bbox":[0.2,0.3,0.1,0.1]}]}
}
bbox is normalized [x,y,width,height] (0..1) from the top-left of the PRIMARY image.
Ground every claim in what is visible. Use client land-cover stats as a prior; do not invent wildly different percentages.
Always return at least 3-16 accurate bounding boxes in "detections" for whatever the user asked to find, highlight, or inspect. If two images, first is BEFORE and second is AFTER.
No markdown.`;

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1] || "image/jpeg", data: match[2] || "" };
}

function normalizeParsedResult(parsed: Record<string, unknown>, fallbackText: string) {
  const rawDetections = Array.isArray(parsed.detections) ? parsed.detections : [];
  const detections = rawDetections
    .filter((d: unknown) => {
      const item = d as { bbox?: unknown };
      return Array.isArray(item?.bbox) && item.bbox.length === 4;
    })
    .slice(0, 24)
    .map((d: unknown, i: number) => {
      const item = d as {
        id?: string;
        label?: string;
        confidence?: number;
        bbox: number[];
      };
      return {
        id: item.id || `m${i + 1}`,
        label: String(item.label || parsed.highlightedTarget || "highlighted region"),
        confidence: Number(item.confidence ?? 0.82),
        bbox: [
          Math.max(0, Math.min(0.96, Number(item.bbox[0]) || 0)),
          Math.max(0, Math.min(0.96, Number(item.bbox[1]) || 0)),
          Math.max(0.02, Math.min(1, Number(item.bbox[2]) || 0.08)),
          Math.max(0.02, Math.min(1, Number(item.bbox[3]) || 0.08)),
        ],
        source: "model",
        highlighted: true,
      };
    });

  return {
    answer: String(parsed.answer || fallbackText.slice(0, 1200) || "Highlighted the requested regions on the scene."),
    sceneSummary: parsed.sceneSummary ? String(parsed.sceneSummary) : undefined,
    highlightedTarget: parsed.highlightedTarget ? String(parsed.highlightedTarget) : undefined,
    intent: (parsed.intent as string) ?? "detect",
    detections,
    segments: Array.isArray(parsed.segments) ? parsed.segments.slice(0, 8) : [],
    statistics: Array.isArray(parsed.statistics) ? parsed.statistics.slice(0, 12) : [],
    change: parsed.change,
  };
}

async function handleAnalyzePayload(data: {
  question?: string;
  images?: { name: string; dataUrl: string; role: string }[];
  localStats?: {
    percents?: Record<string, number>;
    detectionCount?: number;
    changePercent?: number;
    changeSummary?: string;
    targetLabel?: string;
  };
  history?: { role: string; text: string }[];
}) {
  const historyBlock = (data.history ?? [])
    .slice(-6)
    .map((m) => `${m.role}: ${m.text}`)
    .join("\n");

  const promptText = `[VLM query]
Analyze the attached satellite image(s) with a vision-language model. Locate and highlight what the user asked about, returning bounding boxes [x, y, width, height] so we can highlight them on the map and extract cutouts for the user.

Image names: ${(data.images ?? []).map((i) => `${i.role}=${i.name}`).join(", ")}
Target requested by user: ${data.localStats?.targetLabel ?? data.question ?? ""}
Client land cover %: ${JSON.stringify(data.localStats?.percents ?? {})}
Local object proposals: ${data.localStats?.detectionCount ?? 0}
${data.localStats?.changePercent != null ? `Pixel change: ${data.localStats.changePercent.toFixed(1)}%. ${data.localStats.changeSummary ?? ""}` : "Single image (no before pair)."}
Prior turns:
${historyBlock || "(none)"}
User question: ${data.question ?? ""}`;

  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    const ai = new GoogleGenAI({
      apiKey: geminiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
    const parts: Array<{ inlineData: { mimeType: string; data: string } } | { text: string }> = [];
    for (const img of data.images ?? []) {
      const inline = parseDataUrl(img.dataUrl);
      if (inline) {
        parts.push({ inlineData: inline });
      }
    }
    parts.push({ text: promptText });

    const candidateModels = ["gemini-3.8-flash", "gemini-flash-latest", "gemini-2.5-flash"];
    for (const modelName of candidateModels) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: { parts },
          config: {
            systemInstruction: SYSTEM,
            temperature: 0.2,
            responseMimeType: "application/json",
          },
        });

        const text = response.text ?? "";
        const parsed = extractJson(text);
        if (parsed?.answer) {
          return {
            ok: true,
            analysis: normalizeParsedResult(parsed, text),
          };
        }
      } catch {
        // Try next candidate model
      }
    }
  }

  return { ok: false, error: "Using fast on-image spectral highlight & extraction engine" };
}

async function startServer() {
  const distDir = join(__dirname, "dist");
  const useViteDev = isDevFlag || !existsSync(join(distDir, "index.html"));

  let vite: { middlewares: (req: unknown, res: unknown, next: () => void) => void } | null = null;
  if (useViteDev) {
    const { createServer: createViteServer } = await import("vite");
    vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
  }

  const server = createHttpServer(async (req, res) => {
    const urlPath = (req.url ?? "/").split("?")[0] ?? "/";

    if (urlPath === "/api/analyze" && req.method === "POST") {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const bodyText = Buffer.concat(chunks).toString("utf8");
        const payload = JSON.parse(bodyText || "{}");
        const result = await handleAnalyzePayload(payload);
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
      return;
    }

    if (vite) {
      vite.middlewares(req, res, () => {
        res.statusCode = 404;
        res.end("Not Found");
      });
      return;
    }

    const safeRel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.(\/|\\|$))+/, "");
    let candidate = join(distDir, safeRel === "/" ? "index.html" : safeRel);
    if (!existsSync(candidate) || statSync(candidate).isDirectory()) {
      candidate = join(distDir, "index.html");
    }

    if (existsSync(candidate)) {
      const ext = extname(candidate).toLowerCase();
      res.statusCode = 200;
      res.setHeader("Content-Type", MIME_TYPES[ext] || "application/octet-stream");
      res.end(readFileSync(candidate));
      return;
    }

    res.statusCode = 404;
    res.end("Not Found");
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`SatQuery AI server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
