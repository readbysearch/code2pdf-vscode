#!/bin/bash
# Creates the Azure resources the usage data goes to, or brings their settings back in line.
# PRIVACY.md and the README promise what this sets: the EU (Sweden Central), deletion after 90
# days, and Azure's default of not storing IP addresses. Needs `az login` (the account that owns
# the publisher) and `az extension add --name application-insights`. Safe to run again;
# test/usage-data.sh checks the result.
#
#   code2pdf-vscode       where the extension sends (its connection string is in src/telemetry.ts)
#   code2pdf-vscode-test  where test/usage-data.sh sends, so tests stay out of the real numbers
set -euo pipefail

GROUP=code2pdf
REGION=swedencentral   # in the EU (westeurope takes no new customers)
WORKSPACE=code2pdf-logs

az group create --name "$GROUP" --location "$REGION" --output none

# 90 days, then deleted. At most 0.1 GB a day: the connection string is public, so even a flood
# of junk stays inside Azure Monitor's free 5 GB a month (Azure stops a little after the cap)
az monitor log-analytics workspace show --resource-group "$GROUP" --workspace-name "$WORKSPACE" --output none 2>/dev/null ||
  az monitor log-analytics workspace create --resource-group "$GROUP" --workspace-name "$WORKSPACE" \
    --location "$REGION" --sku PerGB2018 --output none
az monitor log-analytics workspace update --resource-group "$GROUP" --workspace-name "$WORKSPACE" \
  --retention-time 90 --quota 0.1 --output none

# Created once, never re-created: that would change the connection string
for app in code2pdf-vscode code2pdf-vscode-test; do
  az monitor app-insights component show --app "$app" --resource-group "$GROUP" --output none 2>/dev/null ||
    az monitor app-insights component create --app "$app" --resource-group "$GROUP" --location "$REGION" \
      --kind web --application-type web --workspace "$WORKSPACE" --output none
done

# The tables Application Insights writes to: 90 days in all, no long-term archive
for table in AppEvents AppTraces AppRequests AppDependencies AppExceptions AppMetrics; do
  az monitor log-analytics workspace table update --resource-group "$GROUP" --workspace-name "$WORKSPACE" \
    --name "$table" --retention-time 90 --total-retention-time 90 --output none
done

# An email to the account's owner once a month's cost passes 1 cent (1% of $1)
budget="https://management.azure.com/subscriptions/$(az account show --query id -o tsv)/providers/Microsoft.Consumption/budgets/code2pdf?api-version=2023-05-01"
if ! az rest --method get --url "$budget" --output none 2>/dev/null; then
  az rest --method put --url "$budget" --output none --body "$(cat <<EOF
{"properties": {"category": "Cost", "amount": 1, "timeGrain": "Monthly",
  "timePeriod": {"startDate": "$(date -u +%Y-%m-01)T00:00:00Z", "endDate": "$(( $(date -u +%Y) + 2 ))-$(date -u +%m)-01T00:00:00Z"},
  "notifications": {"anyCharge": {"enabled": true, "operator": "GreaterThan", "threshold": 1, "thresholdType": "Actual",
    "contactEmails": ["$(az account show --query user.name -o tsv)"]}}}}
EOF
)"
fi
echo "Azure resources are set up."
