#!/usr/bin/env bash
# Assert the worker-image contract: the language-neutral reliability core is
# present and intact. Used for the base/node split (Phase 0) and reused by every
# per-language worker layer (python, dotnet, ...).
#
# Usage: scripts/smoke-worker-image.sh <image-ref> [--lang python]
#   --lang python  also asserts the Python toolchain layer (python3/pip/pytest/ruff,
#                  writable HOME for UID 1000) WITHOUT regressing the neutral core.
set -euo pipefail

IMG="${1:?usage: smoke-worker-image.sh <image-ref> [--lang <name>]}"
LANG_LAYER=""
if [ "${2:-}" = "--lang" ]; then LANG_LAYER="${3:?usage: --lang <name>}"; fi

# Override the image's real ENTRYPOINT (the bureau worker entrypoint) so we can
# probe the filesystem without launching claude.
probe() { docker run --rm --entrypoint sh "$IMG" -c "$1"; }

echo "== $IMG: node present (claude CLI runtime + steer-hook node -e) =="
probe 'command -v node >/dev/null'

echo "== claude CLI present =="
probe 'command -v claude >/dev/null'

echo "== git present =="
probe 'command -v git >/dev/null'

echo "== worker entrypoint installed + executable =="
probe 'test -x /usr/local/bin/bureau-worker-entrypoint'

echo "== steer-hook installed + executable =="
probe 'test -x /usr/local/bin/bureau-steer-hook.sh'

echo "== steer-settings present =="
probe 'test -f /etc/bureau/steer-settings.json'

echo "== workdir is /workspace =="
if ! got="$(docker run --rm --entrypoint pwd "$IMG")"; then
  echo "FAIL: docker run failed while probing workdir for $IMG"
  exit 1
fi
test "$got" = /workspace || { echo "FAIL: workdir is '$got', want /workspace"; exit 1; }

if [ "$LANG_LAYER" = "python" ]; then
  echo "== uv present (python toolchain provider) =="
  probe 'command -v uv >/dev/null'

  echo "== managed Python 3.12 baked + resolvable =="
  probe 'uv python find 3.12 >/dev/null'

  echo "== UID 1000 can create a venv + run python3.12 (writable HOME/cache, no passwd entry) =="
  # Run as the pod's real numeric UID with no extra env; the layer must make this work.
  docker run --rm --user 1000:1000 -w /tmp --entrypoint bash "$IMG" -c \
    'uv venv --python 3.12 v >/dev/null 2>&1 && v/bin/python -c "import sys; assert sys.version_info[:2]==(3,12)"' \
    || { echo "FAIL: UID 1000 cannot create a python3.12 venv"; exit 1; }

  echo "== pytest+ruff are a uv-cache hit for UID 1000 (offline-fast per-run install) =="
  docker run --rm --user 1000:1000 -w /tmp --network none --entrypoint bash "$IMG" -c \
    'uv venv --python 3.12 v >/dev/null 2>&1 && uv pip install --offline --python v -q pytest ruff && v/bin/pytest --version >/dev/null' \
    || { echo "FAIL: pytest/ruff not cached (per-run install would need network)"; exit 1; }

  echo "== node STILL present (steer-hook node -e must not regress) =="
  probe 'node -e "process.exit(0)"'
fi

if [ "$LANG_LAYER" = "dotnet" ]; then
  # Use a LOGIN shell (bash -lc) — the worker entrypoint runs `bash -lc "$CMD"`, whose
  # /etc/profile rebuilds PATH; this catches a toolchain that's only on a non-login PATH.
  echo "== .NET 8 SDK present (login-shell PATH) =="
  docker run --rm --entrypoint bash "$IMG" -lc 'dotnet --version | grep -q ^8\.' \
    || { echo "FAIL: dotnet not on the login-shell PATH (entrypoint uses bash -lc)"; exit 1; }

  echo "== UID 1000 can scaffold + run an xUnit project (writable HOME/NuGet, no passwd entry) =="
  # Pod's real numeric UID, login shell, no extra env; the layer must make this work
  # (dotnet on PATH + DOTNET_CLI_HOME/NUGET_PACKAGES under a world-writable HOME, warmed cache).
  docker run --rm --user 1000:1000 -w /tmp --entrypoint bash "$IMG" -lc \
    'set -e; dotnet new xunit -o t >/dev/null 2>&1; cd t; dotnet test -v q >/dev/null 2>&1' \
    || { echo "FAIL: UID 1000 cannot dotnet test in a login shell (PATH/HOME/NuGet?)"; exit 1; }

  echo "== trx2junit present (login-shell PATH, UID 1000) — JUnit-from-trx for the coverage gate =="
  docker run --rm --user 1000:1000 --entrypoint bash "$IMG" -lc 'command -v trx2junit >/dev/null' \
    || { echo "FAIL: trx2junit not on the login-shell PATH for UID 1000"; exit 1; }

  echo "== node STILL present (steer-hook node -e must not regress) =="
  probe 'node -e "process.exit(0)"'
fi

echo "OK: $IMG satisfies the worker contract${LANG_LAYER:+ (+$LANG_LAYER layer)}"
