#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
#  Azure Container-based Function App — Deploy Script
#
#  Prerequisites:
#    - Azure CLI installed and logged in  (az login)
#    - Docker installed and running
#    - Fill in the variables below before running
#
#  Usage:
#    chmod +x .azure/deploy.sh
#    .azure/deploy.sh
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── EDIT THESE ────────────────────────────────────────────────────────────────
RESOURCE_GROUP="fire-smoke-rg"
LOCATION="eastus"                          # Azure region
ACR_NAME="firesmokecr"                     # Azure Container Registry name (globally unique, lowercase)
IMAGE_NAME="fire-smoke-detection"
IMAGE_TAG="latest"
STORAGE_ACCOUNT="firesmokestorage"         # Storage account name (3-24 chars, lowercase+numbers)
FUNCTION_APP_NAME="fire-smoke-fn"          # Function App name (globally unique)
SKU="EP1"                                  # EP1=Elastic Premium (required for containers)
# ──────────────────────────────────────────────────────────────────────────────

FULL_IMAGE="${ACR_NAME}.azurecr.io/${IMAGE_NAME}:${IMAGE_TAG}"

echo "==> [1/7] Creating resource group: ${RESOURCE_GROUP}"
az group create \
  --name     "${RESOURCE_GROUP}" \
  --location "${LOCATION}" \
  --output   none

echo "==> [2/7] Creating Azure Container Registry: ${ACR_NAME}"
az acr create \
  --resource-group "${RESOURCE_GROUP}" \
  --name           "${ACR_NAME}" \
  --sku            Basic \
  --admin-enabled  true \
  --output         none

echo "==> [3/7] Building and pushing Docker image to ACR"
az acr build \
  --registry        "${ACR_NAME}" \
  --image           "${IMAGE_NAME}:${IMAGE_TAG}" \
  --resource-group  "${RESOURCE_GROUP}" \
  .

echo "==> [4/7] Creating storage account: ${STORAGE_ACCOUNT}"
az storage account create \
  --name              "${STORAGE_ACCOUNT}" \
  --resource-group    "${RESOURCE_GROUP}" \
  --location          "${LOCATION}" \
  --sku               Standard_LRS \
  --output            none

echo "==> [5/7] Creating Elastic Premium App Service Plan"
az functionapp plan create \
  --resource-group "${RESOURCE_GROUP}" \
  --name           "${FUNCTION_APP_NAME}-plan" \
  --location       "${LOCATION}" \
  --sku            "${SKU}" \
  --is-linux       true \
  --output         none

echo "==> [6/7] Creating Function App with container"
ACR_CREDENTIALS=$(az acr credential show --name "${ACR_NAME}" --query "{username:username, password:passwords[0].value}" -o json)
ACR_USER=$(echo "${ACR_CREDENTIALS}" | python3 -c "import sys,json; print(json.load(sys.stdin)['username'])")
ACR_PASS=$(echo "${ACR_CREDENTIALS}" | python3 -c "import sys,json; print(json.load(sys.stdin)['password'])")

az functionapp create \
  --resource-group        "${RESOURCE_GROUP}" \
  --name                  "${FUNCTION_APP_NAME}" \
  --storage-account       "${STORAGE_ACCOUNT}" \
  --plan                  "${FUNCTION_APP_NAME}-plan" \
  --deployment-container-image-name "${FULL_IMAGE}" \
  --docker-registry-server-url      "https://${ACR_NAME}.azurecr.io" \
  --docker-registry-server-user     "${ACR_USER}" \
  --docker-registry-server-password "${ACR_PASS}" \
  --functions-version     4 \
  --output                none

echo "==> [7/7] Enabling HTTPS-only and setting app settings"
az functionapp update \
  --name           "${FUNCTION_APP_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  --set            httpsOnly=true \
  --output         none

az functionapp config appsettings set \
  --name           "${FUNCTION_APP_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  --settings \
      FUNCTIONS_WORKER_RUNTIME=python \
      FUNCTIONS_WORKER_RUNTIME_VERSION=3.11 \
      AzureWebJobsFeatureFlags=EnableWorkerIndexing \
      WEBSITE_RUN_FROM_PACKAGE=0 \
  --output none

echo ""
echo "✅  Deployment complete!"
echo "    URL: https://${FUNCTION_APP_NAME}.azurewebsites.net/api/ui"
echo ""
echo "    Open the dashboard:"
echo "    https://${FUNCTION_APP_NAME}.azurewebsites.net/api/ui"
