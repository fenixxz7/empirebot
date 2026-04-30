import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import Stats from "./pages/Stats";
import Messages from "./pages/Messages";
import "./index.css";

const path = window.location.pathname;
const isStats = path.startsWith("/stats");
const isMessages = path.startsWith("/messages");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isStats ? <Stats /> : isMessages ? <Messages /> : <App />}
  </StrictMode>
);
