import { Hono } from "hono";
import { loadSettings, saveSettings } from "../storage/filesystem.js";

const settings = new Hono();

settings.get("/", async (c) => {
  return c.json(await loadSettings());
});

settings.patch("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const next = await saveSettings(body);
  return c.json(next);
});

export default settings;
