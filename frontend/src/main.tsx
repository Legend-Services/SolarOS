import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./lib/migrateStorage";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
