#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${LMSTUDIO_BASE_URL:-http://localhost:1234/v1}"
MODEL="${LMSTUDIO_MODEL:-}"
API_KEY="${LMSTUDIO_API_KEY:-lm-studio}"

echo "[smoke] base_url=${BASE_URL}"

echo "[smoke] checking models endpoint..."
MODELS_JSON="$(curl -fsSL \
  -H "Authorization: Bearer ${API_KEY}" \
  "${BASE_URL%/}/models")"
echo "${MODELS_JSON}" | jq -r '.data[].id' | sed 's/^/[smoke] model: /'

if [[ -z "${MODEL}" ]]; then
  MODEL="$(echo "${MODELS_JSON}" | jq -r '.data[0].id')"
fi

if [[ -z "${MODEL}" || "${MODEL}" == "null" ]]; then
  echo "[smoke] no model available from LM Studio"
  exit 1
fi

echo "[smoke] selected_model=${MODEL}"

echo "[smoke] sending chat completion..."
curl -fsSL \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -X POST "${BASE_URL%/}/chat/completions" \
  -d "{
    \"model\": \"${MODEL}\",
    \"messages\": [
      {\"role\": \"system\", \"content\": \"You are concise.\"},
      {\"role\": \"user\", \"content\": \"Reply exactly with: LM Studio endpoint reachable.\"}
    ],
    \"temperature\": 0,
    \"max_tokens\": 64,
    \"stream\": false
  }" | jq -r '.choices[0].message.content' | sed 's/^/[smoke] response: /'

echo "[smoke] complete"
