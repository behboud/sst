const baseUrl = process.env.AZURE_SERVICE_URL?.replace(/\/$/, "");
if (!baseUrl)
  throw new Error("Set AZURE_SERVICE_URL to the deployed HTTPS URL.");

const path = process.env.LOAD_PATH ?? "/health";
if (!path.startsWith("/") || path.startsWith("//")) {
  throw new Error("LOAD_PATH must be a path on the configured service URL.");
}

const requests = Number.parseInt(process.env.LOAD_REQUESTS ?? "20", 10);
const concurrency = Number.parseInt(process.env.LOAD_CONCURRENCY ?? "3", 10);
if (!Number.isInteger(requests) || requests < 1 || requests > 500) {
  throw new Error("LOAD_REQUESTS must be from 1 to 500.");
}
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) {
  throw new Error("LOAD_CONCURRENCY must be from 1 to 20.");
}

let next = 0;
let completed = 0;
const started = Date.now();
async function worker() {
  while (true) {
    const index = next++;
    if (index >= requests) return;
    const response = await fetch(`${baseUrl}${path}`);
    if (!response.ok)
      throw new Error(`Request ${index + 1}: HTTP ${response.status}`);
    completed++;
  }
}

await Promise.all(
  Array.from({ length: Math.min(concurrency, requests) }, () => worker()),
);
console.log(
  `Completed ${completed} requests with concurrency ${concurrency} in ${
    Date.now() - started
  }ms.`,
);
