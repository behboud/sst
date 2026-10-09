const port = Number.parseInt(process.env.PORT ?? "8081", 10);
const buildMarker = process.env.BUILD_MARKER ?? "unset";

Bun.serve({
  hostname: "0.0.0.0",
  port,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ ok: true });
    if (path === "/build") return Response.json({ buildMarker });
    return Response.json({ error: "not found" }, { status: 404 });
  },
});

console.log(
  `Sidecar listening on 0.0.0.0:${port}; build marker=${buildMarker}`,
);
