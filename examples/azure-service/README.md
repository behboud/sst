# Azure Container Apps Service example

This example exercises `sst.azure.Service` with an API and sidecar, managed HTTPS ingress, health probes, bounded scaling, and a Blob link accessed through a user-assigned managed identity.

## Security and costs

This is a sample workload, not a production application. It creates Azure resources and can incur ongoing charges. Use an isolated resource group, review the Pulumi preview before deployment, and understand your stack's removal/retention behavior before applying it.

The repository contains no Azure account credentials. Deployment uses the operator's configured Azure Native provider and Azure CLI session; image publishing obtains a short-lived ACR token at deploy time. The running Container App uses its managed identity for ACR pulls and linked Blob access. Local `sst dev` uses the developer's Azure CLI credential. Do not put actual subscription, tenant, principal, client-secret, token, or key values in source files or commits; provide required values through your local environment or approved credential manager.

The API exposes health, build, sidecar, and seeded-blob read endpoints for this example. Test-only write-denial and hold routes are disabled by default. Setting `SST_PROBE_TEST_TOGGLES=true` enables them; use that only in an isolated test stage and turn it off immediately afterward. The write-probe endpoint is bounded, but these unauthenticated test endpoints are not intended for production.

The workload receives a user-assigned identity, `AcrPull` for its private images, and only the permissions declared by its links. The example links Blob `read` access. It does not use account keys, SAS tokens, ACR admin credentials, or a service-principal client secret.

## Prerequisites

- Bun, Docker Buildx, and the example dependencies.
- Azure CLI authenticated to the intended account and subscription, plus a configured Azure Native provider.
- An existing resource group selected with `AZURE_RESOURCE_GROUP` and the control-plane permissions required by the preflight.
- A seeded `seed.txt` blob for the acceptance checks. Upload it with an authorized setup identity; do not broaden the app identity's permissions to seed it.

The read-only preflight checks that the active CLI identity and resource group match the explicitly approved environment values, that the required resource providers are registered, and that the current principal has the required effective actions. It performs no Azure writes and does not prove policy, quota, deny-assignment, or runtime data-plane access.

## Offline preparation

```bash
cd examples/azure-service
bun install
bun install --cwd workload
```

The build contexts exclude SST state, environment files, keys, certificates, and Terraform state. The Dockerfiles pin Bun and build Linux/amd64 images through the Service Buildx path.

## Remote deployment

Set these values in your local shell; do not replace the placeholders in this file with actual account identifiers:

```bash
export AZURE_RESOURCE_GROUP=<existing-resource-group>
export SST_AZURE_APPROVED_SUBSCRIPTION_ID=<approved-subscription-id>
export SST_AZURE_APPROVED_TENANT_ID=<approved-tenant-id>
export SST_AZURE_APPROVED_PRINCIPAL_ID=<approved-user-object-id>
bun scripts/preflight.mjs
```

After preflight passes, inspect the preview. Continue only when it shows the expected resources and no unintended changes, replacements, or deletions:

```bash
BUILD_MARKER=first go run ../../cmd/sst diff --stage acceptance
BUILD_MARKER=first go run ../../cmd/sst deploy --stage acceptance
```

Capture the exported storage account name and service URL from the deployment output. Seed `seed.txt` with an authorized setup identity:

```bash
az storage blob upload \
  --account-name <storage-account-name> \
  --container-name sst-data \
  --name seed.txt \
  --file seed.txt \
  --auth-mode login
```

Run the basic acceptance checks:

```bash
AZURE_SERVICE_URL=https://<app-fqdn> EXPECTED_BUILD_MARKER=first bun scripts/acceptance.mjs
```

The optional write-denial check requires a test-only deployment with `SST_PROBE_TEST_TOGGLES=true` and the local flag below. Do not leave test toggles enabled in a normal deployment:

```bash
SST_PROBE_TEST_TOGGLES=true BUILD_MARKER=first \
  go run ../../cmd/sst deploy --stage acceptance
CHECK_BLOB_WRITE_DENIAL=true AZURE_SERVICE_URL=https://<app-fqdn> \
  EXPECTED_BUILD_MARKER=first bun scripts/acceptance.mjs
```

Restore the default by redeploying without `SST_PROBE_TEST_TOGGLES`. The bounded load driver is optional and intended only for an isolated test stage:

```bash
AZURE_SERVICE_URL=https://<app-fqdn> LOAD_REQUESTS=20 LOAD_CONCURRENCY=3 bun scripts/load.mjs
```

## Local development

When `dev` is enabled, this Service skips its remote ACR, image, managed identity, role-assignment, environment, and Container App resources. Explicit local commands run the API and sidecar. Local Blob access uses `AzureCliCredential`; it does not use or receive the cloud managed identity's client ID.

The example's Storage Account and Blob Containers are declared separately in `sst.config.ts`, so local dev can still provision or update those backing resources. Use a distinct stage, run the preflight, and review the preview before proceeding. Do not switch an existing remote stage to local mode without reviewing its resource diff.
