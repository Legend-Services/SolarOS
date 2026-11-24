import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./lib/migrateStorage";
import App from "./App";
import "./index.css";
import { useCapabilities } from "./store/capabilitiesStore";

void useCapabilities.getState().load(); // public endpoint: labels and feature gates are ready before sign-in

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
