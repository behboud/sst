import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { AzureCliCredential, ManagedIdentityCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const sidecarUrl = process.env.SIDECAR_URL ?? "http://127.0.0.1:8081";
const buildMarker = process.env.BUILD_MARKER ?? "unset";
const probeTestToggles = process.env.SST_PROBE_TEST_TOGGLES === "true";
const maxProbeBodyBytes = 1_000_000;
const maxBlobWriteProbes = 5;
const maxConcurrentHolds = 20;
let blobWriteProbeCount = 0;
let activeHolds = 0;

async function readLimitedText(
  request: Request,
  maxBytes: number,
): Promise<string | undefined> {
  const reader = request.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder();
  let size = 0;
  let content = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      content += decoder.decode(value, { stream: true });
    }
    return content + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function forcedProbeFailure(probe: "live" | "ready") {
  if (probe === "ready" && process.env.SST_FORCE_UNREADY === "true") {
    return true;
  }
  if (!probeTestToggles) return false;

  const marker = `/tmp/sst-azure-service-force-${probe}-failure-until`;
  const file = Bun.file(marker);
  if (!(await file.exists())) return false;

  const expiresAt = Number(await file.text());
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
    await rm(marker, { force: true });
    return false;
  }
  return true;
}

function blobContainer() {
  const link = process.env.SST_RESOURCE_Data;
  if (!link) throw new Error("Missing SST_RESOURCE_Data link environment.");
  const { accountUrl, containerName } = JSON.parse(link) as {
    accountUrl: string;
    containerName: string;
  };
  const credential =
    process.env.SST_DEV === "true"
      ? new AzureCliCredential()
      : (() => {
          const clientId = process.env.AZURE_CLIENT_ID;
          if (!clientId) {
            throw new Error(
              "Cloud mode requires the SST-managed AZURE_CLIENT_ID.",
            );
          }
          return new ManagedIdentityCredential(clientId);
        })();
  return new BlobServiceClient(accountUrl, credential).getContainerClient(
    containerName,
  );
}

async function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

Bun.serve({
  hostname: "0.0.0.0",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/test/hold" && probeTestToggles) {
      const durationMs = Number(url.searchParams.get("ms") ?? 60_000);
      if (
        !Number.isInteger(durationMs) ||
        durationMs < 1 ||
        durationMs > 60_000
      ) {
        return json({ error: "hold duration must be from 1 to 60000 ms" }, 400);
      }
      if (activeHolds >= maxConcurrentHolds) {
        return json({ error: "too many concurrent holds" }, 429);
      }
      activeHolds++;
      try {
        await Bun.sleep(durationMs);
        return json({ heldMs: durationMs });
      } finally {
        activeHolds--;
      }
    }
    if (url.pathname === "/live") {
      return (await forcedProbeFailure("live"))
        ? json({ live: false, forced: true }, 503)
        : json({ live: true });
    }

    if (url.pathname === "/sidecar") {
      try {
        const response = await fetch(`${sidecarUrl}/health`, {
          signal: AbortSignal.timeout(1500),
        });
        return new Response(response.body, {
          status: response.status,
          headers: { "content-type": "application/json" },
        });
      } catch {
        return json({ error: "sidecar unreachable" }, 503);
      }
    }

    if (url.pathname === "/ready") {
      if (await forcedProbeFailure("ready")) {
        return json({ ready: false, forced: true }, 503);
      }
      try {
        const response = await fetch(`${sidecarUrl}/health`, {
          signal: AbortSignal.timeout(1500),
        });
        return response.ok
          ? json({ ready: true })
          : json({ ready: false, sidecarStatus: response.status }, 503);
      } catch {
        return json({ ready: false, sidecar: "unreachable" }, 503);
      }
    }

    if (url.pathname === "/build") {
      try {
        const response = await fetch(`${sidecarUrl}/build`, {
          signal: AbortSignal.timeout(1500),
        });
        const sidecar = await response.json();
        return json({ api: buildMarker, sidecar });
      } catch {
        return json({ api: buildMarker, sidecar: "unreachable" }, 503);
      }
    }

    if (
      probeTestToggles &&
      (url.pathname === "/blob" || url.pathname === "/blob-write") &&
      request.method === "POST"
    ) {
      const declaredLength = Number(request.headers.get("content-length") ?? 0);
      if (declaredLength > maxProbeBodyBytes) {
        return json({ error: "body exceeds 1 MB" }, 413);
      }
      if (blobWriteProbeCount >= maxBlobWriteProbes) {
        return json({ error: "write-probe limit reached" }, 429);
      }
      blobWriteProbeCount++;
      const content = await readLimitedText(request, maxProbeBodyBytes);
      if (content === undefined) {
        return json({ error: "body exceeds 1 MB" }, 413);
      }
      try {
        const blob = blobContainer().getBlockBlobClient(
          `permission-probe-${randomUUID()}.txt`,
        );
        await blob.upload(content, Buffer.byteLength(content), {
          blobHTTPHeaders: { blobContentType: "text/plain; charset=utf-8" },
        });
        // Preserve a successful probe for inspection instead of deleting test data.
        return json({ writeAllowed: true });
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 403) {
          return json({ error: "forbidden" }, 403);
        }
        console.error("Blob permission probe failed");
        return json({ error: "Blob permission probe failed" }, 502);
      }
    }

    if (
      (url.pathname === "/blob" || url.pathname === "/blob-read") &&
      request.method === "GET"
    ) {
      try {
        const blob = blobContainer().getBlobClient("seed.txt");
        if (!(await blob.exists()))
          return json({ error: "blob not found" }, 404);
        const content = await blob.downloadToBuffer();
        return new Response(content, {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      } catch {
        console.error("Blob download failed");
        return json({ error: "Blob download failed" }, 502);
      }
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`API listening on 0.0.0.0:${port}; build marker=${buildMarker}`);
