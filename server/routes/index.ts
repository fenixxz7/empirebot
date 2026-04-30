import type { Express } from "express";
import { instancesRouter } from "./instances.js";
import { configRouter } from "./config.js";
import { orgsRouter } from "./orgs.js";
import { logsRouter } from "./logs.js";
import { discoveryRouter } from "./discovery.js";

export function mountApi(app: Express): void {
  app.use("/api/instances", instancesRouter);
  app.use("/api/config", configRouter);
  app.use("/api/orgs", orgsRouter);
  app.use("/api/logs", logsRouter);
  app.use("/api/discovery", discoveryRouter);
}
