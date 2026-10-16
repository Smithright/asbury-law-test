#!/usr/bin/env bash
# Stand up the blue/green website slots + Cloudflare load balancer BEFORE cutover.
# asbury-law.com keeps serving the old site; mail records are imported unchanged (MX stays on Titan).
#
# Run on your Mac from the repo root:  bash ops/precutover.sh <phase>
#   phase 1  Vercel: database settings per environment, public slots, slot + staging domains, first blue deploy
#   phase 2  Cloudflare: add the zone (DNS-only copy of today's records), print nameservers to set at Bluehost
#   phase 3  after nameservers switched: slot DNS records, health monitor, pools, load balancer on next.asbury-law.com
#   phase 4  checks: health of each slot through its own host and through the load balancer
#
# Credentials are read at the prompt (never echoed, never written to disk):
#   VERCEL_TOKEN   vercel.com/account/tokens  (scope: smithright's projects)
#   CF_API_TOKEN   dash.cloudflare.com/profile/api-tokens  (Zone:Edit, DNS:Edit, Zone Settings:Edit,
#                  Load Balancers:Edit, Account Load Balancing (Monitors and Pools):Edit)
#   CF_ACCOUNT_ID  Cloudflare dashboard, right sidebar of any page
# Database strings come from neonctl (browser sign-in), piped straight into Vercel, never printed.
set -euo pipefail

TEAM=team_GQmzsp4WbmsngwjpyJ97SFoZ          # Vercel: smithright's projects
NEON_PROJECT=delicate-poetry-80674943       # Neon: asbury-law
DOMAIN=asbury-law.com
ALERT_EMAIL=ryan@smithright.com
LB_HOST=next.asbury-law.com                 # pre-cutover entry point; becomes asbury-law.com at cutover

need() { command -v "$1" >/dev/null || { echo "missing: $1"; exit 1; }; }
need curl; need jq; need npx
ask() { local v; read -r -s -p "$1: " v; echo >&2; printf '%s' "$v"; }

vapi() { # vapi METHOD PATH [JSON]  -> Vercel REST, team-scoped, fails loudly
  local m=$1 p=$2 d=${3:-}; local sep='?'; [[ $p == *\?* ]] && sep='&'
  curl -fsS -X "$m" "https://api.vercel.com${p}${sep}teamId=${TEAM}" \
    -H "Authorization: Bearer ${VERCEL_TOKEN}" -H "Content-Type: application/json" ${d:+--data "$d"}
}
cfapi() { # cfapi METHOD PATH [JSON] -> Cloudflare v4, prints .result, fails on success=false
  local m=$1 p=$2 d=${3:-} out
  out=$(curl -sS -X "$m" "https://api.cloudflare.com/client/v4${p}" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json" ${d:+--data "$d"})
  [[ $(jq -r .success <<<"$out") == true ]] || { echo "Cloudflare error on $m $p:"; jq -c .errors <<<"$out"; exit 1; }
  jq -c .result <<<"$out"
}
neon_url() { # neon_url BRANCH -> pooled connection string on stdout (never echoed by callers)
  npx -y neonctl@2.15.0 connection-string "$1" --project-id "$NEON_PROJECT" \
    --database-name neondb --role-name neondb_owner --pooled
}
set_env() { # set_env PROJECT KEY TARGET VALUE_FROM_STDIN
  local val; val=$(cat)
  [[ $val == postgres* ]] || { echo "refusing: $2 for $1 is not a postgres URL"; exit 1; }
  vapi POST "/v10/projects/$1/env?upsert=true" \
    "$(jq -nc --arg k "$2" --arg v "$val" --arg t "$3" '{key:$k,value:$v,type:"encrypted",target:[$t]}')" >/dev/null
  echo "  $1: $2 ($3) set"
}

phase1() {
  VERCEL_TOKEN=$(ask "VERCEL_TOKEN")
  echo "Neon sign-in (browser) for connection strings..."; npx -y neonctl@2.15.0 auth >/dev/null

  echo "1a. Database setting per environment (APP_DATABASE_URL; checked by the env marker at runtime)"
  neon_url production | set_env asbury-law-blue  APP_DATABASE_URL production
  neon_url production | set_env asbury-law-green APP_DATABASE_URL production
  neon_url production | set_env asbury-law-test  APP_DATABASE_URL production
  neon_url staging    | set_env asbury-law-test  APP_DATABASE_URL preview

  echo "1b. Slots must be public for the load balancer (turn off Vercel Authentication)"
  for p in asbury-law-blue asbury-law-green; do vapi PATCH "/v9/projects/$p" '{"ssoProtection":null}' >/dev/null; echo "  $p: public"; done

  echo "1c. Domains (DNS records come in phase 3; Vercel shows them as 'invalid configuration' until then)"
  vapi POST /v10/projects/asbury-law-blue/domains  '{"name":"blue.asbury-law.com"}'  >/dev/null || echo "  (blue domain may already exist)"
  vapi POST /v10/projects/asbury-law-green/domains '{"name":"green.asbury-law.com"}' >/dev/null || echo "  (green domain may already exist)"
  vapi POST /v10/projects/asbury-law-test/domains  '{"name":"staging.asbury-law.com","gitBranch":"mvp-preview"}' >/dev/null || echo "  (staging domain may already exist)"
  echo "  domains requested"

  echo "1d. Deploy each slot from its release branch (production target)"
  for c in blue green; do
    vapi POST /v13/deployments "$(jq -nc --arg c "$c" '{name:("asbury-law-"+$c),project:("asbury-law-"+$c),target:"production",
      gitSource:{type:"github",org:"Smithright",repo:"asbury-law-test",ref:("release-"+$c)}}')" | jq -r '"  "+.name+": "+.url+" ("+.readyState+")"'
  done
  cat <<'EOF'

Manual (UI, ~2 min), then rerun nothing — phase 1 is done:
  - asbury-law-blue > Settings > Environments > Production > Branch Tracking = release-blue > Save
    (green is already release-green). Without this, future promotes won't rebuild blue automatically.
  - Integrations > Resend > Manage access > add asbury-law-blue and asbury-law-green (injects RESEND_* for notices).
EOF
}

phase2() {
  CF_API_TOKEN=$(ask "CF_API_TOKEN"); CF_ACCOUNT_ID=$(ask "CF_ACCOUNT_ID")
  echo "2a. Add $DOMAIN to Cloudflare (Free plan) and import today's records"
  Z=$(cfapi POST /zones "$(jq -nc --arg a "$CF_ACCOUNT_ID" --arg n "$DOMAIN" '{account:{id:$a},name:$n,type:"full",jump_start:true}')" \
      || true)
  ZID=$(cfapi GET "/zones?name=$DOMAIN" | jq -r '.[0].id')
  echo "  zone id: $ZID"

  echo "2b. Keep every imported record DNS-only, so behavior is identical to today (old site, Titan mail, Proton, Resend)"
  cfapi GET "/zones/$ZID/dns_records?per_page=500" | jq -c '.[] | select(.proxied==true)' | while read -r r; do
    id=$(jq -r .id <<<"$r"); cfapi PATCH "/zones/$ZID/dns_records/$id" '{"proxied":false}' >/dev/null
    echo "  unproxied $(jq -r '.type+" "+.name' <<<"$r")"
  done

  echo "2c. Imported records. COMPARE line by line with Bluehost > Domains > asbury-law.com > DNS before switching:"
  cfapi GET "/zones/$ZID/dns_records?per_page=500" | jq -r '.[] | [.type,.name,(.priority//""|tostring),(.content|.[0:70])] | @tsv' | sort
  echo
  echo "Missing anything? Add it in the Cloudflare dashboard (DNS-only) BEFORE the switch. Must include at least:"
  echo "  MX @ -> mx1/mx2.titan.email · SPF/DMARC TXT · resend._domainkey TXT · send MX+TXT · secure MX (Proton) + its DKIM/verification"
  echo
  echo "2d. Then at Bluehost (registrar) set nameservers to:"
  cfapi GET "/zones/$ZID" | jq -r '.name_servers[]' | sed 's/^/    /'
  echo "Run 'bash ops/precutover.sh 3' after Cloudflare shows the zone as Active (minutes to a few hours)."
}

phase3() {
  CF_API_TOKEN=$(ask "CF_API_TOKEN"); CF_ACCOUNT_ID=$(ask "CF_ACCOUNT_ID")
  ZID=$(cfapi GET "/zones?name=$DOMAIN" | jq -r '.[0].id')
  [[ $(cfapi GET "/zones/$ZID" | jq -r .status) == active ]] || { echo "zone not active yet; wait for the nameserver switch"; exit 1; }

  echo "3a. Slot + staging hosts -> Vercel (DNS-only so Vercel can issue their certificates)"
  for h in blue green staging; do
    ex=$(cfapi GET "/zones/$ZID/dns_records?name=$h.$DOMAIN" | jq -r '.[0].id // empty')
    body=$(jq -nc --arg n "$h" '{type:"CNAME",name:$n,content:"cname.vercel-dns.com",proxied:false,ttl:1}')
    if [[ -n $ex ]]; then cfapi PUT "/zones/$ZID/dns_records/$ex" "$body" >/dev/null; else cfapi POST "/zones/$ZID/dns_records" "$body" >/dev/null; fi
    echo "  $h.$DOMAIN -> cname.vercel-dns.com"
  done

  echo "3b. TLS to origins: Full (strict). Only proxied hosts are affected; the old site stays DNS-only."
  cfapi PATCH "/zones/$ZID/settings/ssl" '{"value":"strict"}' >/dev/null

  echo "3c. Health monitor: GET /api/healthz must return 200 (DB reachable + correct env marker)"
  MON=$(cfapi POST "/accounts/$CF_ACCOUNT_ID/load_balancers/monitors" \
    '{"type":"https","method":"GET","path":"/api/healthz","expected_codes":"200","interval":60,"timeout":5,"retries":2,"follow_redirects":false,"description":"asbury slot health"}' | jq -r .id)

  echo "3d. Pools (one per slot), email alert on any health change"
  pool() { cfapi POST "/accounts/$CF_ACCOUNT_ID/load_balancers/pools" "$(jq -nc --arg c "$1" --arg m "$MON" --arg e "$ALERT_EMAIL" --arg d "$DOMAIN" \
    '{name:("asbury-"+$c),monitor:$m,notification_email:$e,minimum_origins:1,
      origins:[{name:$c,address:($c+"."+$d),enabled:true,header:{Host:[($c+"."+$d)]}}]}')" | jq -r .id; }
  BLUE=$(pool blue); GREEN=$(pool green); echo "  pools: blue=$BLUE green=$GREEN"

  echo "3e. Load balancer on $LB_HOST: blue first, automatic failover to green"
  cfapi POST "/zones/$ZID/load_balancers" "$(jq -nc --arg n "$LB_HOST" --arg b "$BLUE" --arg g "$GREEN" \
    '{name:$n,default_pools:[$b,$g],fallback_pool:$g,proxied:true,steering_policy:"off",session_affinity:"none"}')" | jq -r '"  LB: "+.name'
  echo "Done. Wait ~5 min for Vercel certificates on blue./green., then run phase 4."
}

phase4() {
  for u in "https://blue.$DOMAIN/api/healthz" "https://green.$DOMAIN/api/healthz" "https://$LB_HOST/api/healthz" "https://staging.$DOMAIN/api/healthz"; do
    printf '%-48s ' "$u"; curl -sS -m 10 -w '  HTTP %{http_code}\n' "$u" || echo "  unreachable"
  done
  echo "Expect: blue/green/next -> {\"ok\":true,...} 200 (next shows slot=blue). staging -> 200 with slot=mvp-preview."
}

case "${1:-}" in 1) phase1;; 2) phase2;; 3) phase3;; 4) phase4;; *) sed -n '2,20p' "$0";; esac
