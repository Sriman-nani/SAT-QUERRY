export type LandClass = "water" | "vegetation" | "urban" | "bare" | "other";

export const LAND_CLASSES: LandClass[] = [
  "water",
  "vegetation",
  "urban",
  "bare",
  "other",
];

export const CLASS_META: Record<
  LandClass,
  { label: string; hex: string; rgb: [number, number, number] }
> = {
  water: { label: "Water", hex: "#3d7ca6", rgb: [61, 124, 166] },
  vegetation: { label: "Vegetation", hex: "#4a8a5a", rgb: [74, 138, 90] },
  urban: { label: "Built-up", hex: "#c4a574", rgb: [196, 165, 116] },
  bare: { label: "Bare soil", hex: "#a07a4a", rgb: [160, 122, 74] },
  other: { label: "Other", hex: "#6a7270", rgb: [106, 114, 112] },
};

export type BBox = [number, number, number, number];

export type Detection = {
  id: string;
  label: string;
  confidence: number;
  bbox: BBox;
  source: "local" | "model";
  classId?: LandClass;
  color?: string;
  highlighted?: boolean;
};

export type ExtractedItem = {
  id: string;
  index: number;
  label: string;
  confidence: number;
  bbox: BBox;
  cropDataUrl: string;
  dimensionsText: string;
  areaText: string;
  centerText: string;
  color: string;
  classId?: LandClass;
};

export type QueryTarget = {
  targetLabel: string;
  isSpecificTarget: boolean;
  highlightClasses: LandClass[];
  highlightChange: boolean;
  colorHex: string;
  rgb: [number, number, number];
};

export type TintMap = {
  width: number;
  height: number;
  mask: Uint8Array;
  colorHex: string;
  rgb: [number, number, number];
  coveragePct: number;
};

export type SegmentStat = {
  label: string;
  classId?: LandClass;
  coveragePct: number;
  color: string;
};

export type StatRow = {
  name: string;
  value: string;
  hint?: string;
};

export type ChangeRegion = {
  label: string;
  bbox: BBox;
  percent?: number;
};

export type ChangeResult = {
  percent: number;
  summary: string;
  regions: ChangeRegion[];
  mask?: Uint8Array;
  width?: number;
  height?: number;
};

export type AnalysisResult = {
  answer: string;
  sceneSummary?: string;
  intent: "detect" | "segment" | "stats" | "change" | "describe";
  detections: Detection[];
  segments: SegmentStat[];
  statistics: StatRow[];
  change?: ChangeResult;
  cover?: CoverMap;
  tint?: TintMap;
  target?: QueryTarget;
  highlightedTarget?: string;
  highlightedSnapshotUrl?: string;
  extractedItems?: ExtractedItem[];
};

export type CoverMap = {
  width: number;
  height: number;
  mask: Uint8Array;
  percents: Record<LandClass, number>;
  counts: Record<LandClass, number>;
  total: number;
  histogram: { bins: number[]; r: number[]; g: number[]; b: number[] };
};

export type RasterSlot = {
  id: string;
  name: string;
  src: string;
  width: number;
  height: number;
  gsdMeters: number;
  kind: "upload" | "sample";
  note?: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  analysis?: AnalysisResult;
  createdAt: number;
};

export type ViewerMode = "primary" | "before" | "split" | "blend" | "diff";
