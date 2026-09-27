import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  Layers,
  Moon,
  Ruler,
  Sun,
  Upload,
  Send,
  Focus,
  LoaderCircle,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { Toaster, toast } from "sonner";
import { Bar, BarChart, Cell, ResponsiveContainer, XAxis, YAxis, Tooltip as RTooltip } from "recharts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";
import { analyzeScene } from "@/lib/analyze";
import {
  classFromQuestion,
  computeChange,
  computeCover,
  composeLocalAnswer,
  coverToSegments,
  inferIntent,
  localDetections,
  thumbnailDataUrl,
} from "@/lib/image-analysis";
import { exportAnnotatedPng, exportCsv, exportGeoJson, exportJsonReport, exportPdf } from "@/lib/export-results";
import { rasterFromFile } from "@/lib/raster";
import { PROMPT_GALLERY, SAMPLE_SCENES, slotFromSample } from "@/lib/samples";
import type { AnalysisResult, ChatMessage, LandClass, RasterSlot, ViewerMode } from "@/lib/types";
import { CLASS_META, LAND_CLASSES } from "@/lib/types";
import { cn, formatArea, formatPct, uid } from "@/lib/utils";
import { ImageViewer } from "./image-viewer";

function useTheme() {
  const [light, setLight] = useState(false);
  useEffect(() => {
    document.documentElement.classList.toggle("light", light);
  }, [light]);
  return { light, setLight };
}

function loadSample(
  sample: (typeof SAMPLE_SCENES)[number],
  setPrimary: (s: RasterSlot) => void,
  setBefore: (s: RasterSlot | undefined) => void,
  setMode: (m: ViewerMode) => void,
  setAnalysis: (a: AnalysisResult | null) => void,
  setMessages: (m: ChatMessage[]) => void,
  setHighlightClass: (c: LandClass | undefined) => void,
) {
  const loaded = slotFromSample(sample);
  setPrimary(loaded.primary);
  setBefore(loaded.before);
  setMode(loaded.before ? "split" : "primary");
  setAnalysis(null);
  setMessages([]);
  setHighlightClass(undefined);
}

export function SatQueryWorkspace() {
  const { light, setLight } = useTheme();
  const [primary, setPrimary] = useState<RasterSlot | undefined>();
  const [before, setBefore] = useState<RasterSlot | undefined>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [mode, setMode] = useState<ViewerMode>("primary");
  const [showDetections, setShowDetections] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [showSeg, setShowSeg] = useState(true);
  const [showChange, setShowChange] = useState(true);
  const [classVisibility, setClassVisibility] = useState<Partial<Record<LandClass, boolean>>>({});
  const [highlightClass, setHighlightClass] = useState<LandClass | undefined>(undefined);
  const [measuring, setMeasuring] = useState(false);
  const [measure, setMeasure] = useState<{ a: { x: number; y: number } | null; b: { x: number; y: number } | null }>({
    a: null,
    b: null,
  });
  const [mobileTab, setMobileTab] = useState<"scene" | "ask">("scene");
  const [panelOpen, setPanelOpen] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const fitRef = useRef<() => void>(() => {});
  const captureRef = useRef<HTMLCanvasElement | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const beforeFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  const measureMeters = useMemo(() => {
    if (!primary || !measure.a || !measure.b) return null;
    const dx = (measure.b.x - measure.a.x) * primary.width;
    const dy = (measure.b.y - measure.a.y) * primary.height;
    const px = Math.hypot(dx, dy);
    return px * primary.gsdMeters;
  }, [measure, primary]);

  const ingestFiles = useCallback(async (files: FileList | File[], asBefore = false) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    try {
      if (list.length >= 2) {
        const a = await rasterFromFile(list[0]!);
        const b = await rasterFromFile(list[1]!);
        setBefore(a);
        setPrimary(b);
        setMode("split");
        toast.message("Loaded a before / after pair");
      } else {
        const slot = await rasterFromFile(list[0]!);
        if (asBefore) {
          setBefore(slot);
          toast.message("Before image loaded");
        } else {
          setPrimary(slot);
          toast.message("Scene loaded");
        }
      }
      setAnalysis(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not read file");
    }
  }, []);

  const runQuery = useCallback(
    async (question: string) => {
      if (!primary) {
        toast.error("Load an image first");
        return;
      }
      const q = question.trim();
      if (!q) return;
      setDraft("");
      const userMsg: ChatMessage = { id: uid("m"), role: "user", text: q, createdAt: Date.now() };
      setMessages((m) => [...m, userMsg]);
      setBusy(true);
      try {
        const cover = await computeCover(primary.src);
        let change;
        if (before) change = await computeChange(before.src, primary.src);
        const localDet = localDetections(cover);
        const intent = inferIntent(q, Boolean(before));
        const focusClass = classFromQuestion(q);
        setHighlightClass(focusClass);
        const localAnswer = composeLocalAnswer(q, cover, localDet, change);
        const local: AnalysisResult = {
          answer: localAnswer,
          intent,
          detections: intent === "detect" || intent === "describe" ? localDet : localDet.slice(0, 8),
          segments: coverToSegments(cover),
          statistics: LAND_CLASSES.map((c) => ({
            name: CLASS_META[c].label,
            value: formatPct(cover.percents[c]),
            hint: formatArea(
              cover.counts[c] * (primary.width / cover.width) * (primary.height / cover.height),
              primary.gsdMeters,
            ),
          })),
          change,
          cover,
        };

        const assistantId = uid("m");
        setAnalysis(local);
        setShowSeg(true);
        setShowChange(Boolean(local.change));
        setMessages((m) => [
          ...m,
          { id: assistantId, role: "assistant", text: local.answer, analysis: local, createdAt: Date.now() },
        ]);
        setMobileTab("ask");
        setBusy(false);

        void (async () => {
          try {
            const images: { name: string; dataUrl: string; role: "primary" | "before" }[] = [
              { name: primary.name, dataUrl: await thumbnailDataUrl(primary.src, 512, 0.62), role: "primary" },
            ];
            if (before) {
              images.unshift({
                name: before.name,
                dataUrl: await thumbnailDataUrl(before.src, 512, 0.62),
                role: "before",
              });
            }
            const history = [...messages, userMsg].map((m) => ({ role: m.role, text: m.text }));
            const grok = await analyzeScene({
              data: {
                question: q,
                images,
                history,
                localStats: {
                  percents: cover.percents,
                  detectionCount: localDet.length,
                  changePercent: change?.percent,
                  changeSummary: change?.summary,
                },
              },
            });
            if (!grok.ok || !grok.analysis.answer) return;
            const merged: AnalysisResult = {
              ...local,
              answer: grok.analysis.answer,
              sceneSummary: grok.analysis.sceneSummary,
              intent: grok.analysis.intent,
              detections: grok.analysis.detections.length > 0 ? grok.analysis.detections : local.detections,
              statistics: grok.analysis.statistics.length ? grok.analysis.statistics : local.statistics,
              change: grok.analysis.change
                ? {
                    ...local.change,
                    ...grok.analysis.change,
                    mask: local.change?.mask,
                    width: local.change?.width,
                    height: local.change?.height,
                  }
                : local.change,
            };
            setAnalysis(merged);
            setMessages((m) => m.map((msg) => (msg.id === assistantId ? { ...msg, text: merged.answer, analysis: merged } : msg)));
          } catch {
            /* keep local answer */
          }
        })();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Analysis failed");
        setMessages((m) => [
          ...m,
          {
            id: uid("m"),
            role: "assistant",
            text: "Something went wrong while analyzing this scene. Try a shorter question or another image.",
            createdAt: Date.now(),
          },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [before, messages, primary],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          void runQuery(draft);
        }
        return;
      }
      if (e.key === "0") fitRef.current();
      if (e.key === "m" || e.key === "M") setMeasuring((v) => !v);
      if (e.key === "d" || e.key === "D") setShowDetections((v) => !v);
      if (e.key === "s" || e.key === "S") setShowSeg((v) => !v);
      if (e.key === "Escape") {
        setMeasuring(false);
        setMeasure({ a: null, b: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, runQuery]);

  const chartData = analysis
    ? analysis.segments.map((s) => ({ name: s.label, pct: Number(s.coveragePct.toFixed(1)), fill: s.color }))
    : [];

  return (
    <TooltipProvider>
      <div
        className="flex h-dvh flex-col bg-bg text-fg"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void ingestFiles(e.dataTransfer.files);
        }}
      >
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-3 sm:px-4">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground">
              <Focus className="size-4" />
            </span>
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-tight">SatQuery AI</div>
              <div className="hidden text-[11px] text-muted-foreground sm:block">Ask the imagery</div>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Tooltip content="Load image">
              <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
                <Upload />
                <span className="hidden sm:inline">Upload</span>
              </Button>
            </Tooltip>
            <Tooltip content="Fit to view">
              <Button variant="ghost" size="icon-sm" onClick={() => fitRef.current()} aria-label="Fit">
                <Focus />
              </Button>
            </Tooltip>
            <Tooltip content="Measure (M)">
              <Button
                variant={measuring ? "default" : "ghost"}
                size="icon-sm"
                onClick={() => setMeasuring((v) => !v)}
                aria-pressed={measuring}
                aria-label="Measure"
              >
                <Ruler />
              </Button>
            </Tooltip>
            <Tooltip content="Toggle theme">
              <Button variant="ghost" size="icon-sm" onClick={() => setLight(!light)} aria-label="Theme">
                {light ? <Moon /> : <Sun />}
              </Button>
            </Tooltip>
            <Button
              variant="ghost"
              size="icon-sm"
              className="lg:hidden"
              onClick={() => setPanelOpen((v) => !v)}
              aria-label="Toggle panel"
            >
              {panelOpen ? <PanelRightClose /> : <PanelRightOpen />}
            </Button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <section className={cn("flex min-w-0 flex-1 flex-col", mobileTab === "ask" && "hidden lg:flex")}>
            <div className="flex flex-wrap items-center gap-1 border-b border-border bg-surface px-2 py-1.5">
              {(["primary", "before", "split", "blend"] as ViewerMode[]).map((m) => (
                <button
                  key={m}
                  className={cn(
                    "h-8 rounded-md px-2.5 text-xs capitalize",
                    mode === m ? "bg-secondary text-fg" : "text-muted-foreground hover:text-fg",
                  )}
                  onClick={() => setMode(m)}
                  disabled={m !== "primary" && !before}
                >
                  {m === "primary" ? "After / scene" : m}
                </button>
              ))}
              <span className="mx-1 h-4 w-px bg-border" />
              <label className="flex h-8 items-center gap-1.5 px-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={showDetections} onChange={(e) => setShowDetections(e.target.checked)} />
                Boxes
              </label>
              <label className="flex h-8 items-center gap-1.5 px-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={showSeg} onChange={(e) => setShowSeg(e.target.checked)} />
                Cover
              </label>
              <label className="flex h-8 items-center gap-1.5 px-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={showChange} onChange={(e) => setShowChange(e.target.checked)} />
                Change
              </label>
              <label className="flex h-8 items-center gap-1.5 px-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
                Labels
              </label>
              <span className="ml-auto hidden items-center gap-1 px-2 text-xs text-muted-foreground sm:flex">
                <Layers className="size-3.5" />
                overlays
              </span>
            </div>
            <div className="relative min-h-0 flex-1">
              <ImageViewer
                primary={primary}
                before={before}
                analysis={analysis}
                mode={mode}
                showDetections={showDetections}
                showLabels={showLabels}
                showSeg={showSeg}
                showChange={showChange}
                classVisibility={classVisibility}
                highlightClass={highlightClass}
                measuring={measuring}
                measure={measure}
                onMeasure={setMeasure}
                onFitRequest={(fn) => {
                  fitRef.current = fn;
                }}
                onPickSample={(s) =>
                  loadSample(s, setPrimary, setBefore, setMode, setAnalysis, setMessages, setHighlightClass)
                }
                captureRef={captureRef}
              />
              {dragOver ? (
                <div className="absolute inset-0 grid place-items-center bg-bg/70 text-sm font-medium">
                  Drop JPEG, PNG, or GeoTIFF
                </div>
              ) : null}
            </div>
            {measureMeters != null ? (
              <div className="border-t border-border bg-surface px-3 py-1.5 font-mono text-xs text-muted-foreground">
                Distance {measureMeters.toFixed(1)} m
              </div>
            ) : null}
          </section>

          <aside
            className={cn(
              "flex w-full shrink-0 flex-col border-l border-border bg-surface lg:w-[400px]",
              mobileTab === "scene" ? "hidden lg:flex" : "flex",
              !panelOpen && "hidden",
            )}
          >
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
              {!primary ? (
                <div className="space-y-4">
                  <div>
                    <h1 className="text-lg font-semibold tracking-tight">Query the planet</h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Load a scene, ask in plain language, and get detections, land cover, statistics, and change maps.
                    </p>
                  </div>
                  <button
                    className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-bg px-4 py-8 text-sm text-muted-foreground hover:border-accent hover:text-fg"
                    onClick={() => fileRef.current?.click()}
                  >
                    <Upload className="size-5" />
                    Drop imagery here or browse
                    <span className="text-xs">JPEG, PNG, TIFF, GeoTIFF</span>
                  </button>
                  <p className="text-xs text-muted-foreground">
                    Sample scenes are also on the viewer. For change detection, choose Forest change pair or upload two files.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-subtle">Conversation</div>
                    <div className="mt-2 space-y-3">
                      {messages.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          Try a prompt below, or type your own question about this scene.
                        </p>
                      ) : null}
                      {messages.map((m) => (
                        <div
                          key={m.id}
                          className={cn(
                            "rounded-lg px-3 py-2 text-sm leading-relaxed",
                            m.role === "user" ? "bg-secondary" : "bg-bg border border-border",
                          )}
                        >
                          {m.text}
                        </div>
                      ))}
                      {busy ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <LoaderCircle className="size-4 animate-spin" />
                          Reading the scene…
                        </div>
                      ) : null}
                      <div ref={chatEnd} />
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {PROMPT_GALLERY.filter((p) => before || !/change/i.test(p.text))
                      .slice(0, 6)
                      .map((p) => (
                        <button
                          key={p.label}
                          className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:text-fg"
                          onClick={() => void runQuery(p.text)}
                          disabled={busy}
                        >
                          {p.label}
                        </button>
                      ))}
                  </div>

                  {analysis ? (
                    <>
                      <Separator />
                      <div>
                        <div className="mb-2 flex items-center justify-between">
                          <div className="text-xs font-medium uppercase tracking-wide text-subtle">Land cover</div>
                          <Badge>{analysis.detections.length} objects</Badge>
                        </div>
                        <div className="h-40">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                              <XAxis dataKey="name" tick={{ fill: "currentColor", fontSize: 10 }} />
                              <YAxis tick={{ fill: "currentColor", fontSize: 10 }} />
                              <RTooltip
                                contentStyle={{
                                  background: "var(--color-surface)",
                                  border: "1px solid var(--color-border)",
                                }}
                              />
                              <Bar dataKey="pct" radius={[4, 4, 0, 0]}>
                                {chartData.map((e) => (
                                  <Cell key={e.name} fill={e.fill} />
                                ))}
                              </Bar>
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                        <ul className="mt-2 space-y-1">
                          {analysis.statistics.slice(0, 8).map((s) => (
                            <li key={s.name} className="flex justify-between gap-3 text-xs">
                              <span className="text-muted-foreground">{s.name}</span>
                              <span className="font-mono tabular-nums">
                                {s.value}
                                {s.hint ? <span className="ml-2 text-subtle">{s.hint}</span> : null}
                              </span>
                            </li>
                          ))}
                        </ul>
                        {analysis.change ? (
                          <p className="mt-3 text-xs text-muted-foreground">{analysis.change.summary}</p>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {(Object.keys(CLASS_META) as LandClass[])
                          .filter((k) => k !== "other")
                          .map((k) => (
                            <button
                              key={k}
                              className={cn(
                                "rounded-full border px-2 py-1 text-[11px]",
                                classVisibility[k] === false ? "border-border text-subtle" : "border-border text-fg",
                              )}
                              onClick={() => setClassVisibility((v) => ({ ...v, [k]: v[k] === false }))}
                            >
                              <span
                                className="mr-1.5 inline-block size-2 rounded-sm"
                                style={{ background: CLASS_META[k].hex }}
                              />
                              {CLASS_META[k].label}
                            </button>
                          ))}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" onClick={() => analysis && primary && exportCsv(analysis)}>
                          <Download /> CSV
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => analysis && primary && exportGeoJson(analysis, primary)}
                        >
                          GeoJSON
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => analysis && primary && exportPdf(analysis, primary)}>
                          PDF
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => analysis && primary && exportJsonReport(analysis, primary)}
                        >
                          JSON
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            const c = captureRef.current;
                            if (c) void exportAnnotatedPng(c);
                          }}
                        >
                          PNG
                        </Button>
                      </div>
                    </>
                  ) : null}

                  <div>
                    <button
                      className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                      onClick={() => beforeFileRef.current?.click()}
                    >
                      Add a before image for change detection
                    </button>
                  </div>
                </div>
              )}
            </div>

            <form
              className="border-t border-border p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void runQuery(draft);
              }}
            >
              <label className="sr-only" htmlFor="ask">
                Ask about the image
              </label>
              <textarea
                id="ask"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void runQuery(draft);
                  }
                }}
                placeholder={primary ? "VLM: ask what you see in this scene…" : "Load a scene, then ask a VLM question"}
                disabled={!primary || busy}
                rows={3}
                className="w-full resize-none rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/70 disabled:opacity-50"
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-[11px] text-subtle">
                  <Badge className="border-accent/40 bg-secondary text-fg">VLM</Badge>
                  VLM · Enter to send
                </span>
                <Button type="submit" size="sm" disabled={!primary || busy || !draft.trim()}>
                  <Send /> Ask
                </Button>
              </div>
            </form>
          </aside>
        </div>

        <nav className="grid grid-cols-2 border-t border-border bg-surface lg:hidden">
          <button
            className={cn("h-12 text-sm", mobileTab === "scene" ? "text-fg" : "text-muted-foreground")}
            onClick={() => setMobileTab("scene")}
          >
            Scene
          </button>
          <button
            className={cn("h-12 text-sm", mobileTab === "ask" ? "text-fg" : "text-muted-foreground")}
            onClick={() => setMobileTab("ask")}
          >
            Ask
          </button>
        </nav>

        <input
          ref={fileRef}
          type="file"
          accept="image/*,.tif,.tiff,.geotiff"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void ingestFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={beforeFileRef}
          type="file"
          accept="image/*,.tif,.tiff,.geotiff"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void ingestFiles(e.target.files, true);
            e.target.value = "";
          }}
        />
        <Toaster theme={light ? "light" : "dark"} />
      </div>
    </TooltipProvider>
  );
}
