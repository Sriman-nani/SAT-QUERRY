import { GoogleGenAI } from "@google/genai";
import type { AnalysisResult, Detection } from "./types";

export type AnalyzeInput = {
  question: string;
  images: { name: string; dataUrl: string; role: "primary" | "before" }[];
  localStats: {
    percents: Record<string, number>;
    detectionCount: number;
    changePercent?: number;
    changeSummary?: string;
    targetLabel?: string;
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

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1] || "image/jpeg", data: match[2] || "" };
}

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

function normalizeParsedResult(parsed: Partial<AnalysisResult>, fallbackText: string): AnalysisResult {
  const detections: Detection[] = Array.isArray(parsed.detections)
    ? parsed.detections
        .filter((d) => Array.isArray(d.bbox) && d.bbox.length === 4)
        .slice(0, 24)
        .map((d, i) => ({
          id: d.id || `m${i + 1}`,
          label: String(d.label || parsed.highlightedTarget || "highlighted region"),
          confidence: Number(d.confidence ?? 0.82),
          bbox: [
            Math.max(0, Math.min(0.96, Number(d.bbox[0]) || 0)),
            Math.max(0, Math.min(0.96, Number(d.bbox[1]) || 0)),
            Math.max(0.02, Math.min(1, Number(d.bbox[2]) || 0.08)),
            Math.max(0.02, Math.min(1, Number(d.bbox[3]) || 0.08)),
          ],
          source: "model" as const,
          highlighted: true,
        }))
    : [];

  return {
    answer: String(parsed.answer || fallbackText.slice(0, 1200) || "Highlighted the requested regions on the scene."),
    sceneSummary: parsed.sceneSummary ? String(parsed.sceneSummary) : undefined,
    highlightedTarget: parsed.highlightedTarget ? String(parsed.highlightedTarget) : undefined,
    intent: parsed.intent ?? "detect",
    detections,
    segments: Array.isArray(parsed.segments) ? parsed.segments.slice(0, 8) : [],
    statistics: Array.isArray(parsed.statistics) ? parsed.statistics.slice(0, 12) : [],
    change: parsed.change,
  };
}

export async function runAnalyzeServer(
  data: AnalyzeInput,
): Promise<{ ok: true; analysis: AnalysisResult } | { ok: false; error: string }> {
  const historyBlock = (data.history ?? [])
    .slice(-6)
    .map((m) => `${m.role}: ${m.text}`)
    .join("\n");

  const promptText = `[VLM query]
Analyze the attached satellite image(s) with a vision-language model. Locate and highlight what the user asked about, returning bounding boxes [x, y, width, height] so we can highlight them on the map and extract cutouts for the user.

Image names: ${(data.images ?? []).map((i) => `${i.role}=${i.name}`).join(", ")}
Target requested by user: ${data.localStats?.targetLabel ?? data.question}
Client land cover %: ${JSON.stringify(data.localStats?.percents ?? {})}
Local object proposals: ${data.localStats?.detectionCount ?? 0}
${data.localStats?.changePercent != null ? `Pixel change: ${data.localStats.changePercent.toFixed(1)}%. ${data.localStats.changeSummary ?? ""}` : "Single image (no before pair)."}
Prior turns:
${historyBlock || "(none)"}
User question: ${data.question}`;

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

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return { ok: false, error: "Using fast on-image spectral highlight & extraction engine" };
  if (Date.now() < grokSkipUntil) {
    return { ok: false, error: "Using on-image analysis." };
  }

  try {
    const content: unknown[] = [];
    for (const img of data.images ?? []) {
      content.push({
        type: "image_url",
        image_url: { url: img.dataUrl, detail: "high" },
      });
    }
    content.push({
      type: "text",
      text: promptText,
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

    return {
      ok: true,
      analysis: normalizeParsedResult(parsed, text),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Vision request failed",
    };
  }
}
