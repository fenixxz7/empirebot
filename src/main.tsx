import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import Stats from "./pages/Stats";
import "./index.css";

const isStats = window.location.pathname.startsWith("/stats");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isStats ? <Stats /> : <App />}
  </StrictMode>
);
