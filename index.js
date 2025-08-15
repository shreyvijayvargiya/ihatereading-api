  import { serve } from "@hono/node-server";
  import { Hono } from "hono";

  const app = new Hono();

  app.get("/", (c) => c.text("Hello World"));

  const port = process.env.PORT || 3000;

  serve({
    app: app.fetch,
    port,
  });
  export default app;
