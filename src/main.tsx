import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SatQueryWorkspace } from "@/components/satquery/workspace";
import "./styles.css";

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <SatQueryWorkspace />
    </StrictMode>,
  );
}
