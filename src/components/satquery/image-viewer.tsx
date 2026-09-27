import { useEffect, useRef, useState } from "react";
import { Download, X } from "lucide-react";
import { SAMPLE_SCENES } from "@/lib/samples";
import type { AnalysisResult, BBox, RasterSlot, ViewerMode } from "@/lib/types";
import { CLASS_META, type LandClass } from "@/lib/types";
import { paintChangeOverlay, paintCoverOverlay, paintTintOverlay } from "@/lib/image-analysis";
import { downloadDataUrl } from "@/lib/export-results";
import { clamp } from "@/lib/utils";

type Measure = { a: { x: number; y: number } | null; b: { x: number; y: number } | null };

type Props = {
  primary?: RasterSlot;
  before?: RasterSlot;
  analysis?: AnalysisResult | null;
  mode: ViewerMode;
  showDetections: boolean;
  showLabels: boolean;
  showSeg: boolean;
  showChange: boolean;
  tintOpacity?: number;
  activeDetectionId?: string | null;
  onSelectDetection?: (id: string | null) => void;
  classVisibility: Partial<Record<LandClass, boolean>>;
  measuring: boolean;
  measure: Measure;
  onMeasure: (m: Measure) => void;
  onFitRequest?: (fn: () => void) => void;
  onFocusBBoxRequest?: (fn: (bbox: BBox) => void) => void;
  onPickSample?: (sample: (typeof SAMPLE_SCENES)[number]) => void;
  captureRef?: React.MutableRefObject<HTMLCanvasElement | null>;
};

export function ImageViewer({
  primary,
  before,
  analysis,
  mode,
  showDetections,
  showLabels,
  showSeg,
  showChange,
  tintOpacity = 0.48,
  activeDetectionId,
  onSelectDetection,
  classVisibility,
  measuring,
  measure,
  onMeasure,
  onFitRequest,
  onFocusBBoxRequest,
  onPickSample,
  captureRef,
}: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);

  const fit = () => {
    const vp = viewportRef.current;
    if (!vp || !primary) return;
    const pad = 24;
    const s = Math.min(
      (vp.clientWidth - pad) / primary.width,
      (vp.clientHeight - pad) / primary.height,
    );
    setScale(s);
    setTx((vp.clientWidth - primary.width * s) / 2);
    setTy((vp.clientHeight - primary.height * s) / 2);
  };

  const focusBBox = (bbox: BBox) => {
    const vp = viewportRef.current;
    if (!vp || !primary) return;
    const [bx, by, bw, bh] = bbox;
    const targetW = Math.max(bw * primary.width, 120);
    const targetH = Math.max(bh * primary.height, 120);
    const desiredScale = clamp(
      Math.min((vp.clientWidth * 0.48) / targetW, (vp.clientHeight * 0.48) / targetH),
      0.35,
      4.5,
    );
    const cx = (bx + bw / 2) * primary.width;
    const cy = (by + bh / 2) * primary.height;
    setScale(desiredScale);
    setTx(vp.clientWidth / 2 - cx * desiredScale);
    setTy(vp.clientHeight / 2 - cy * desiredScale);
  };

  useEffect(() => {
    fit();
    onFitRequest?.(fit);
    onFocusBBoxRequest?.(focusBBox);
    const ro = new ResizeObserver(() => fit());
    if (viewportRef.current) ro.observe(viewportRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary?.id, mode]);

  useEffect(() => {
    onFocusBBoxRequest?.(focusBBox);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary?.id]);

  const activeDet =
    activeDetectionId && analysis?.detections
      ? analysis.detections.find((d) => d.id === activeDetectionId)
      : undefined;

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || !primary) return;
    canvas.width = primary.width;
    canvas.height = primary.height;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const imgEl = worldRef.current?.querySelector("img.primary-raster") as HTMLImageElement | null;

    // Primary Tinted Color Overlay covering the queried area
    if (showSeg && analysis) {
      if (analysis.tint && analysis.target?.isSpecificTarget) {
        const tmp = document.createElement("canvas");
        paintTintOverlay(tmp, analysis.tint, tintOpacity, activeDet?.bbox ?? null);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
      } else if (analysis.cover) {
        const tmp = document.createElement("canvas");
        paintCoverOverlay(tmp, analysis.cover, classVisibility, tintOpacity);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
      }
    }

    if (showChange && analysis?.change?.mask && !analysis.target?.highlightChange) {
      const tmp = document.createElement("canvas");
      paintChangeOverlay(tmp, analysis.change);
      ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
    }

    // Optional bounding boxes (off by default — only drawn if user explicitly enables Boxes)
    if (showDetections && analysis) {
      analysis.detections.forEach((d, idx) => {
        const [x, y, w, h] = d.bbox;
        const rx = x * canvas.width;
        const ry = y * canvas.height;
        const rw = w * canvas.width;
        const rh = h * canvas.height;
        const baseColor = d.color || analysis.target?.colorHex || "#38bdf8";

        ctx.fillStyle = `${baseColor}38`;
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle = baseColor;
        ctx.lineWidth = Math.max(2, canvas.width / 600);
        ctx.strokeRect(rx, ry, rw, rh);

        if (showLabels) {
          const label = `#${idx + 1} ${d.label}`;
          const fontSize = Math.max(11, Math.round(canvas.width / 92));
          ctx.font = `600 ${fontSize}px IBM Plex Sans, sans-serif`;
          const tw = ctx.measureText(label).width + 10;
          const th = Math.max(16, Math.round(canvas.width / 68));
          const labelY = Math.max(0, ry - th);
          ctx.fillStyle = "rgba(7, 9, 11, 0.82)";
          ctx.fillRect(rx, labelY, tw, th);
          ctx.fillStyle = "#f8fafc";
          ctx.fillText(label, rx + 5, labelY + th - 4);
        }
      });
    }

    if (measure.a) {
      ctx.fillStyle = "#9bb8b3";
      const r = Math.max(4, canvas.width / 220);
      ctx.beginPath();
      ctx.arc(measure.a.x * canvas.width, measure.a.y * canvas.height, r, 0, Math.PI * 2);
      ctx.fill();
      if (measure.b) {
        ctx.beginPath();
        ctx.arc(measure.b.x * canvas.width, measure.b.y * canvas.height, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#e8ebe9";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(measure.a.x * canvas.width, measure.a.y * canvas.height);
        ctx.lineTo(measure.b.x * canvas.width, measure.b.y * canvas.height);
        ctx.stroke();
      }
    }

    const cap = captureCanvasRef.current;
    if (cap && primary) {
      cap.width = primary.width;
      cap.height = primary.height;
      const cctx = cap.getContext("2d")!;
      if (imgEl?.complete) {
        cctx.drawImage(imgEl, 0, 0, cap.width, cap.height);
        cctx.drawImage(canvas, 0, 0);
      }
      if (captureRef) captureRef.current = cap;
    }
  }, [
    analysis,
    showDetections,
    showLabels,
    showSeg,
    showChange,
    tintOpacity,
    activeDet,
    classVisibility,
    measure,
    primary,
    captureRef,
  ]);

  const clientToNorm = (clientX: number, clientY: number) => {
    const vp = viewportRef.current;
    if (!vp || !primary) return { x: 0, y: 0 };
    const rect = vp.getBoundingClientRect();
    const x = (clientX - rect.left - tx) / scale / primary.width;
    const y = (clientY - rect.top - ty) / scale / primary.height;
    return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
  };

  const activeExtractedItem =
    activeDetectionId && analysis?.extractedItems
      ? analysis.extractedItems.find((item) => item.id === activeDetectionId)
      : undefined;

  return (
    <div
      ref={viewportRef}
      className="relative h-full min-h-[280px] w-full overflow-hidden bg-sidebar"
      onWheel={(e) => {
        e.preventDefault();
        const vp = viewportRef.current;
        if (!vp || !primary) return;
        const rect = vp.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.12 : 0.89;
        const next = clamp(scale * factor, 0.08, 18);
        const wx = (mx - tx) / scale;
        const wy = (my - ty) / scale;
        setScale(next);
        setTx(mx - wx * next);
        setTy(my - wy * next);
      }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button, a, input, textarea")) return;
        if (measuring && primary) {
          const p = clientToNorm(e.clientX, e.clientY);
          if (!measure.a || measure.b) onMeasure({ a: p, b: null });
          else onMeasure({ a: measure.a, b: p });
          return;
        }
        if (!primary) return;
        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, tx, ty, moved: false };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const dx = e.clientX - drag.current.x;
        const dy = e.clientY - drag.current.y;
        if (Math.hypot(dx, dy) > 4) drag.current.moved = true;
        setTx(drag.current.tx + dx);
        setTy(drag.current.ty + dy);
      }}
      onPointerUp={(e) => {
        const wasClick = drag.current && !drag.current.moved;
        drag.current = null;
        if (wasClick && primary && analysis?.detections.length && onSelectDetection && !measuring) {
          const p = clientToNorm(e.clientX, e.clientY);
          const hit = analysis.detections.find((d) => {
            const [bx, by, bw, bh] = d.bbox;
            return p.x >= bx && p.x <= bx + bw && p.y >= by && p.y <= by + bh;
          });
          onSelectDetection(hit ? (hit.id === activeDetectionId ? null : hit.id) : null);
        }
      }}
      role="application"
      aria-label="Satellite image viewer"
    >
      {!primary ? (
        <div className="flex h-full flex-col items-center justify-center gap-4 overflow-y-auto px-4 py-6">
          <p className="text-center text-sm text-muted-foreground">
            Drop a satellite image or load a sample scene
          </p>
          <div className="grid w-full max-w-3xl grid-cols-2 gap-2 sm:grid-cols-3">
            {SAMPLE_SCENES.map((s) => (
              <button
                key={s.src}
                className="overflow-hidden rounded-lg border border-border bg-surface text-left hover:border-accent"
                onClick={() => onPickSample?.(s)}
              >
                <img src={s.src} alt="" className="aspect-4/3 w-full object-cover" />
                <div className="px-2 py-1.5">
                  <div className="text-xs font-medium text-fg">{s.name}</div>
                  <div className="text-[11px] text-muted-foreground">{s.blurb}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div
          ref={worldRef}
          className="absolute left-0 top-0 origin-top-left will-change-transform"
          style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}
        >
          {mode === "split" && before ? (
            <div className="flex" style={{ width: primary.width * 2, height: primary.height }}>
              <img
                src={before.src}
                alt={before.name}
                width={primary.width}
                height={primary.height}
                className="block select-none"
                draggable={false}
              />
              <div className="relative" style={{ width: primary.width, height: primary.height }}>
                <img
                  src={primary.src}
                  alt={primary.name}
                  width={primary.width}
                  height={primary.height}
                  className="primary-raster block h-full w-full select-none"
                  draggable={false}
                />
                <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" />
              </div>
            </div>
          ) : (
            <div className="relative" style={{ width: primary.width, height: primary.height }}>
              {mode === "before" && before ? (
                <img src={before.src} alt={before.name} className="block h-full w-full select-none" draggable={false} />
              ) : (
                <img
                  src={primary.src}
                  alt={primary.name}
                  className="primary-raster block h-full w-full select-none"
                  draggable={false}
                />
              )}
              {mode === "blend" && before ? (
                <img
                  src={before.src}
                  alt=""
                  className="absolute inset-0 block h-full w-full select-none opacity-45"
                  draggable={false}
                />
              ) : null}
              <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" />
            </div>
          )}
        </div>
      )}

      {primary ? <canvas ref={captureCanvasRef} className="hidden" /> : null}

      {/* Top-left Tinted Area Legend Badge when a query is active */}
      {primary && showSeg && analysis?.highlightedTarget ? (
        <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-lg border border-border bg-bg/90 px-3 py-1.5 text-xs shadow-lg backdrop-blur-sm">
          <span
            className="size-3 rounded-sm"
            style={{ background: analysis.tint?.colorHex || analysis.target?.colorHex || "#38bdf8" }}
          />
          <span className="font-medium text-fg">{analysis.highlightedTarget}</span>
          {analysis.tint ? (
            <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {analysis.tint.coveragePct.toFixed(1)}% of scene
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Floating Inspector Card when a tinted region is selected */}
      {primary && activeExtractedItem ? (
        <div className="absolute bottom-12 left-3 z-10 flex w-72 items-center gap-3 rounded-xl border border-accent/60 bg-surface/95 p-2.5 shadow-xl backdrop-blur-md">
          <img
            src={activeExtractedItem.cropDataUrl}
            alt={activeExtractedItem.label}
            className="size-16 shrink-0 rounded-lg border border-border object-cover"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-1">
              <div className="truncate text-xs font-semibold text-fg">{activeExtractedItem.label}</div>
              <button
                type="button"
                onClick={() => onSelectDetection?.(null)}
                className="rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-fg"
                aria-label="Close selected item"
              >
                <X className="size-3.5" />
              </button>
            </div>
            <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
              {activeExtractedItem.dimensionsText} · {activeExtractedItem.areaText}
            </div>
            <div className="mt-1.5 flex items-center gap-1.5">
              <button
                type="button"
                onClick={() =>
                  downloadDataUrl(
                    activeExtractedItem.cropDataUrl,
                    `${activeExtractedItem.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`,
                  )
                }
                className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90"
              >
                <Download className="size-3" />
                Get tinted area
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {primary ? (
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-border bg-bg/80 px-2 py-1 font-mono text-xs text-muted-foreground">
          {Math.round(scale * 100)}% · {primary.width}×{primary.height} · GSD {primary.gsdMeters} m
        </div>
      ) : null}

      {primary && showSeg && analysis?.cover && !analysis.target?.isSpecificTarget ? (
        <div className="pointer-events-none absolute right-3 top-3 flex flex-col gap-1 rounded-lg border border-border bg-bg/80 p-2 text-[11px]">
          {(Object.keys(CLASS_META) as LandClass[])
            .filter((k) => k !== "other" && classVisibility[k] !== false)
            .map((k) => (
              <div key={k} className="flex items-center gap-2 text-fg">
                <span className="size-2.5 rounded-sm" style={{ background: CLASS_META[k].hex }} />
                {CLASS_META[k].label}
              </div>
            ))}
        </div>
      ) : null}
    </div>
  );
}
