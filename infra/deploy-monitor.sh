#!/usr/bin/env bash
# Deploys the IGC monitor: a Cloud Run service that Cloud Scheduler wakes once a
# minute, a public Cloud Storage feed for the web page, and (optionally) Telegram.
#
#   PROJECT_ID=sismo-alerta-235ca \
#   TELEGRAM_BOT_TOKEN=123:abc TELEGRAM_CHAT_ID=@mi_canal RELAY_USERS=@tu_usuario \
#   ./infra/deploy-monitor.sh
#
# RELAY_USERS: Telegram usernames or ids (comma-separated) allowed to relay IGC's
# WhatsApp notices to the bot. Only needed the first time or to change it.
# X_BEARER_TOKEN: X API token (developer.x.com, pay-per-use) to read IGC's posts on X.
# Only needed the first time or to change it; it's kept in Secret Manager.
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

echo "==> Monitor key (Scheduler header and Telegram webhook secret)"
if ! $G secrets describe monitor-key >/dev/null 2>&1; then
  $G secrets create monitor-key --replication-policy automatic
  openssl rand -hex 24 | tr -d '\n' | $G secrets versions add monitor-key --data-file=- >/dev/null
fi
$G secrets add-iam-policy-binding monitor-key --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor >/dev/null
KEY=$($G secrets versions access latest --secret monitor-key)
SECRETS="MONITOR_KEY=monitor-key:latest"

if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  echo "==> Telegram token in Secret Manager"
  $G secrets describe telegram-bot-token >/dev/null 2>&1 || $G secrets create telegram-bot-token --replication-policy automatic
  printf '%s' "$TELEGRAM_BOT_TOKEN" | $G secrets versions add telegram-bot-token --data-file=- >/dev/null
  $G secrets add-iam-policy-binding telegram-bot-token --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor >/dev/null
  SECRETS+=",TELEGRAM_BOT_TOKEN=telegram-bot-token:latest"
elif $G secrets describe telegram-bot-token >/dev/null 2>&1; then
  SECRETS+=",TELEGRAM_BOT_TOKEN=telegram-bot-token:latest"
  TELEGRAM_BOT_TOKEN=$($G secrets versions access latest --secret telegram-bot-token)
else
  echo "    (no TELEGRAM_BOT_TOKEN: the monitor will only log what it would send)"
fi

if [[ -n "${X_BEARER_TOKEN:-}" ]]; then
  echo "==> X token in Secret Manager"
  $G secrets describe x-bearer-token >/dev/null 2>&1 || $G secrets create x-bearer-token --replication-policy automatic
  printf '%s' "$X_BEARER_TOKEN" | $G secrets versions add x-bearer-token --data-file=- >/dev/null
fi
if $G secrets describe x-bearer-token >/dev/null 2>&1; then
  $G secrets add-iam-policy-binding x-bearer-token --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor >/dev/null
  SECRETS+=",X_BEARER_TOKEN=x-bearer-token:latest"
else
  echo "    (no X_BEARER_TOKEN: IGC's posts on X are not read)"
fi

echo "==> Cloud Run $SERVICE"
# One instance (the state lives in one place); requests take turns inside it. Scales to
# zero between ticks. Public, because Telegram must reach /telegram: the app checks the
# key on every route (Scheduler sends it as a header, Telegram as its secret token).
ENV_VARS="^;^BUCKET=$BUCKET;DASHBOARD_URL=$DASHBOARD_URL;NOTIFY_MIN_MAG=$NOTIFY_MIN_MAG;LOUD_MIN_MAG=$LOUD_MIN_MAG;NOTIFY_MAX_KM=$NOTIFY_MAX_KM"
ENV_VARS+="${TELEGRAM_CHAT_ID:+;TELEGRAM_CHAT_ID=$TELEGRAM_CHAT_ID}${RELAY_USERS:+;RELAY_USERS=$RELAY_USERS}"
$G run deploy "$SERVICE" --region "$REGION" --source "$ROOT/backend" \
  --command python --args="-m,app.monitor_main" \
  --service-account "$SA" --allow-unauthenticated \
  --min-instances 0 --max-instances 1 --concurrency 4 --cpu 1 --memory 512Mi --timeout 60 \
  --update-env-vars "$ENV_VARS" --update-secrets "$SECRETS"
URL=$($G run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')
$G run services add-iam-policy-binding "$SERVICE" --region "$REGION" --member "serviceAccount:$SCHED_SA" --role roles/run.invoker >/dev/null

echo "==> Scheduler: every minute"
JOB_ARGS=(--location "$REGION" --schedule "* * * * *" --uri "$URL/tick" --http-method POST
  --oidc-service-account-email "$SCHED_SA" --oidc-token-audience "$URL" --attempt-deadline 60s)
if $G scheduler jobs describe igc-monitor-tick --location "$REGION" >/dev/null 2>&1; then
  $G scheduler jobs update http igc-monitor-tick "${JOB_ARGS[@]}" --update-headers "X-Monitor-Key=$KEY"
else
  $G scheduler jobs create http igc-monitor-tick "${JOB_ARGS[@]}" --headers "X-Monitor-Key=$KEY"
fi
$G scheduler jobs run igc-monitor-tick --location "$REGION"

if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  echo "==> Telegram: private messages to the bot go to $URL/telegram"
  TG="https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN"
  curl -fsS "$TG/setWebhook" --data-urlencode "url=$URL/telegram" --data-urlencode "secret_token=$KEY" \
    --data-urlencode 'allowed_updates=["message"]' >/dev/null
  curl -fsS "$TG/setMyCommands" -H 'Content-Type: application/json' \
    -d '{"commands":[{"command":"estado","description":"¿Está funcionando la lista del IGC?"},{"command":"ayuda","description":"Cómo reenviar un aviso del IGC"}]}' >/dev/null
fi

echo
echo "==> Done."
echo "    Feed for the web page (paste into web/js/config.js, IGC_FEED.base):"
echo "      https://storage.googleapis.com/$BUCKET/igc/"
echo "    Logs: gcloud run services logs read $SERVICE --project $PROJECT_ID --region $REGION --limit 30"
echo "    Telegram test (labelled PRUEBA, deleted after 30 s):"
echo "      curl -X POST -H \"X-Monitor-Key: \$(gcloud secrets versions access latest --secret monitor-key --project $PROJECT_ID)\" $URL/test"
echo "    WhatsApp relay: open the bot in Telegram, send /ayuda, then paste or forward IGC's notices."
