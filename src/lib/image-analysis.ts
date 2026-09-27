import {
  CLASS_META,
  LAND_CLASSES,
  type AnalysisResult,
  type BBox,
  type CoverMap,
  type Detection,
  type ExtractedItem,
  type LandClass,
  type ChangeResult,
  type QueryTarget,
  type TintMap,
} from "./types";
import { clamp, formatArea, uid } from "./utils";

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
  minFrac = 0.002,
  label: string,
  color?: string,
): Detection[] {
  const { width: w, height: h, mask } = cover;
  const target = CLASS_ID[classId];
  const visited = new Uint8Array(w * h);
  const minArea = Math.max(8, Math.floor(w * h * minFrac));
  const candidates: Array<{ area: number; det: Detection }> = [];

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
        const n = [cur - 1, cur + 1, cur - w, cur + w];
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
      candidates.push({
        area,
        det: {
          id: uid("det"),
          label,
          confidence: Math.min(0.96, 0.62 + (area / (w * h)) * 6),
          bbox: [minX / w, minY / h, bw / w, bh / h],
          source: "local",
          classId,
          color: color ?? CLASS_META[classId].hex,
          highlighted: true,
        },
      });
    }
  }
  return candidates
    .sort((a, b) => b.area - a.area)
    .slice(0, 28)
    .map((c) => c.det);
}

export function cleanTargetNoun(question: string): string {
  const cleaned = question
    .trim()
    .replace(/[?.!]+$/g, "")
    .replace(
      /^(please\s+)?(can you\s+|could you\s+)?(show\s+me|highlight|find|detect|locate|segment|extract|give\s+me|point\s+out|identify|count|how\s+many|where\s+is|where\s+are|what\s+is|search\s+for|look\s+for)\s+(all\s+)?(the\s+)?/i,
      "",
    )
    .replace(/\s+(in\s+this\s+(image|scene|area|photo)|and\s+(give|report|show|highlight).*)$/i, "")
    .trim();
  if (!cleaned || cleaned.length > 44) return "Requested area";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function parseQueryTarget(question: string, hasPair: boolean): QueryTarget {
  const q = question.toLowerCase();

  if (hasPair && /change|deforest|new construction|before|after|clear|diff/.test(q)) {
    return {
      targetLabel: "Changed areas",
      isSpecificTarget: true,
      highlightClasses: ["bare", "urban"],
      highlightChange: true,
      colorHex: "#f97316",
      rgb: [249, 115, 22],
    };
  }
  if (/ship|boat|vessel|yacht|barge|ferry|marina|harbor|dock|pier/.test(q)) {
    return {
      targetLabel: /marina|harbor|dock|pier/.test(q) ? "Harbor & vessels" : "Ships & vessels",
      isSpecificTarget: true,
      highlightClasses: ["water", "urban"],
      highlightChange: false,
      colorHex: "#06b6d4",
      rgb: [6, 182, 212],
    };
  }
  if (/flood|inundat|submerg|overflow/.test(q)) {
    return {
      targetLabel: "Flooded / water areas",
      isSpecificTarget: true,
      highlightClasses: ["water"],
      highlightChange: false,
      colorHex: "#38bdf8",
      rgb: [56, 189, 248],
    };
  }
  if (/water|river|lake|sea|ocean|canal|stream|pond|reservoir|coast|shore|wet/.test(q) && !/land-cover stats/i.test(q)) {
    return {
      targetLabel: /river|canal|stream/.test(q) ? "Rivers & waterways" : "Water bodies",
      isSpecificTarget: true,
      highlightClasses: ["water"],
      highlightChange: false,
      colorHex: "#38bdf8",
      rgb: [56, 189, 248],
    };
  }
  if (/road|street|highway|bridge|interchange|runway|path|track/.test(q)) {
    return {
      targetLabel: /bridge/.test(q) ? "Bridges & crossings" : "Roads & corridors",
      isSpecificTarget: true,
      highlightClasses: ["urban"],
      highlightChange: false,
      colorHex: "#f59e0b",
      rgb: [245, 158, 11],
    };
  }
  if (/build|house|roof|struct|urban|city|warehouse|industrial|commercial|residential|block/.test(q) && !/few buildings/i.test(q)) {
    return {
      targetLabel: /roof/.test(q) ? "Rooftops & buildings" : "Buildings & built-up area",
      isSpecificTarget: true,
      highlightClasses: ["urban"],
      highlightChange: false,
      colorHex: "#f59e0b",
      rgb: [245, 158, 11],
    };
  }
  if (/tree|forest|veg|crop|field|farm|agricult|grass|park|canopy|plant|green|orchard/.test(q) && !/low vegetation/i.test(q)) {
    return {
      targetLabel: /crop|field|farm|agricult/.test(q) ? "Crop fields & farmland" : "Vegetation & canopy",
      isSpecificTarget: true,
      highlightClasses: ["vegetation"],
      highlightChange: false,
      colorHex: "#22c55e",
      rgb: [34, 197, 94],
    };
  }
  if (/landing|bare|soil|sand|beach|dirt|clearing|open ground|lot|empty|arid/.test(q)) {
    return {
      targetLabel: /landing/.test(q)
        ? "Open landing zones"
        : /beach|sand/.test(q)
          ? "Sand & beach zones"
          : "Bare soil & open ground",
      isSpecificTarget: true,
      highlightClasses: ["bare"],
      highlightChange: false,
      colorHex: "#eab308",
      rgb: [234, 179, 8],
    };
  }
  if (/^describe|what stands out|land-cover stats|statistics|overview|summary/i.test(q.trim())) {
    return {
      targetLabel: "Land-cover areas",
      isSpecificTarget: false,
      highlightClasses: ["water", "vegetation", "urban", "bare"],
      highlightChange: Boolean(hasPair),
      colorHex: "#38bdf8",
      rgb: [56, 189, 248],
    };
  }

  const customNoun = cleanTargetNoun(question);
  return {
    targetLabel: customNoun,
    isSpecificTarget: true,
    highlightClasses: ["urban", "water", "vegetation", "bare"],
    highlightChange: false,
    colorHex: "#38bdf8",
    rgb: [56, 189, 248],
  };
}

export async function detectSalientForCustomQuery(
  src: string,
  cover: CoverMap,
  question: string,
  targetLabel: string,
): Promise<{ detections: Detection[]; pixelMask: Uint8Array }> {
  const q = question.toLowerCase();
  const img = await loadHtmlImage(src);
  const { canvas, ctx } = drawToContext(img, cover.width);
  const { width: w, height: h } = canvas;
  const data = ctx.getImageData(0, 0, w, h).data;
  const matchMask = new Uint8Array(w * h);

  const wantsShip = /ship|boat|vessel|yacht|barge|ferry/.test(q);
  const wantsBright = /bright|white|silver|metal|solar|glint|car|vehicle|plane|aircraft|ship|boat|roof/.test(q);
  const wantsDark = /dark|shadow|oil|pond|asphalt|tarmac/.test(q);
  const wantsRed = /red|orange|terracotta|tile|brick|rust/.test(q);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const i = p * 4;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const bright = (r + g + b) / 3;

      if (wantsShip) {
        if (bright > 140) {
          let nearWater = false;
          for (let dy = -4; dy <= 4 && !nearWater; dy += 2) {
            for (let dx = -4; dx <= 4; dx += 2) {
              const ny = y + dy;
              const nx = x + dx;
              if (ny >= 0 && ny < h && nx >= 0 && nx < w) {
                if (cover.mask[ny * w + nx] === CLASS_ID.water) {
                  nearWater = true;
                  break;
                }
              }
            }
          }
          if (nearWater) matchMask[p] = 255;
        }
      } else if (wantsRed) {
        if (r > 135 && r > g * 1.25 && r > b * 1.35) matchMask[p] = 255;
      } else if (wantsDark) {
        if (bright < 52) matchMask[p] = 255;
      } else if (wantsBright) {
        if (bright > 190) matchMask[p] = 255;
      } else {
        const iLeft = (p - 1) * 4;
        const iUp = (p - w) * 4;
        const diff =
          Math.abs(r - data[iLeft]!) +
          Math.abs(g - data[iLeft + 1]!) +
          Math.abs(b - data[iLeft + 2]!) +
          Math.abs(r - data[iUp]!) +
          Math.abs(g - data[iUp + 1]!) +
          Math.abs(b - data[iUp + 2]!);
        if (diff > 145 && bright > 95) matchMask[p] = 255;
      }
    }
  }

  const visited = new Uint8Array(w * h);
  const out: Array<{ area: number; det: Detection }> = [];
  const minArea = wantsShip ? 4 : 12;
  const maxArea = wantsShip ? w * h * 0.04 : w * h * 0.25;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (visited[i] || !matchMask[i]) continue;
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
        const neighbors = [cur - 1, cur + 1, cur - w, cur + w];
        for (const ni of neighbors) {
          if (ni < 0 || ni >= w * h || visited[ni] || !matchMask[ni]) continue;
          const nx = ni % w;
          if (Math.abs(nx - cx) + Math.abs(((ni / w) | 0) - cy) !== 1) continue;
          visited[ni] = 1;
          stack.push(ni);
        }
      }
      if (area < minArea || area > maxArea) continue;
      const bw = Math.max(4, maxX - minX + 1);
      const bh = Math.max(4, maxY - minY + 1);
      out.push({
        area,
        det: {
          id: uid("det"),
          label: targetLabel.replace(/s$/i, ""),
          confidence: Math.min(0.94, 0.68 + (area / (w * h)) * 12),
          bbox: [clamp(minX / w, 0, 0.98), clamp(minY / h, 0, 0.98), clamp(bw / w, 0.015, 1), clamp(bh / h, 0.015, 1)],
          source: "local",
          color: "#38bdf8",
          highlighted: true,
        },
      });
    }
  }

  return {
    detections: out
      .sort((a, b) => b.area - a.area)
      .slice(0, 20)
      .map((x) => x.det),
    pixelMask: matchMask,
  };
}

function smoothBinaryMask(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const row = (y + dy) * w;
        for (let dx = -1; dx <= 1; dx++) {
          if (mask[row + x + dx]! > 0) count++;
        }
      }
      if (count >= 4 || (mask[idx]! > 0 && count >= 3)) {
        out[idx] = 255;
      }
    }
  }
  return out;
}

export async function buildQueryTintMap(
  src: string,
  cover: CoverMap,
  question: string,
  target: QueryTarget,
  detections: Detection[],
  change?: ChangeResult,
): Promise<TintMap> {
  const w = cover.width;
  const h = cover.height;
  const rawMask = new Uint8Array(w * h);

  if (target.highlightChange && change?.mask && change.width === w && change.height === h) {
    for (let i = 0; i < rawMask.length; i++) {
      if (change.mask[i]! > 0) rawMask[i] = 255;
    }
  } else if (target.isSpecificTarget && target.highlightClasses.length === 1) {
    const targetClsId = CLASS_ID[target.highlightClasses[0]!];
    for (let i = 0; i < cover.mask.length; i++) {
      if (cover.mask[i] === targetClsId) rawMask[i] = 255;
    }
  } else if (/ship|boat|vessel|yacht|barge|ferry/.test(question.toLowerCase())) {
    const custom = await detectSalientForCustomQuery(src, cover, question, target.targetLabel);
    for (let i = 0; i < rawMask.length; i++) {
      if (custom.pixelMask[i]! > 0) rawMask[i] = 255;
    }
  } else if (target.isSpecificTarget) {
    const custom = await detectSalientForCustomQuery(src, cover, question, target.targetLabel);
    for (let i = 0; i < rawMask.length; i++) {
      if (custom.pixelMask[i]! > 0) rawMask[i] = 255;
    }
  } else {
    // Dominant land-cover class when user asks a general question
    const topClass = [...LAND_CLASSES]
      .filter((c) => c !== "other")
      .sort((a, b) => cover.percents[b] - cover.percents[a])[0];
    if (topClass) {
      const targetClsId = CLASS_ID[topClass];
      for (let i = 0; i < cover.mask.length; i++) {
        if (cover.mask[i] === targetClsId) rawMask[i] = 255;
      }
    }
  }

  // Also blend in any VLM-detected or local region areas with soft organic elliptical/region fill
  // if the pixel mask has very low coverage or if detections are from the VLM model
  let activeCount = 0;
  for (let i = 0; i < rawMask.length; i++) {
    if (rawMask[i]! > 0) activeCount++;
  }

  const hasModelDetections = detections.some((d) => d.source === "model");
  if (activeCount < w * h * 0.004 || hasModelDetections) {
    for (const d of detections) {
      if (!hasModelDetections && activeCount >= w * h * 0.004) break;
      const [bx, by, bw, bh] = d.bbox;
      const x0 = Math.max(0, Math.floor(bx * w));
      const y0 = Math.max(0, Math.floor(by * h));
      const x1 = Math.min(w - 1, Math.ceil((bx + bw) * w));
      const y1 = Math.min(h - 1, Math.ceil((by + bh) * h));
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const rx = Math.max(2, (x1 - x0) / 2);
      const ry = Math.max(2, (y1 - y0) / 2);

      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const normDist = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
          if (normDist <= 1.05) {
            rawMask[y * w + x] = 255;
          }
        }
      }
    }
  }

  const mask = smoothBinaryMask(rawMask, w, h);
  let finalCount = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]! > 0) finalCount++;
  }

  return {
    width: w,
    height: h,
    mask,
    colorHex: target.colorHex,
    rgb: target.rgb,
    coveragePct: (finalCount / (w * h)) * 100,
  };
}

export async function detectForQuery(
  src: string,
  cover: CoverMap,
  question: string,
  target: QueryTarget,
  change?: ChangeResult,
): Promise<Detection[]> {
  const q = question.toLowerCase();

  if (target.highlightChange && change && change.regions.length > 0) {
    return change.regions.map((r) => ({
      id: uid("chg"),
      label: r.label || "changed area",
      confidence: Math.min(0.95, 0.72 + (r.percent ?? 5) / 100),
      bbox: r.bbox,
      source: "local" as const,
      color: "#f97316",
      highlighted: true,
    }));
  }

  if (/ship|boat|vessel|yacht|barge|ferry/.test(q)) {
    const ships = await detectSalientForCustomQuery(src, cover, question, "Ship / vessel");
    if (ships.detections.length > 0) return ships.detections;
  }

  if (target.isSpecificTarget && target.highlightClasses.length === 1) {
    const cls = target.highlightClasses[0]!;
    const labelMap: Record<LandClass, string> = {
      water: /flood/.test(q) ? "Flooded area" : "Water area",
      vegetation: /crop|field|farm/.test(q) ? "Crop field" : "Vegetation area",
      urban: /road|street|highway/.test(q)
        ? "Road / corridor"
        : /bridge/.test(q)
          ? "Bridge / structure"
          : /roof/.test(q)
            ? "Building rooftop"
            : "Built-up area",
      bare: /landing/.test(q) ? "Open landing zone" : /beach|sand/.test(q) ? "Sand / beach" : "Bare soil area",
      other: target.targetLabel,
    };
    const found = blobsFromCover(cover, cls, 0.0018, labelMap[cls], target.colorHex);
    if (found.length > 0) return found;
  }

  if (target.isSpecificTarget) {
    const custom = await detectSalientForCustomQuery(src, cover, question, target.targetLabel);
    if (custom.detections.length > 0) return custom.detections;
  }

  return localDetections(cover);
}

export function localDetections(cover: CoverMap): Detection[] {
  return [
    ...blobsFromCover(cover, "urban", 0.006, "Built-up area", "#f59e0b"),
    ...blobsFromCover(cover, "water", 0.006, "Water body", CLASS_META.water.hex),
    ...blobsFromCover(cover, "vegetation", 0.03, "Vegetation zone", CLASS_META.vegetation.hex),
    ...blobsFromCover(cover, "bare", 0.015, "Bare ground", CLASS_META.bare.hex),
  ].slice(0, 32);
}

export async function extractDetectionCrops(
  src: string,
  detections: Detection[],
  gsdMeters: number,
  tint?: TintMap,
  maxItems = 12,
): Promise<ExtractedItem[]> {
  if (detections.length === 0) return [];
  const img = await loadHtmlImage(src);
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;

  // Prepare an offscreen tinted overlay canvas if tint is available
  let tintCanvas: HTMLCanvasElement | null = null;
  if (tint) {
    tintCanvas = document.createElement("canvas");
    paintTintOverlay(tintCanvas, tint, 0.44);
  }

  const items: ExtractedItem[] = [];

  for (let idx = 0; idx < Math.min(maxItems, detections.length); idx++) {
    const d = detections[idx]!;
    const [bx, by, bw, bh] = d.bbox;
    const pxX = bx * iw;
    const pxY = by * ih;
    const pxW = Math.max(8, bw * iw);
    const pxH = Math.max(8, bh * ih);

    // Add 25% visual context padding around the crop
    const padX = Math.max(14, pxW * 0.25);
    const padY = Math.max(14, pxH * 0.25);
    const sx = Math.max(0, Math.floor(pxX - padX));
    const sy = Math.max(0, Math.floor(pxY - padY));
    const sw = Math.min(iw - sx, Math.ceil(pxW + padX * 2));
    const sh = Math.min(ih - sy, Math.ceil(pxH + padY * 2));

    const thumbMax = 220;
    const scale = Math.min(2, thumbMax / Math.max(sw, sh, 1));
    const cw = Math.max(64, Math.round(sw * scale));
    const ch = Math.max(64, Math.round(sh * scale));

    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);

    // Cover the matched area inside the cutout with the smooth tinted color (no bounding boxes!)
    if (tintCanvas && tint) {
      const tsx = (sx / iw) * tint.width;
      const tsy = (sy / ih) * tint.height;
      const tsw = (sw / iw) * tint.width;
      const tsh = (sh / ih) * tint.height;
      ctx.drawImage(tintCanvas, tsx, tsy, tsw, tsh, 0, 0, cw, ch);
    } else {
      const rx = ((pxX - sx) / sw) * cw;
      const ry = ((pxY - sy) / sh) * ch;
      const rw = (pxW / sw) * cw;
      const rh = (pxH / sh) * ch;
      const color = d.color || "#38bdf8";
      ctx.fillStyle = `${color}66`;
      ctx.fillRect(rx, ry, rw, rh);
    }

    const widthM = Math.max(1, Math.round(pxW * gsdMeters));
    const heightM = Math.max(1, Math.round(pxH * gsdMeters));
    const areaText = formatArea(pxW * pxH, gsdMeters);
    const cxPct = ((bx + bw / 2) * 100).toFixed(1);
    const cyPct = ((by + bh / 2) * 100).toFixed(1);

    items.push({
      id: d.id,
      index: idx + 1,
      label: `${d.label} #${idx + 1}`,
      confidence: d.confidence,
      bbox: d.bbox,
      cropDataUrl: canvas.toDataURL("image/png"),
      dimensionsText: `${widthM}m × ${heightM}m`,
      areaText,
      centerText: `${cxPct}%, ${cyPct}%`,
      color: tint?.colorHex || d.color || "#38bdf8",
      classId: d.classId,
    });
  }

  return items;
}

export async function renderHighlightedSnapshot(
  src: string,
  cover: CoverMap | undefined,
  tint: TintMap | undefined,
  target: QueryTarget,
  change?: ChangeResult,
): Promise<string> {
  const img = await loadHtmlImage(src);
  const { canvas, ctx } = drawToContext(img, 900);
  const w = canvas.width;
  const h = canvas.height;

  // Just cover the matched area with a clean tinted color overlay — no boxes, no text clutter, no dark dimming!
  if (tint) {
    const tmp = document.createElement("canvas");
    paintTintOverlay(tmp, tint, 0.48);
    ctx.drawImage(tmp, 0, 0, w, h);
  } else if (target.highlightChange && change?.mask) {
    const tmp = document.createElement("canvas");
    paintChangeOverlay(tmp, change);
    ctx.drawImage(tmp, 0, 0, w, h);
  } else if (cover) {
    const visible: Partial<Record<LandClass, boolean>> = {
      water: true,
      vegetation: true,
      urban: true,
      bare: true,
      other: false,
    };
    const tmp = document.createElement("canvas");
    paintCoverOverlay(tmp, cover, visible, 0.44);
    ctx.drawImage(tmp, 0, 0, w, h);
  }

  return canvas.toDataURL("image/jpeg", 0.88);
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
    0.004,
    "Changed region",
    "#f97316",
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
  if (/detect|how many|count|building|ship|vehicle|road|find|where|locate|give me|show me|highlight/.test(q)) return "segment";
  if (/segment|mask|water|veg/.test(q)) return "segment";
  if (/percent|coverage|area|statistic|how much/.test(q)) return "stats";
  if (/flood/.test(q)) return "segment";
  return "describe";
}

export function composeLocalAnswer(
  question: string,
  cover: CoverMap,
  tint: TintMap,
  target: QueryTarget,
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

  if (/flood/.test(q)) {
    if (water >= 18) {
      return `Tinted the inundated / water areas (${water.toFixed(1)}% of the frame) directly on the satellite image and prepared the tinted result for you below. Remaining ground is split between vegetation (${veg.toFixed(1)}%) and built-up or bare surfaces.`;
    }
    return `Tinted the water areas (${water.toFixed(1)}% of the scene) on the map and prepared the tinted view below. Flood signal is localized rather than widespread inundation. Land cover: ${coverLine}.`;
  }
  if ((/change|deforest|new construction/.test(q) || target.highlightChange) && change) {
    return `Covered the changed areas (${change.percent.toFixed(1)}% of scene) with a tinted color overlay and included the result below. ${change.summary}`;
  }
  if (target.isSpecificTarget) {
    return `Covered the ${target.targetLabel.toLowerCase()} (${tint.coveragePct.toFixed(1)}% of the scene) with a tinted color overlay on the map and delivered the tinted image and regions below.`;
  }
  if (/segment|water body|vegetation|cover/.test(q) || /percent|area|statistic/.test(q)) {
    return `Land-cover mix for this scene: ${coverLine}. ${
      top ? `${CLASS_META[top.c].label} is the largest class.` : ""
    } Tinted the matching areas on the viewer and included the tinted image below.`;
  }
  if (/landing/.test(q)) {
    return `Covered candidate open landing zones (${tint.coveragePct.toFixed(1)}% of the scene) with a tinted color overlay, avoiding the ${urban.toFixed(1)}% built-up and ${water.toFixed(1)}% water zones.`;
  }
  return `This is a ${top ? CLASS_META[top.c].label.toLowerCase() + "-led" : "mixed"} scene (${coverLine}). The requested areas are covered with a tinted color overlay on the viewer and ready to download below.`;
}

export async function thumbnailDataUrl(src: string, maxEdge = 768, quality = 0.72) {
  const img = await loadHtmlImage(src);
  const { canvas } = drawToContext(img, maxEdge);
  return canvas.toDataURL("image/jpeg", quality);
}

export function paintTintOverlay(
  canvas: HTMLCanvasElement,
  tint: TintMap,
  alpha = 0.46,
  focusBBox?: BBox | null,
) {
  const ctx = canvas.getContext("2d")!;
  const w = tint.width;
  const h = tint.height;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const [r, g, b] = tint.rgb;
  const fillAlpha = Math.round(alpha * 255);
  const edgeAlpha = Math.min(240, Math.round(alpha * 1.45 * 255));

  const fx0 = focusBBox ? Math.floor(focusBBox[0] * w) : 0;
  const fy0 = focusBBox ? Math.floor(focusBBox[1] * h) : 0;
  const fx1 = focusBBox ? Math.ceil((focusBBox[0] + focusBBox[2]) * w) : w;
  const fy1 = focusBBox ? Math.ceil((focusBBox[1] + focusBBox[3]) * h) : h;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (tint.mask[i] === 0) continue;

      const isEdge =
        x === 0 ||
        y === 0 ||
        x === w - 1 ||
        y === h - 1 ||
        tint.mask[i - 1] === 0 ||
        tint.mask[i + 1] === 0 ||
        tint.mask[i - w] === 0 ||
        tint.mask[i + w] === 0;

      const inFocus = !focusBBox || (x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1);
      const o = i * 4;
      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = b;
      const baseA = isEdge ? edgeAlpha : fillAlpha;
      d[o + 3] = inFocus ? (focusBBox ? Math.min(235, Math.round(baseA * 1.25)) : baseA) : Math.round(baseA * 0.45);
    }
  }
  ctx.putImageData(img, 0, 0);
}

export function paintCoverOverlay(
  canvas: HTMLCanvasElement,
  cover: CoverMap,
  visible: Partial<Record<LandClass, boolean>>,
  alpha = 0.44,
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
    d[o] = 249;
    d[o + 1] = 115;
    d[o + 2] = 22;
    d[o + 3] = Math.min(210, 65 + v);
  }
  ctx.putImageData(img, 0, 0);
}
