const baseUrl = process.env.AZURE_SERVICE_URL?.replace(/\/$/, "");
if (!baseUrl) {
  throw new Error(
    "Set AZURE_SERVICE_URL to the deployed Container App HTTPS URL.",
  );
}

async function expectJson(path, predicate, label) {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  const body = await response.json();
  if (!predicate(body)) throw new Error(`${label}: unexpected response`);
  return body;
}

await expectJson("/health", (body) => body.ok === true, "API health");
await expectJson("/live", (body) => body.live === true, "API liveness");
await expectJson("/sidecar", (body) => body.ok === true, "sidecar endpoint");
await expectJson("/ready", (body) => body.ready === true, "sidecar readiness");
const build = await expectJson(
  "/build",
  (body) => body.api && body.sidecar,
  "build marker",
);
console.log("Build markers:", JSON.stringify(build));

const expectedMarker = process.env.EXPECTED_BUILD_MARKER;
if (expectedMarker && build.api !== expectedMarker) {
  throw new Error(
    `API image marker ${build.api} did not match ${expectedMarker}.`,
  );
}
if (expectedMarker && build.sidecar.buildMarker !== expectedMarker) {
  throw new Error(
    `Sidecar image marker ${build.sidecar.buildMarker} did not match ${expectedMarker}.`,
  );
}

const download = await fetch(`${baseUrl}/blob-read`);
if (!download.ok) throw new Error(`Blob read: HTTP ${download.status}`);
const content = await download.text();
const expectedContent =
  process.env.EXPECTED_BLOB_CONTENT ?? "sst azure-service acceptance seed";
if (content !== expectedContent) {
  throw new Error("Blob read returned unexpected seeded content.");
}

if (process.env.CHECK_BLOB_WRITE_DENIAL === "true") {
  const write = await fetch(`${baseUrl}/blob-write`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "permission probe",
  });
  if (write.status !== 403) {
    throw new Error(
      `Expected Blob write authorization denial; got HTTP ${write.status}.`,
    );
  }
  console.log("Blob write-denial check: passed");
} else {
  console.log("Blob write-denial probe skipped.");
}
