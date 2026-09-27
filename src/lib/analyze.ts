import type { AnalysisResult } from "./types";

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

export async function analyzeScene({
  data,
}: {
  data: AnalyzeInput;
}): Promise<{ ok: true; analysis: AnalysisResult } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      return { ok: false, error: `Server returned ${res.status}` };
    }
    return (await res.json()) as { ok: true; analysis: AnalysisResult } | { ok: false; error: string };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Using on-image spectral analysis",
    };
  }
}
