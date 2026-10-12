#!/usr/bin/env bash
# Deploys the always-on ingestor to Cloud Run and the Firestore rules.
#
#   PROJECT_ID=my-project REGION=us-east1 ./infra/deploy.sh
#
# Requires: gcloud (logged in), firebase CLI (for the rules), a Firebase project
# with Firestore in Native mode. Safe to re-run.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-us-east1}"
SERVICE="${SERVICE:-sismo-ingestor}"
SA="${SERVICE}@${PROJECT_ID}.iam.gserviceaccount.com"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Enabling APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  firestore.googleapis.com fcm.googleapis.com --project "$PROJECT_ID"

echo "==> Service account $SA"
gcloud iam service-accounts describe "$SA" --project "$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$SERVICE" --display-name "Sismo Alerta ingestor" --project "$PROJECT_ID"
for role in roles/datastore.user roles/firebasecloudmessaging.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$SA" --role "$role" \
    --condition=None --quiet >/dev/null
done

echo "==> Deploying $SERVICE to Cloud Run ($REGION)"
# min/max 1 instance + CPU always allocated: the WebSocket must stay open between requests.
gcloud run deploy "$SERVICE" \
  --project "$PROJECT_ID" --region "$REGION" \
  --source "$ROOT/backend" \
  --service-account "$SA" \
  --no-allow-unauthenticated \
  --min-instances 1 --max-instances 1 \
  --no-cpu-throttling --cpu 1 --memory 512Mi \
  --timeout 3600 \
  --set-env-vars "LOG_LEVEL=INFO"

echo "==> Firestore rules"
if command -v firebase >/dev/null; then
  (cd "$ROOT" && firebase deploy --only firestore:rules,firestore:indexes --project "$PROJECT_ID")
else
  echo "firebase CLI not found: deploy infra/firestore.rules from the Firebase console instead."
fi

echo "==> Done. Check it with:"
echo "    gcloud run services logs read $SERVICE --project $PROJECT_ID --region $REGION --limit 50"
