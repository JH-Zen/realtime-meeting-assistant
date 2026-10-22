import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installBenchSeed } from "./dev/benchSeed";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");

// Before the first render, so React Flow's mount-time `fitView` frames the seeded map instead of the
// empty one it started on. Inert unless the URL carries `?bench`.
installBenchSeed();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
