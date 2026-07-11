#!/usr/bin/env bash
# docs-freshness.sh — report vault notes whose cited repo files drifted since verification.
#
# Usage: scripts/docs-freshness.sh [--json] [--map <path>] [--repo <path>]
#   --json                machine-readable output (consumed by /document-project --update)
#   --map <path>          coverage map to load (default: the mcp-server map)
#   --repo <path>         override the repo root for a SINGLE-repo map
#                         (default: the map's top-level "repo" field; ignored for multi-repo maps)
#   BUREAU_DOCS_STRICT=1  exit 1 when anything is stale/unmapped (default: warn-only, exit 0)
#
# Coverage-map shapes (auto-detected):
#   • single-repo — top-level "repo" (string). Optional "package_root" (e.g. "packages/api"): the
#       documented package lives below the repo root, so the unmapped scan walks "<package_root>/src"
#       and file specs are already repo-relative WITH that prefix.
#   • multi-repo  — top-level "repos" (object label->path). Each subsystem file entry is either bare
#       (the DEFAULT lane — the "code" key if present, else the first key; SHA = subsystem
#       "verified_sha"; unmapped scan walks "src") or "<repo-basename>:<path>" (routed to the lane
#       whose repo basename matches the prefix; SHA = subsystem "verified_<label>_sha", falling back
#       to "verified_sha"; no unmapped scan for these lanes). git diff/rev-parse run in each lane's repo.
#
# Exit codes: 0 ok/warn-only · 1 strict-mode drift · 2 coverage map missing/corrupt or bad args
set -euo pipefail

cd "$(dirname "$0")/.."

MAP=".claude/skills/document-project/coverage-map.json"
JSON_OUT=false
REPO_OVERRIDE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON_OUT=true; shift;;
    --map) MAP="${2:?--map needs a path}"; shift 2;;
    --map=*) MAP="${1#--map=}"; shift;;
    --repo) REPO_OVERRIDE="${2:?--repo needs a path}"; shift 2;;
    --repo=*) REPO_OVERRIDE="${1#--repo=}"; shift;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2;;
  esac
done

if ! jq empty "$MAP" 2>/dev/null; then
  echo "ERROR: $MAP missing or invalid JSON — regenerate via a full /document-project run." >&2
  exit 2
fi

# --- resolve repo lanes from the map shape ---
# Parallel arrays, one slot per lane:
#   LANE_PATHS[i]     repo working copy to run git in
#   LANE_PREFIXES[i]  "" for the default/bare lane, else "<basename>:" carried by that lane's files
#   LANE_SHAFIELDS[i] subsystem field holding this lane's verified SHA (falls back to verified_sha)
#   LANE_SCANROOTS[i] pathspec for the unmapped scan ("" disables the scan for that lane)
declare -a LANE_PATHS LANE_PREFIXES LANE_SHAFIELDS LANE_SCANROOTS
ALT_PREFIX_RE=""   # alternation of non-default lane basenames, used to keep prefixed files out of the bare lane

if [ "$(jq -r 'has("repos")' "$MAP")" = "true" ]; then
  default_key=$(jq -r 'if (.repos | has("code")) then "code" else (.repos | keys[0]) end' "$MAP")
  if [ -n "$REPO_OVERRIDE" ]; then
    echo "WARN: --repo is ignored for multi-repo maps (paths come from the map's \"repos\")." >&2
  fi
  while IFS= read -r k; do
    path=$(jq -r --arg k "$k" '.repos[$k]' "$MAP")
    base=$(basename "$path")
    if [ "$k" = "$default_key" ]; then
      # Multi-repo maps are cross-cutting OVERLAY tracks (e.g. infra owns only the k8s/auth subset
      # of the code repo's src) — a completeness "unmapped" scan over the whole tree is just noise,
      # so it is disabled here. Their value is the per-lane cross-repo stale check above.
      LANE_PATHS+=("$path"); LANE_PREFIXES+=(""); LANE_SHAFIELDS+=("verified_sha"); LANE_SCANROOTS+=("")
    else
      LANE_PATHS+=("$path"); LANE_PREFIXES+=("$base:"); LANE_SHAFIELDS+=("verified_${k}_sha"); LANE_SCANROOTS+=("")
      ALT_PREFIX_RE="${ALT_PREFIX_RE:+$ALT_PREFIX_RE|}$base"
    fi
  done < <(jq -r '.repos | keys[]' "$MAP")
else
  repo=${REPO_OVERRIDE:-$(jq -r '.repo // "."' "$MAP")}
  pkg=$(jq -r '.package_root // ""' "$MAP")
  scanroot="src"; [ -n "$pkg" ] && scanroot="$pkg/src"
  LANE_PATHS+=("$repo"); LANE_PREFIXES+=(""); LANE_SHAFIELDS+=("verified_sha"); LANE_SCANROOTS+=("$scanroot")
fi

# jq filter selecting a lane's files from a subsystem:
#   bare lane  → entries NOT carrying any alt prefix
#   prefixed   → entries starting with the lane prefix, prefix stripped
lane_files() { # args: note prefix
  local note="$1" prefix="$2"
  if [ -z "$prefix" ]; then
    jq -r --arg n "$note" --arg re "$ALT_PREFIX_RE" \
      '.subsystems[$n].files[] | select( ($re == "") or (test("^(" + $re + "):") | not) )' "$MAP"
  else
    jq -r --arg n "$note" --arg p "$prefix" \
      '.subsystems[$n].files[] | select(startswith($p)) | ltrimstr($p)' "$MAP"
  fi
}

# same selection, but over ALL subsystems (deduped) — for the unmapped/orphaned scans
all_lane_specs() { # args: prefix
  local prefix="$1"
  if [ -z "$prefix" ]; then
    jq -r --arg re "$ALT_PREFIX_RE" \
      '[ .subsystems[].files[] | select( ($re == "") or (test("^(" + $re + "):") | not) ) ] | unique | .[]' "$MAP"
  else
    jq -r --arg p "$prefix" \
      '[ .subsystems[].files[] | select(startswith($p)) | ltrimstr($p) ] | unique | .[]' "$MAP"
  fi
}

STALE_JSON="[]"
UNMAPPED_JSON="[]"
ORPHANED_JSON="[]"
stale_count=0

# --- symbol-anchored claim delta (schema v2) ---
# A note may carry a "claims" array: each claim anchors on a stable symbol with a cached
# {span, hash} from the last verification. Instead of re-verifying the whole note when any
# mapped file drifts, docs-anchor.py re-resolves each symbol at HEAD and compares its body
# hash — so pure line-shift is ignored and only claims whose SYMBOL BODY actually changed
# (or vanished) are flagged. Notes with no claims array fall back to whole-note behaviour.
# Emits: {has_claims, drifted_claims:[{id,symbol,file,reason}], stable_claims:N}.
claim_delta() {
  local note="$1"
  local repo=""
  local i
  for i in "${!LANE_PATHS[@]}"; do
    [ -z "${LANE_PREFIXES[$i]}" ] && { repo="${LANE_PATHS[$i]}"; break; }
  done
  if [ -z "$repo" ] || [ "$(jq -r --arg n "$note" '(.subsystems[$n].claims // []) | length' "$MAP")" -eq 0 ]; then
    echo '{"has_claims":false}'; return
  fi
  local drifted="[]" stable=0 rc reason
  while IFS=$'\t' read -r id file symbol s0 s1 hash; do
    [ -z "$id" ] && continue
    rc=0
    python3 scripts/docs-anchor.py check "$file" "$symbol" \
      --span "$s0" "$s1" --hash "$hash" --sha HEAD --repo "$repo" >/dev/null 2>&1 || rc=$?
    if [ "$rc" -eq 0 ]; then
      stable=$((stable + 1))
    else
      reason="drift"; [ "$rc" -eq 4 ] && reason="absent"
      drifted=$(jq -c --arg id "$id" --arg s "$symbol" --arg f "$file" --arg r "$reason" \
        '. + [{id:$id, symbol:$s, file:$f, reason:$r}]' <<<"$drifted")
    fi
  done < <(jq -r --arg n "$note" \
    '.subsystems[$n].claims[] | [.id, .file, .symbol, (.span[0]|tostring), (.span[1]|tostring), .hash] | @tsv' "$MAP")
  jq -nc --argjson d "$drifted" --argjson st "$stable" \
    '{has_claims:true, drifted_claims:$d, stable_claims:$st}'
}

# --- per-subsystem drift (across every lane) ---
while IFS= read -r note; do
  note_changed=""
  report_sha=""
  for i in "${!LANE_PATHS[@]}"; do
    path="${LANE_PATHS[$i]}"; prefix="${LANE_PREFIXES[$i]}"; shafield="${LANE_SHAFIELDS[$i]}"
    sha=$(jq -r --arg n "$note" --arg f "$shafield" \
      '.subsystems[$n][$f] // .subsystems[$n].verified_sha // empty' "$MAP")
    [ -z "$sha" ] && continue

    mapfile -t files < <(lane_files "$note" "$prefix")
    # A note that maps no live files in this lane (e.g. a deprecation record for deleted code)
    # cannot drift here. Skip — otherwise the empty pathspec makes git diff scan the whole tree.
    [ "${#files[@]}" -eq 0 ] && continue
    [ -z "$report_sha" ] && report_sha="$sha"

    if ! git -C "$path" rev-parse --quiet --verify "${sha}^{commit}" >/dev/null 2>&1; then
      echo "WARN: $note has unknown verified_sha $sha in $(basename "$path") — treating as stale." >&2
      note_changed+="(verified_sha $sha not found in $(basename "$path"))"$'\n'
      continue
    fi
    changed=$(git -C "$path" diff --name-only "$sha"..HEAD -- "${files[@]}" 2>/dev/null || true)
    if [ -n "$changed" ]; then
      [ -n "$prefix" ] && changed="${prefix}${changed//$'\n'/$'\n'$prefix}"
      note_changed+="$changed"$'\n'
    fi
  done

  note_changed=$(sed '/^[[:space:]]*$/d' <<<"$note_changed")
  if [ -n "$note_changed" ]; then
    stale_count=$((stale_count + 1))
    delta=$(claim_delta "$note")
    STALE_JSON=$(jq -c --arg n "$note" --arg s "$report_sha" --arg c "$note_changed" --argjson d "$delta" \
      '. + [{note: $n, verified_sha: $s, changed_files: ($c | split("\n") | map(select(. != ""))), delta: $d}]' <<<"$STALE_JSON")
  fi
done < <(jq -r '.subsystems | keys[]' "$MAP")

# --- unmapped: tracked source files in the default lane matched by no entry ---
for i in "${!LANE_PATHS[@]}"; do
  scanroot="${LANE_SCANROOTS[$i]}"
  [ -z "$scanroot" ] && continue
  path="${LANE_PATHS[$i]}"; prefix="${LANE_PREFIXES[$i]}"
  mapfile -t all_specs < <(all_lane_specs "$prefix")
  if [ "${#all_specs[@]}" -gt 0 ]; then
    mapped=$(git -C "$path" ls-files -- "${all_specs[@]}" 2>/dev/null | sort -u)
  else
    mapped=""
  fi
  all_src=$(git -C "$path" ls-files -- "$scanroot" | sort -u)
  unmapped=$(comm -23 <(echo "$all_src") <(echo "$mapped") || true)
  if [ -n "$unmapped" ]; then
    UNMAPPED_JSON=$(jq -c -R -s 'split("\n") | map(select(. != ""))' <<<"$unmapped")
  fi
  break  # only the default lane carries an unmapped scan
done

# --- orphaned: explicit file entries (not directory specs) that no longer exist ---
orphaned=""
for i in "${!LANE_PATHS[@]}"; do
  path="${LANE_PATHS[$i]}"; prefix="${LANE_PREFIXES[$i]}"
  mapfile -t specs < <(all_lane_specs "$prefix")
  for spec in "${specs[@]:-}"; do
    [ -z "$spec" ] && continue
    if [[ "$spec" == *.* ]] && [ -z "$(git -C "$path" ls-files -- "$spec")" ]; then
      orphaned+="${prefix}${spec}"$'\n'
    fi
  done
done
if [ -n "$orphaned" ]; then
  ORPHANED_JSON=$(jq -c -R -s 'split("\n") | map(select(. != ""))' <<<"$orphaned")
fi

unmapped_count=$(jq 'length' <<<"$UNMAPPED_JSON")
orphaned_count=$(jq 'length' <<<"$ORPHANED_JSON")

if $JSON_OUT; then
  jq -n --argjson stale "$STALE_JSON" --argjson unmapped "$UNMAPPED_JSON" --argjson orphaned "$ORPHANED_JSON" \
    '{stale: $stale, unmapped: $unmapped, orphaned: $orphaned}'
else
  if [ "$stale_count" -eq 0 ] && [ "$unmapped_count" -eq 0 ] && [ "$orphaned_count" -eq 0 ]; then
    echo "docs-freshness: vault is current (all notes match HEAD)."
  else
    echo "docs-freshness: VAULT DRIFT DETECTED"
    if [ "$stale_count" -gt 0 ]; then
      echo ""
      echo "Stale notes ($stale_count):"
      jq -r '.[] |
        "  • \(.note)"
        + ( if (.delta.has_claims // false)
            then "   [delta: \(.delta.drifted_claims | length) claim(s) to re-verify, \(.delta.stable_claims) stable"
                 + ( if ((.delta.drifted_claims | length) > 0)
                     then " → " + (.delta.drifted_claims | map("\(.symbol) (\(.reason))") | join(", "))
                     else "" end )
                 + "]"
            else "   [no claim anchors — whole-note re-verify]" end )
        + "\n" + (.changed_files | map("      - " + .) | join("\n"))' <<<"$STALE_JSON"
    fi
    if [ "$unmapped_count" -gt 0 ]; then
      echo ""
      echo "Unmapped src files ($unmapped_count) — no vault note covers these:"
      jq -r '.[] | "  • " + .' <<<"$UNMAPPED_JSON"
    fi
    if [ "$orphaned_count" -gt 0 ]; then
      echo ""
      echo "Orphaned map entries ($orphaned_count) — cited files no longer exist:"
      jq -r '.[] | "  • " + .' <<<"$ORPHANED_JSON"
    fi
    echo ""
    echo "Run: /document-project $(jq -r '.project // "mcp-server"' "$MAP") --update"
  fi
fi

if [ "${BUREAU_DOCS_STRICT:-0}" = "1" ] && { [ "$stale_count" -gt 0 ] || [ "$unmapped_count" -gt 0 ] || [ "$orphaned_count" -gt 0 ]; }; then
  exit 1
fi
exit 0
