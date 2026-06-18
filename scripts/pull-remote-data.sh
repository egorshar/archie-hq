#!/usr/bin/env bash
#
# pull-remote-data.sh — download Archie's memory & session data from a remote
# docker-compose host over SSH.
#
# Streams a gzip'd tar of /workdir/{memory,sessions} out of the running
# container directly to a local file. Runs the tar *inside* the container, so
# it works whether /workdir is a bind mount or a named volume, and needs no
# host-path or file-ownership guessing (docker exec runs as root by default).
#
# By default the heavy sessions/<taskId>/repos/ git worktrees are excluded —
# they are redundant git checkouts and can be gigabytes.
#
# Usage:
#   scripts/pull-remote-data.sh [options] HOST [CONTAINER]
#
# Arguments:
#   HOST          SSH target (e.g. user@1.2.3.4 or an ssh_config alias)
#   CONTAINER     Container name. Optional — auto-detected from `docker ps`
#                 (first image/name matching "archie") when omitted.
#
# Options:
#   -o, --out FILE        Output tarball path
#                         (default: archie-data-YYYYMMDD-HHMMSS.tgz)
#   -m, --memory-only     Download only memory/ (skip sessions/)
#   -r, --include-repos   Include sessions/*/repos worktrees (default: excluded)
#   -x, --extract DIR     Extract the tarball into DIR after download
#   -s, --sudo            Run docker via sudo on the remote (use when the SSH
#                         user is not in the host's `docker` group). Requires
#                         passwordless sudo for the streaming step.
#   -h, --help            Show this help
#
# Examples:
#   scripts/pull-remote-data.sh deploy@archie.example.com
#   scripts/pull-remote-data.sh -s -m -x ./snapshot deploy@host archie-hq-archie-1
#
set -euo pipefail

usage() { sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; /^set -euo/d'; }

OUT=""
MEMORY_ONLY=0
INCLUDE_REPOS=0
EXTRACT_DIR=""
SUDO=0

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--out)          OUT="$2"; shift 2 ;;
    -m|--memory-only)  MEMORY_ONLY=1; shift ;;
    -r|--include-repos) INCLUDE_REPOS=1; shift ;;
    -x|--extract)      EXTRACT_DIR="$2"; shift 2 ;;
    -s|--sudo)         SUDO=1; shift ;;
    -h|--help)         usage; exit 0 ;;
    --)                shift; POSITIONAL+=("$@"); break ;;
    -*)                echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *)                 POSITIONAL+=("$1"); shift ;;
  esac
done

set -- "${POSITIONAL[@]}"
HOST="${1:-}"
CONTAINER="${2:-}"

if [[ -z "$HOST" ]]; then
  echo "error: HOST is required" >&2
  usage >&2
  exit 2
fi

# Prefix for remote docker calls. `sudo -n` fails fast (rather than hanging on a
# password prompt with no tty) when passwordless sudo isn't configured.
DOCKER="docker"
[[ "$SUDO" -eq 1 ]] && DOCKER="sudo -n docker"

# --- Resolve the container name on the remote host ---------------------------
if [[ -z "$CONTAINER" ]]; then
  echo "› Detecting Archie container on $HOST ..." >&2
  mapfile -t MATCHES < <(ssh "$HOST" "$DOCKER ps --format '{{.Names}}\t{{.Image}}'" \
    | grep -i archie | cut -f1 || true)
  if [[ ${#MATCHES[@]} -eq 0 ]]; then
    echo "error: no running container matching 'archie' on $HOST." >&2
    echo "       Pass the container name explicitly as the 2nd argument." >&2
    echo "       List candidates with: ssh $HOST docker ps" >&2
    exit 1
  elif [[ ${#MATCHES[@]} -gt 1 ]]; then
    echo "error: multiple containers match 'archie':" >&2
    printf '         %s\n' "${MATCHES[@]}" >&2
    echo "       Pass one explicitly as the 2nd argument." >&2
    exit 1
  fi
  CONTAINER="${MATCHES[0]}"
  echo "› Using container: $CONTAINER" >&2
fi

# --- Build the remote tar command --------------------------------------------
# Members under /workdir to archive.
MEMBERS="memory"
[[ "$MEMORY_ONLY" -eq 0 ]] && MEMBERS="memory sessions"

# Exclude the per-task repo worktrees unless explicitly requested. Single quotes
# keep the glob literal so the *remote* host shell doesn't expand it.
EXCLUDE=""
[[ "$INCLUDE_REPOS" -eq 0 ]] && EXCLUDE="--exclude='sessions/*/repos'"

REMOTE_CMD="$DOCKER exec $CONTAINER tar -czf - -C /workdir $EXCLUDE $MEMBERS"

# --- Output path -------------------------------------------------------------
if [[ -z "$OUT" ]]; then
  OUT="archie-data-$(date +%Y%m%d-%H%M%S).tgz"
fi

# Stream to a temp file alongside the final path, and only promote it to $OUT
# once the download has fully succeeded. This guarantees no $OUT is ever left
# behind on a failed/partial download. The temp file is cleaned up on any exit.
TMP_OUT="$(mktemp "${OUT}.partial.XXXXXX")"
cleanup() {
  if [[ -n "${TMP_OUT:-}" && -f "${TMP_OUT:-}" ]]; then
    rm -f "$TMP_OUT"
  fi
  return 0   # never let the EXIT trap clobber the script's real exit status
}
trap cleanup EXIT

echo "› Pulling [$MEMBERS] from $CONTAINER on $HOST → $OUT" >&2
# shellcheck disable=SC2029  # we intend $REMOTE_CMD to expand locally into one arg
if ! ssh "$HOST" "$REMOTE_CMD" > "$TMP_OUT"; then
  echo "error: download failed (see message above) — no file written." >&2
  exit 1
fi

if [[ ! -s "$TMP_OUT" ]]; then
  echo "error: downloaded stream was empty — check the container name and that" >&2
  echo "       /workdir/memory exists inside it. No file written." >&2
  exit 1
fi

# Integrity gate: reject a truncated/garbage stream (e.g. a mid-transfer drop)
# before it ever lands as $OUT. `tar -tzf` (not `gzip -t`) — it confirms the
# archive is actually readable, and Apple's gzip spuriously fails `-t` on tar's
# block-padded output ("trailing garbage ignored").
if ! tar -tzf "$TMP_OUT" >/dev/null 2>&1; then
  echo "error: downloaded data is not a readable gzip archive (partial/corrupt) —" >&2
  echo "       no file written." >&2
  exit 1
fi

mv "$TMP_OUT" "$OUT"
TMP_OUT=""   # promoted — keep the cleanup trap from deleting it

SIZE=$(du -h "$OUT" | cut -f1)
echo "✓ Downloaded $OUT ($SIZE)" >&2

# --- Optional extract --------------------------------------------------------
if [[ -n "$EXTRACT_DIR" ]]; then
  mkdir -p "$EXTRACT_DIR"
  tar -xzf "$OUT" -C "$EXTRACT_DIR"
  echo "✓ Extracted into $EXTRACT_DIR/" >&2
fi

exit 0
