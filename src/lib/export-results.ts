import type { AnalysisResult, RasterSlot } from "./types";

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportCsv(analysis: AnalysisResult) {
  const lines = ["name,value"];
  for (const s of analysis.statistics) {
    lines.push(`"${s.name.replace(/"/g, '""')}","${s.value.replace(/"/g, '""')}"`);
  }
  for (const s of analysis.segments) {
    lines.push(`"coverage ${s.label}","${s.coveragePct.toFixed(2)}%"`);
  }
  downloadBlob(new Blob([lines.join("\n")], { type: "text/csv" }), "satquery-stats.csv");
}

export function exportGeoJson(analysis: AnalysisResult, image: RasterSlot) {
  const features = analysis.detections.map((d) => {
    const [x, y, w, h] = d.bbox;
    const coords = [
      [
        [x * image.width, y * image.height],
        [(x + w) * image.width, y * image.height],
        [(x + w) * image.width, (y + h) * image.height],
        [x * image.width, (y + h) * image.height],
        [x * image.width, y * image.height],
      ],
    ];
    return {
      type: "Feature",
      properties: { label: d.label, confidence: d.confidence, source: d.source },
      geometry: { type: "Polygon", coordinates: coords },
    };
  });
  const doc = {
    type: "FeatureCollection",
    features,
    properties: { image: image.name, crs: "pixel-space" },
  };
  downloadBlob(
    new Blob([JSON.stringify(doc, null, 2)], { type: "application/geo+json" }),
    "satquery-detections.geojson",
  );
}

export function exportJsonReport(analysis: AnalysisResult, image: RasterSlot) {
  downloadBlob(
    new Blob(
      [JSON.stringify({ image: image.name, generatedAt: new Date().toISOString(), analysis }, null, 2)],
      { type: "application/json" },
    ),
    "satquery-report.json",
  );
}

function pdfEscape(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/[^\x20-\x7E]/g, "?");
}

export function exportPdf(analysis: AnalysisResult, image: RasterSlot) {
  const lines = [
    "SatQuery AI report",
    image.name,
    new Date().toISOString(),
    "",
    analysis.answer.replace(/\s+/g, " ").slice(0, 900),
    "",
    ...analysis.statistics.map((s) => `${s.name}: ${s.value}`),
    "",
    ...analysis.segments.map((s) => `${s.label}: ${s.coveragePct.toFixed(1)}%`),
    "",
    `${analysis.detections.length} detections`,
  ];
  const wrapped: string[] = [];
  for (const line of lines) {
    const chunks = line.match(/.{1,88}/g) ?? [""];
    wrapped.push(...chunks);
  }
  const content = wrapped
    .slice(0, 42)
    .map((l, i) => `BT /F1 11 Tf 48 ${760 - i * 16} Td (${pdfEscape(l)}) Tj ET`)
    .join("\n");
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
    `4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
  ];
  let offset = 9;
  const xref = [0];
  let body = "%PDF-1.4\n";
  for (const obj of objects) {
    xref.push(offset);
    body += obj + "\n";
    offset = body.length;
  }
  const startxref = body.length;
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (const x of xref.slice(1)) body += `${String(x).padStart(10, "0")} 00000 n \n`;
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF`;
  downloadBlob(new Blob([body], { type: "application/pdf" }), "satquery-report.pdf");
}

export async function exportAnnotatedPng(source: HTMLCanvasElement) {
  source.toBlob((blob) => {
    if (!blob) return;
    downloadBlob(blob, "satquery-annotated.png");
  }, "image/png");
}

export function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  a.click();
}
