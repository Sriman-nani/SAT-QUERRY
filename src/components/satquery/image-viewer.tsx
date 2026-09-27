import { useEffect, useRef, useState } from "react";
import { Focus } from "lucide-react";
import { SAMPLE_SCENES } from "@/lib/samples";
import type { AnalysisResult, RasterSlot, ViewerMode } from "@/lib/types";
import { CLASS_META, type LandClass } from "@/lib/types";
import {
  detectionMatchesClass,
  paintChangeOverlay,
  paintCoverOverlay,
  paintHighlightOverlay,
} from "@/lib/image-analysis";
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
  classVisibility: Partial<Record<LandClass, boolean>>;
  highlightClass?: LandClass;
  measuring: boolean;
  measure: Measure;
  onMeasure: (m: Measure) => void;
  onFitRequest?: (fn: () => void) => void;
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
  classVisibility,
  highlightClass,
  measuring,
  measure,
  onMeasure,
  onFitRequest,
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
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

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

  useEffect(() => {
    fit();
    onFitRequest?.(fit);
    const ro = new ResizeObserver(() => fit());
    if (viewportRef.current) ro.observe(viewportRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary?.id, mode]);

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || !primary) return;
    canvas.width = primary.width;
    canvas.height = primary.height;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (highlightClass && analysis?.cover) {
      // Tint ONLY the class the question targets.
      const tmp = document.createElement("canvas");
      paintHighlightOverlay(tmp, analysis.cover, highlightClass, 0.5);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
    } else if (showSeg && analysis?.cover) {
      const tmp = document.createElement("canvas");
      paintCoverOverlay(tmp, analysis.cover, classVisibility);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
    }

    if (showChange && analysis?.change?.mask) {
      const tmp = document.createElement("canvas");
      paintChangeOverlay(tmp, analysis.change);
      ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
    }

    if (showDetections && analysis) {
      const dets = highlightClass
        ? analysis.detections.filter((d) => detectionMatchesClass(d, highlightClass))
        : analysis.detections;
      for (const d of dets) {
        const [x, y, w, h] = d.bbox;
        ctx.strokeStyle = d.source === "model" ? "#9bb8b3" : "#c4a574";
        ctx.lineWidth = Math.max(2, canvas.width / 700);
        ctx.strokeRect(x * canvas.width, y * canvas.height, w * canvas.width, h * canvas.height);
        if (showLabels) {
          const label = `${d.label} ${Math.round(d.confidence * 100)}%`;
          ctx.font = `${Math.max(12, canvas.width / 90)}px IBM Plex Sans, sans-serif`;
          const tw = ctx.measureText(label).width + 10;
          const th = Math.max(16, canvas.width / 70);
          ctx.fillStyle = "rgba(7,9,11,0.82)";
          ctx.fillRect(x * canvas.width, y * canvas.height - th, tw, th);
          ctx.fillStyle = "#e8ebe9";
          ctx.fillText(label, x * canvas.width + 5, y * canvas.height - 5);
        }
      }
    }

    if (analysis?.change?.regions && showChange) {
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = "#d07058";
      for (const r of analysis.change.regions) {
        const [x, y, w, h] = r.bbox;
        ctx.strokeRect(x * canvas.width, y * canvas.height, w * canvas.width, h * canvas.height);
      }
      ctx.setLineDash([]);
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
      const img = worldRef.current?.querySelector("img.primary-raster") as HTMLImageElement | null;
      if (img?.complete) {
        cctx.drawImage(img, 0, 0, cap.width, cap.height);
        cctx.drawImage(canvas, 0, 0);
      }
      if (captureRef) captureRef.current = cap;
    }
  }, [analysis, showDetections, showLabels, showSeg, showChange, classVisibility, highlightClass, measure, primary, captureRef]);

  const clientToNorm = (clientX: number, clientY: number) => {
    const vp = viewportRef.current;
    if (!vp || !primary) return { x: 0, y: 0 };
    const rect = vp.getBoundingClientRect();
    const x = (clientX - rect.left - tx) / scale / primary.width;
    const y = (clientY - rect.top - ty) / scale / primary.height;
    return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
  };

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
        drag.current = { x: e.clientX, y: e.clientY, tx, ty };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        setTx(drag.current.tx + (e.clientX - drag.current.x));
        setTy(drag.current.ty + (e.clientY - drag.current.y));
      }}
      onPointerUp={() => {
        drag.current = null;
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
              <img src={before.src} alt={before.name} width={primary.width} height={primary.height} className="block select-none" draggable={false} />
              <img src={primary.src} alt={primary.name} width={primary.width} height={primary.height} className="primary-raster block select-none" draggable={false} />
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
      {primary ? (
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-border bg-bg/80 px-2 py-1 font-mono text-xs text-muted-foreground">
          {Math.round(scale * 100)}% · {primary.width}×{primary.height} · GSD {primary.gsdMeters} m
        </div>
      ) : null}
      {primary && (showSeg || highlightClass) && analysis?.cover ? (
        <div className="pointer-events-none absolute right-3 top-3 flex flex-col gap-1 rounded-lg border border-border bg-bg/80 p-2 text-[11px]">
          {highlightClass ? (
            <div className="mb-1 flex items-center gap-2 font-medium text-fg">
              <Focus className="size-3 text-accent" />
              Focus: {CLASS_META[highlightClass].label}
            </div>
          ) : null}
          {(Object.keys(CLASS_META) as LandClass[])
            .filter((k) => k !== "other")
            .map((k) => (
              <div
                key={k}
                className={
                  highlightClass && k !== highlightClass
                    ? "flex items-center gap-2 text-subtle"
                    : "flex items-center gap-2 text-fg"
                }
              >
                <span
                  className="rounded-sm"
                  style={{
                    background: CLASS_META[k].hex,
                    width: highlightClass === k ? 12 : 10,
                    height: highlightClass === k ? 12 : 10,
                    outline: highlightClass === k ? `2px solid ${CLASS_META[k].hex}` : "none",
                    outlineOffset: 1,
                  }}
                />
                {CLASS_META[k].label}
              </div>
            ))}
        </div>
      ) : null}
    </div>
  );
}
