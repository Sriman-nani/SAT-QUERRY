import {
  CLASS_META,
  LAND_CLASSES,
  type AnalysisResult,
  type CoverMap,
  type Detection,
  type LandClass,
  type ChangeResult,
} from "./types";
import { uid } from "./utils";

const CLASS_ID: Record<LandClass, number> = {
  water: 0,
  vegetation: 1,
  urban: 2,
  bare: 3,
  other: 4,
};

function classifyPixel(r: number, g: number, b: number): LandClass {
  const sum = r + g + b + 1;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  const ndvi = (g - r) / (g + r + 1);
  const brightness = sum / 3;
  const blueShare = b / sum;
  const redShare = r / sum;

  if (blueShare > 0.38 && b > r + 12 && b > g - 4 && ndvi < 0.08) return "water";
  if (ndvi > 0.1 && g > r + 6 && g > 40) return "vegetation";
  if (redShare > 0.36 && r > b + 25 && ndvi < 0.05 && brightness < 170 && sat > 0.12) {
    if (brightness < 95 && sat < 0.35) return "water";
    return "bare";
  }
  if (sat < 0.16 && brightness > 55 && brightness < 210) return "urban";
  if (r > g && g >= b - 8 && ndvi < 0.08 && sat > 0.1) return "bare";
  if (ndvi > 0.04 && g >= r) return "vegetation";
  return "other";
}

function drawToContext(
  img: HTMLImageElement,
  maxEdge: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(8, Math.round(img.naturalWidth * scale));
  const h = Math.max(8, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas, ctx };
}

export async function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = src;
  });
}

export async function computeCover(src: string, maxEdge = 360): Promise<CoverMap> {
  const img = await loadHtmlImage(src);
  const { canvas, ctx } = drawToContext(img, maxEdge);
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  const counts: Record<LandClass, number> = {
    water: 0,
    vegetation: 0,
    urban: 0,
    bare: 0,
    other: 0,
  };
  const bins = 16;
  const rHist = new Array(bins).fill(0);
  const gHist = new Array(bins).fill(0);
  const bHist = new Array(bins).fill(0);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const cls = classifyPixel(r, g, b);
    mask[p] = CLASS_ID[cls];
    counts[cls] += 1;
    rHist[Math.min(bins - 1, (r * bins) >> 8)] += 1;
    gHist[Math.min(bins - 1, (g * bins) >> 8)] += 1;
    bHist[Math.min(bins - 1, (b * bins) >> 8)] += 1;
  }

  const total = width * height;
  const percents = {} as Record<LandClass, number>;
  for (const c of LAND_CLASSES) percents[c] = (counts[c] / total) * 100;

  return {
    width,
    height,
    mask,
    counts,
    percents,
    total,
    histogram: { bins: Array.from({ length: bins }, (_, i) => i), r: rHist, g: gHist, b: bHist },
  };
}

export function blobsFromCover(
  cover: CoverMap,
  classId: LandClass,
  minFrac = 0.0025,
  label: string,
): Detection[] {
  const { width: w, height: h, mask } = cover;
  const target = CLASS_ID[classId];
  const visited = new Uint8Array(w * h);
  const minArea = Math.max(12, Math.floor(w * h * minFrac));
  const out: Detection[] = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (visited[i] || mask[i] !== target) continue;
      let minX = x,
        maxX = x,
        minY = y,
        maxY = y,
        area = 0;
      const stack = [i];
      visited[i] = 1;
      while (stack.length) {
        const cur = stack.pop()!;
        const cx = cur % w;
        const cy = (cur / w) | 0;
        area += 1;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        const n = [
          cur - 1,
          cur + 1,
          cur - w,
          cur + w,
        ];
        for (const ni of n) {
          if (ni < 0 || ni >= w * h || visited[ni]) continue;
          const nx = ni % w;
          if (Math.abs(nx - cx) + Math.abs(((ni / w) | 0) - cy) !== 1) continue;
          if (mask[ni] !== target) continue;
          visited[ni] = 1;
          stack.push(ni);
        }
      }
      if (area < minArea) continue;
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      if (bw < 3 || bh < 3) continue;
      out.push({
        id: uid("det"),
        label,
        confidence: Math.min(0.93, 0.55 + area / (w * h) * 8),
        bbox: [minX / w, minY / h, bw / w, bh / h],
        source: "local",
      });
      if (out.length >= 28) return out;
    }
  }
  return out;
}

export function localDetections(cover: CoverMap): Detection[] {
  return [
    ...blobsFromCover(cover, "urban", 0.008, "building / structure"),
    ...blobsFromCover(cover, "water", 0.008, "water body"),
    ...blobsFromCover(cover, "vegetation", 0.05, "vegetation patch"),
  ].slice(0, 40);
}

export async function computeChange(
  beforeSrc: string,
  afterSrc: string,
  maxEdge = 360,
): Promise<ChangeResult> {
  const [a, b] = await Promise.all([loadHtmlImage(beforeSrc), loadHtmlImage(afterSrc)]);
  const A = drawToContext(a, maxEdge);
  const B = drawToContext(b, maxEdge);
  const w = Math.min(A.canvas.width, B.canvas.width);
  const h = Math.min(A.canvas.height, B.canvas.height);
  if (A.canvas.width !== w || A.canvas.height !== h) {
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    tmp.getContext("2d")!.drawImage(A.canvas, 0, 0, w, h);
    A.canvas = tmp;
  }
  if (B.canvas.width !== w || B.canvas.height !== h) {
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    tmp.getContext("2d")!.drawImage(B.canvas, 0, 0, w, h);
    B.canvas = tmp;
  }
  const da = A.canvas.getContext("2d")!.getImageData(0, 0, w, h).data;
  const db = B.canvas.getContext("2d")!.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  let changed = 0;
  for (let i = 0, p = 0; i < da.length; i += 4, p++) {
    const dr = da[i]! - db[i]!;
    const dg = da[i + 1]! - db[i + 1]!;
    const dbb = da[i + 2]! - db[i + 2]!;
    const mag = Math.sqrt(dr * dr + dg * dg + dbb * dbb);
    if (mag > 42) {
      mask[p] = Math.min(255, mag);
      changed += 1;
    }
  }
  const percent = (changed / (w * h)) * 100;
  const coverA = await computeCover(beforeSrc, maxEdge);
  const coverB = await computeCover(afterSrc, maxEdge);
  const vegDelta = coverB.percents.vegetation - coverA.percents.vegetation;
  const urbanDelta = coverB.percents.urban - coverA.percents.urban;
  const waterDelta = coverB.percents.water - coverA.percents.water;
  const parts: string[] = [];
  if (vegDelta < -4) parts.push(`vegetation down ${Math.abs(vegDelta).toFixed(1)} pts`);
  else if (vegDelta > 4) parts.push(`vegetation up ${vegDelta.toFixed(1)} pts`);
  if (urbanDelta > 3) parts.push(`built-up up ${urbanDelta.toFixed(1)} pts`);
  if (waterDelta > 3) parts.push(`water up ${waterDelta.toFixed(1)} pts`);
  const summary =
    parts.length > 0
      ? `${percent.toFixed(1)}% of pixels shifted. ${parts.join("; ")}.`
      : `${percent.toFixed(1)}% of pixels shifted between the two captures.`;

  const regions: ChangeResult["regions"] = blobsFromCover(
    {
      ...coverB,
      mask: mask.map((v) => (v > 0 ? CLASS_ID.urban : CLASS_ID.other)) as Uint8Array,
      width: w,
      height: h,
    },
    "urban",
    0.006,
    "changed region",
  ).map((d) => ({ label: d.label, bbox: d.bbox, percent: d.confidence * 10 }));

  return { percent, summary, regions, mask, width: w, height: h };
}

export function coverToSegments(cover: CoverMap) {
  return LAND_CLASSES.filter((c) => c !== "other" || cover.percents[c] > 8).map((c) => ({
    label: CLASS_META[c].label,
    classId: c,
    coveragePct: cover.percents[c],
    color: CLASS_META[c].hex,
  }));
}

export function inferIntent(question: string, hasPair: boolean): AnalysisResult["intent"] {
  const q = question.toLowerCase();
  if (hasPair && /change|deforest|new construction|before|after|clear/.test(q)) return "change";
  if (/detect|how many|count|building|ship|vehicle|road/.test(q)) return "detect";
  if (/segment|mask|highlight|show me water|show me veg/.test(q)) return "segment";
  if (/percent|coverage|area|statistic|how much/.test(q)) return "stats";
  if (/flood/.test(q)) return "segment";
  return "describe";
}

export function composeLocalAnswer(
  question: string,
  cover: CoverMap,
  detections: Detection[],
  change?: ChangeResult,
): string {
  const ranked = [...LAND_CLASSES]
    .map((c) => ({ c, p: cover.percents[c] }))
    .sort((a, b) => b.p - a.p);
  const coverLine = ranked
    .filter((x) => x.p >= 1.5)
    .map((x) => `${CLASS_META[x.c].label} ${x.p.toFixed(1)}%`)
    .join(", ");
  const top = ranked[0];
  const water = cover.percents.water;
  const veg = cover.percents.vegetation;
  const urban = cover.percents.urban;
  const q = question.toLowerCase();
  const nBuild = detections.filter((d) => /build|struct/i.test(d.label)).length;
  const nWater = detections.filter((d) => /water/i.test(d.label)).length;

  if (/flood/.test(q)) {
    if (water >= 18) {
      return `Yes — this scene reads as inundated. Water / turbid flood occupies about ${water.toFixed(1)}% of the frame, with remaining ground split between vegetation (${veg.toFixed(1)}%) and built-up or bare surfaces. Isolated bright patches inside the water are consistent with rooftops or high ground. Land cover: ${coverLine}.`;
    }
    return `Flood signal is limited. Water covers about ${water.toFixed(1)}% of the image, which looks more like a river, harbor, or wet field than a widespread inundation. Land cover: ${coverLine}.`;
  }
  if (/change|deforest|new construction/.test(q) && change) {
    return `${change.summary} Dominant cover now: ${coverLine}. ${nBuild ? `${nBuild} built-up patches are outlined.` : "No large new structure clusters stood out."}`;
  }
  if (/detect|how many|count|building/.test(q)) {
    return `I outlined ${detections.length} object regions (${nBuild} built-up, ${nWater} water). Built-up surfaces are ${urban.toFixed(1)}% of the scene. These are spectral blobs, not a trained detector — use the boxes as a first pass. Land cover: ${coverLine}.`;
  }
  if (/segment|water body|vegetation|cover/.test(q) || /percent|area|statistic/.test(q)) {
    return `Land-cover mix for this scene: ${coverLine}. ${
      top ? `${CLASS_META[top.c].label} is the largest class.` : ""
    } Overlays are on — toggle classes in the legend.`;
  }
  if (/landing/.test(q)) {
    return `Open ground is the bare-soil + low-vegetation mix (${(cover.percents.bare + Math.max(0, veg - urban)).toFixed(1)}% combined heuristic). Avoid the ${urban.toFixed(1)}% built-up and ${water.toFixed(1)}% water. Check the cover overlay for the largest contiguous pale patches.`;
  }
  return `This looks like a ${top ? CLASS_META[top.c].label.toLowerCase() + "-led" : "mixed"} scene. Land cover: ${coverLine}. ${
    detections.length ? `${detections.length} candidate objects are available if you ask to detect them.` : ""
  } Ask to segment, count buildings, or run change detection for a tighter readout.`;
}


export async function thumbnailDataUrl(src: string, maxEdge = 768, quality = 0.72) {
  const img = await loadHtmlImage(src);
  const { canvas } = drawToContext(img, maxEdge);
  return canvas.toDataURL("image/jpeg", quality);
}

export function paintCoverOverlay(
  canvas: HTMLCanvasElement,
  cover: CoverMap,
  visible: Partial<Record<LandClass, boolean>>,
  alpha = 0.42,
) {
  const ctx = canvas.getContext("2d")!;
  if (canvas.width !== cover.width || canvas.height !== cover.height) {
    canvas.width = cover.width;
    canvas.height = cover.height;
  }
  const img = ctx.createImageData(cover.width, cover.height);
  const d = img.data;
  for (let i = 0; i < cover.mask.length; i++) {
    const cls = LAND_CLASSES[cover.mask[i]!] ?? "other";
    if (visible[cls] === false) continue;
    if (cls === "other" && visible.other !== true) continue;
    const [r, g, b] = CLASS_META[cls].rgb;
    const o = i * 4;
    d[o] = r;
    d[o + 1] = g;
    d[o + 2] = b;
    d[o + 3] = Math.round(alpha * 255);
  }
  ctx.putImageData(img, 0, 0);
}

export function paintChangeOverlay(canvas: HTMLCanvasElement, change: ChangeResult) {
  if (!change.mask || !change.width || !change.height) return;
  const ctx = canvas.getContext("2d")!;
  canvas.width = change.width;
  canvas.height = change.height;
  const img = ctx.createImageData(change.width, change.height);
  const d = img.data;
  for (let i = 0; i < change.mask.length; i++) {
    const v = change.mask[i]!;
    if (!v) continue;
    const o = i * 4;
    d[o] = 220;
    d[o + 1] = 70;
    d[o + 2] = 50;
    d[o + 3] = Math.min(200, 50 + v);
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Map a natural-language question to the land-cover class it targets, if any.
 * Used to tint + box the region the person is asking about (e.g. "water").
 */
export function classFromQuestion(question: string): LandClass | undefined {
  const q = question.toLowerCase();
  if (/\bwater\b|\bflood|\briver\b|\blake\b|\bsea\b|\bocean\b|\bharbo(?:u)?r\b|\bcoast\b|\bwet\b/.test(q))
    return "water";
  if (/\b(?:building|structure|urban|built[- ]?up|roof|road|street|city)\b/.test(q))
    return "urban";
  if (/\b(?:veg|tree|forest|grass|plant|green|crop|farm|agricultur)/.test(q))
    return "vegetation";
  if (/\bbare\b|\bsoil\b|\bsand\b|\bdirt\b/.test(q)) return "bare";
  return undefined;
}

/** Whether a detection's label belongs to the given land-cover class. */
export function detectionMatchesClass(d: Detection, cls: LandClass): boolean {
  const l = d.label.toLowerCase();
  switch (cls) {
    case "water":
      return /water|flood|river|lake|sea/.test(l);
    case "urban":
      return /build|struct|urban|road/.test(l);
    case "vegetation":
      return /veg|tree|forest|grass|crop|plant/.test(l);
    case "bare":
      return /bare|soil|sand|dirt/.test(l);
    default:
      return false;
  }
}

/** Paint a tint over ONLY the target class — the "highlight the matching area" overlay. */
export function paintHighlightOverlay(
  canvas: HTMLCanvasElement,
  cover: CoverMap,
  classId: LandClass,
  alpha = 0.5,
) {
  const ctx = canvas.getContext("2d")!;
  canvas.width = cover.width;
  canvas.height = cover.height;
  const target = CLASS_ID[classId];
  const [r, g, b] = CLASS_META[classId].rgb;
  const img = ctx.createImageData(cover.width, cover.height);
  const d = img.data;
  for (let i = 0; i < cover.mask.length; i++) {
    if (cover.mask[i] !== target) continue;
    const o = i * 4;
    d[o] = r;
    d[o + 1] = g;
    d[o + 2] = b;
    d[o + 3] = Math.round(alpha * 255);
  }
  ctx.putImageData(img, 0, 0);
}
