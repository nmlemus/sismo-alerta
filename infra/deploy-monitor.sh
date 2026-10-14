#!/usr/bin/env bash
# Deploys the IGC monitor: a Cloud Run service that Cloud Scheduler wakes once a
# minute, a public Cloud Storage feed for the web page, and (optionally) Telegram.
#
#   PROJECT_ID=sismo-alerta-235ca \
#   TELEGRAM_BOT_TOKEN=123:abc TELEGRAM_CHAT_ID=@mi_canal \
#   ./infra/deploy-monitor.sh
#
# Needs: gcloud logged in, a project on the Blaze plan (Cloud Run and Scheduler need
# billing; this stays within the free tiers). Safe to re-run: it updates in place.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-us-east1}"
SERVICE="${SERVICE:-sismo-igc-monitor}"
BUCKET="${BUCKET:-${PROJECT_ID}-sismo-feed}"
DASHBOARD_URL="${DASHBOARD_URL:-https://${PROJECT_ID}.web.app}"
NOTIFY_MIN_MAG="${NOTIFY_MIN_MAG:-3.5}"
LOUD_MIN_MAG="${LOUD_MIN_MAG:-4.0}"
NOTIFY_MAX_KM="${NOTIFY_MAX_KM:-400}"
SA="${SERVICE}@${PROJECT_ID}.iam.gserviceaccount.com"
SCHED_SA="sismo-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
G="gcloud --project $PROJECT_ID --quiet"

echo "==> APIs"
$G services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  cloudscheduler.googleapis.com storage.googleapis.com secretmanager.googleapis.com iam.googleapis.com

echo "==> Build permissions"
# New projects no longer give the default build account access to the uploaded
# source ("Build failed because the default service account is missing required
# IAM permissions"). Grant it the Cloud Build builder role once.
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format 'value(projectNumber)')
gcloud projects add-iam-policy-binding "$PROJECT_ID" --quiet --condition=None \
  --member "serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role roles/cloudbuild.builds.builder >/dev/null

echo "==> Service accounts"
$G iam service-accounts describe "$SA" >/dev/null 2>&1 || $G iam service-accounts create "$SERVICE" --display-name "IGC monitor"
$G iam service-accounts describe "$SCHED_SA" >/dev/null 2>&1 || $G iam service-accounts create sismo-scheduler --display-name "Wakes the IGC monitor"

echo "==> Public feed bucket gs://$BUCKET"
$G storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 || \
  $G storage buckets create "gs://$BUCKET" --location "$REGION" --uniform-bucket-level-access
$G storage buckets add-iam-policy-binding "gs://$BUCKET" --member allUsers --role roles/storage.objectViewer >/dev/null
$G storage buckets add-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$SA" --role roles/storage.objectAdmin >/dev/null
cors=$(mktemp)
echo '[{"origin":["*"],"method":["GET","HEAD"],"responseHeader":["Content-Type","ETag"],"maxAgeSeconds":300}]' > "$cors"
$G storage buckets update "gs://$BUCKET" --cors-file "$cors" >/dev/null

SECRET_FLAGS=()
if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  echo "==> Telegram token in Secret Manager"
  $G secrets describe telegram-bot-token >/dev/null 2>&1 || $G secrets create telegram-bot-token --replication-policy automatic
  printf '%s' "$TELEGRAM_BOT_TOKEN" | $G secrets versions add telegram-bot-token --data-file=- >/dev/null
  $G secrets add-iam-policy-binding telegram-bot-token --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor >/dev/null
  SECRET_FLAGS=(--set-secrets "TELEGRAM_BOT_TOKEN=telegram-bot-token:latest")
elif $G secrets describe telegram-bot-token >/dev/null 2>&1; then
  SECRET_FLAGS=(--set-secrets "TELEGRAM_BOT_TOKEN=telegram-bot-token:latest")
else
  echo "    (no TELEGRAM_BOT_TOKEN: the monitor will only log what it would send)"
fi

echo "==> Cloud Run $SERVICE"
# One instance, one request at a time: ticks never overlap. Scales to zero between ticks.
$G run deploy "$SERVICE" --region "$REGION" --source "$ROOT/backend" \
  --command python --args="-m,app.monitor_main" \
  --service-account "$SA" --no-allow-unauthenticated \
  --min-instances 0 --max-instances 1 --concurrency 1 --cpu 1 --memory 512Mi --timeout 60 \
  --update-env-vars "BUCKET=$BUCKET,DASHBOARD_URL=$DASHBOARD_URL,NOTIFY_MIN_MAG=$NOTIFY_MIN_MAG,LOUD_MIN_MAG=$LOUD_MIN_MAG,NOTIFY_MAX_KM=$NOTIFY_MAX_KM${TELEGRAM_CHAT_ID:+,TELEGRAM_CHAT_ID=$TELEGRAM_CHAT_ID}" \
  "${SECRET_FLAGS[@]}"
URL=$($G run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')
$G run services add-iam-policy-binding "$SERVICE" --region "$REGION" --member "serviceAccount:$SCHED_SA" --role roles/run.invoker >/dev/null

echo "==> Scheduler: every minute"
JOB_ARGS=(--location "$REGION" --schedule "* * * * *" --uri "$URL/tick" --http-method POST
  --oidc-service-account-email "$SCHED_SA" --oidc-token-audience "$URL" --attempt-deadline 60s)
if $G scheduler jobs describe igc-monitor-tick --location "$REGION" >/dev/null 2>&1; then
  $G scheduler jobs update http igc-monitor-tick "${JOB_ARGS[@]}"
else
  $G scheduler jobs create http igc-monitor-tick "${JOB_ARGS[@]}"
fi
$G scheduler jobs run igc-monitor-tick --location "$REGION"

echo
echo "==> Done."
echo "    Feed for the web page (paste into web/js/config.js, IGC_FEED.base):"
echo "      https://storage.googleapis.com/$BUCKET/igc/"
echo "    Logs: gcloud run services logs read $SERVICE --project $PROJECT_ID --region $REGION --limit 30"
echo "    Telegram test (labelled PRUEBA, deleted after 30 s):"
echo "      curl -X POST -H \"Authorization: Bearer \$(gcloud auth print-identity-token)\" $URL/test"
