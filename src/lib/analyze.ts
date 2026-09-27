import { createServerFn } from "@tanstack/react-start";
import type { AnalysisResult, Detection } from "./types";

type AnalyzeInput = {
  question: string;
  images: { name: string; dataUrl: string; role: "primary" | "before" }[];
  localStats: {
    percents: Record<string, number>;
    detectionCount: number;
    changePercent?: number;
    changeSummary?: string;
  };
  history: { role: "user" | "assistant"; text: string }[];
};

let grokSkipUntil = 0;

function extractJson(text: string): Partial<AnalysisResult> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Partial<AnalysisResult>;
  } catch {
    return null;
  }
}

const SYSTEM = `You are SatQuery AI, a vision-language model (VLM) for Earth observation.
Every turn is a VLM query: the attached satellite image(s) are primary evidence; text is the question.
Reply with ONLY compact JSON:
{
  "answer": "plain language answer (2-6 sentences)",
  "sceneSummary": "one line",
  "intent": "detect" | "segment" | "stats" | "change" | "describe",
  "detections": [{"id":"d1","label":"building","confidence":0.86,"bbox":[0.1,0.2,0.05,0.08]}],
  "segments": [{"label":"vegetation","coveragePct":34.2,"color":"#4a8a5a"}],
  "statistics": [{"name":"Building count","value":"42","hint":"optional"}],
  "change": {"percent":12.4,"summary":"...","regions":[{"label":"clearing","bbox":[0.2,0.3,0.1,0.1]}]}
}
bbox is normalized [x,y,width,height] from the top-left of the PRIMARY image.
Ground every claim in what is visible. Use client land-cover stats as a prior; do not invent wildly different percentages.
Prefer fewer, high-quality detections (max 24). If two images, first is BEFORE and second is AFTER.
No markdown.`;

export const analyzeScene = createServerFn({ method: "POST" })
  .validator((input: AnalyzeInput) => input)
  .handler(async ({ data }): Promise<{ ok: true; analysis: AnalysisResult } | { ok: false; error: string }> => {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return { ok: false, error: "AI is not available in this environment" };
    if (Date.now() < grokSkipUntil) {
      return { ok: false, error: "Grok is temporarily unavailable; using on-image analysis." };
    }

    try {
      const content: unknown[] = [];
      for (const img of data.images) {
        content.push({
          type: "image_url",
          image_url: { url: img.dataUrl, detail: "high" },
        });
      }
      const historyBlock = data.history
        .slice(-6)
        .map((m) => `${m.role}: ${m.text}`)
        .join("\n");
      content.push({
        type: "text",
        text: `[VLM query]
Analyze the attached satellite image(s) with a vision-language model. Ground the answer in pixels, then in the numeric priors.

Image names: ${data.images.map((i) => `${i.role}=${i.name}`).join(", ")}
Client land cover %: ${JSON.stringify(data.localStats.percents)}
Local object proposals: ${data.localStats.detectionCount}
${data.localStats.changePercent != null ? `Pixel change: ${data.localStats.changePercent.toFixed(1)}%. ${data.localStats.changeSummary ?? ""}` : "Single image (no before pair)."}
Prior turns:
${historyBlock || "(none)"}
User question: ${data.question}`,
      });

      const res = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "grok-4.5",
          temperature: 0.2,
          max_tokens: 1800,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content },
          ],
        }),
      });

      if (!res.ok) {
        let detail = `xAI API error ${res.status}`;
        try {
          const errJson = (await res.json()) as { error?: string; code?: string };
          if (errJson.error) detail = errJson.error;
          if (res.status === 403 || String(errJson.code).includes("spending")) {
            grokSkipUntil = Date.now() + 15 * 60 * 1000;
          }
        } catch {
          if (res.status === 403) grokSkipUntil = Date.now() + 15 * 60 * 1000;
        }
        return { ok: false, error: detail };
      }

      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = body.choices?.[0]?.message?.content ?? "";
      const parsed = extractJson(text);
      if (!parsed?.answer) {
        return {
          ok: true,
          analysis: {
            answer: text.slice(0, 1200) || "The model returned an empty response.",
            intent: "describe",
            detections: [],
            segments: [],
            statistics: [],
          },
        };
      }

      const detections: Detection[] = Array.isArray(parsed.detections)
        ? parsed.detections
            .filter((d) => Array.isArray(d.bbox) && d.bbox.length === 4)
            .slice(0, 24)
            .map((d, i) => ({
              id: d.id || `m${i}`,
              label: String(d.label || "object"),
              confidence: Number(d.confidence ?? 0.7),
              bbox: d.bbox,
              source: "model" as const,
            }))
        : [];

      return {
        ok: true,
        analysis: {
          answer: String(parsed.answer),
          sceneSummary: parsed.sceneSummary ? String(parsed.sceneSummary) : undefined,
          intent: parsed.intent ?? "describe",
          detections,
          segments: Array.isArray(parsed.segments) ? parsed.segments.slice(0, 8) : [],
          statistics: Array.isArray(parsed.statistics) ? parsed.statistics.slice(0, 12) : [],
          change: parsed.change,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Vision request failed",
      };
    }
  });
