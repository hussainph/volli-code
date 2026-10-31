#!/bin/sh
# First installs trust TLS to the release origin. SHA-256 detects corruption,
# not a malicious origin. --verify-provenance additionally requires logged-in gh.
# This file is version-stamped by scripts/runner-release-manifest.mjs.
main() {
  set -eu
  umask 077
  version='@VOLLI_RUNNER_VERSION@'
  channel=stable
  mode=
  no_start=false
  no_link=false
  provenance=false
  release_base=
  token=${VOLLI_RUNNER_TOKEN:-}
  name=
  server=${VOLLI_SERVER:-}
  fail() { printf 'volli-runner: %s\n' "$*" >&2; exit 1; }
  need_value() {
    if [ "$#" -lt 2 ] || [ -z "$2" ]; then fail "$1 needs a value"; fi
  }
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --token) need_value "$@"; token=$2; shift 2 ;;
      --name) need_value "$@"; name=$2; shift 2 ;;
      --server) need_value "$@"; server=$2; shift 2 ;;
      --version) need_value "$@"; version=$2; shift 2 ;;
      --channel) need_value "$@"; channel=$2; shift 2 ;;
      --release-base) need_value "$@"; release_base=${2%/}; shift 2 ;;
      --user|--system) [ -z "$mode" ] || fail 'choose only one of --user and --system'; mode=$1; shift ;;
      --no-start) no_start=true; shift ;;
      --no-link) no_link=true; shift ;;
      --verify-provenance) provenance=true; shift ;;
      --help|-h)
        printf '%s\n' 'Usage: install.sh [--token TOKEN] [--name NAME] [--server URL] [--user|--system]' \
          '  [--channel stable|canary] [--version VERSION] [--no-start] [--no-link]' \
          '  [--release-base URL] [--verify-provenance]' \
          'VOLLI_RUNNER_TOKEN and VOLLI_SERVER are also accepted. No system packages are installed.' \
          'The script installs its stamped version; --channel selects the update channel.'
        return ;;
      *) fail "unknown option: $1" ;;
    esac
  done
  case "$channel" in stable|canary) ;; *) fail 'channel must be stable or canary' ;; esac
  printf '%s\n' "$version" | LC_ALL=C awk '/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/ { ok=1 } END { exit !ok }' || fail 'invalid version (use --version X.Y.Z)'
  case "$(uname -s)" in
    Linux) ;;
    Darwin) printf '%s\n' 'Your Mac runner is the Volli app.'; return ;;
    *) fail 'Linux is required for the standalone runner' ;;
  esac
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) fail 'unsupported architecture (use Linux x64 or arm64)' ;;
  esac
  libc=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
  case "$libc" in 'glibc '*) glibc=${libc#glibc } ;; *) fail 'musl/non-glibc is unsupported; use Debian, Ubuntu or Fedora (glibc >= 2.31)' ;; esac
  uid=$(id -u)
  if [ -z "$mode" ]; then
    if [ "$uid" -eq 0 ]; then mode=--system; else mode=--user; fi
  fi
  [ "$mode" != --user ] || [ "$uid" -ne 0 ] || fail '--user cannot run as root; use --system (agents run as volli)'
  [ "$mode" != --system ] || [ "$uid" -eq 0 ] || fail '--system needs root; run the command with sudo'
  for tool in awk tar gzip df mktemp; do command -v "$tool" >/dev/null 2>&1 || fail "missing $tool; install it with your package manager"; done
  if command -v curl >/dev/null 2>&1; then downloader=curl
  elif command -v wget >/dev/null 2>&1; then downloader=wget
  else fail 'install curl or wget with your package manager, then retry'; fi
  if command -v sha256sum >/dev/null 2>&1; then checksum=sha256sum
  elif command -v shasum >/dev/null 2>&1; then checksum=shasum
  else fail 'install coreutils (sha256sum), then retry'; fi
  if "$provenance"; then command -v gh >/dev/null 2>&1 || fail '--verify-provenance needs gh; install GitHub CLI and run gh auth login'; fi
  if command -v apt-get >/dev/null 2>&1; then git_fix='sudo apt-get update && sudo apt-get install -y git'
  elif command -v dnf >/dev/null 2>&1; then git_fix='sudo dnf install -y git'
  else git_fix='install git >= 2.30 with your package manager'; fi
  if ! command -v git >/dev/null 2>&1; then
    printf 'Git is missing. Before running Sessions: %s\n' "$git_fix" >&2
  elif ! git --version | awk '{ split($3,v,"."); exit !(v[1]>2 || (v[1]==2 && v[2]>=30)) }'; then
    printf 'Git >= 2.30 is required for Sessions: %s\n' "$git_fix" >&2
  fi
  # Check the filesystem that will hold the installed release, not just /tmp.
  if [ "$mode" = --system ]; then disk_path=/opt; else disk_path=${HOME:?HOME is required}; fi
  while [ ! -d "$disk_path" ]; do disk_path=$(dirname "$disk_path"); done
  free=$(df -Pk "$disk_path" | awk 'NR==2 {print $4}')
  case "$free" in ''|*[!0-9]*) fail 'could not determine free disk space' ;; esac
  [ "$free" -ge 1048576 ] || fail 'at least 1 GiB free disk is required'
  if [ ! -d /run/systemd/system ]; then
    no_start=true
    printf '%s\n' 'systemd is unavailable; installing without starting. Afterwards run: volli-runner run' >&2
  fi
  [ -n "$release_base" ] || release_base="https://github.com/hussainph/volli-code/releases/download/v$version"
  safe_url() {
    case "$1" in
      https://*) ;;
      http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*)
        authority=${1#*://}; authority=${authority%%/*}; port=${authority##*:}
        case "$port" in ''|*[!0-9]*) fail 'invalid loopback release URL' ;; esac ;;
      *) fail 'release URLs must use HTTPS (HTTP is allowed only for loopback tests)' ;;
    esac
    case "$1" in *[[:space:]]*|*\\*|*@*) fail 'invalid release URL' ;; esac
  }
  safe_url "$release_base"
  temp=$(mktemp -d "${TMPDIR:-/tmp}/volli-runner.XXXXXX")
  # No credential is written to staging. Failed downloads/probes leave nothing.
  trap 'rm -rf "$temp"' 0
  trap 'exit 1' 1 2 15
  fetch() {
    safe_url "$1"
    if [ "$downloader" = curl ]; then
      case "$1" in https:*) protocols='=https' ;; *) protocols='=http,https' ;; esac
      curl -fsSL --connect-timeout 20 --max-time 600 --proto "$protocols" --proto-redir "$protocols" "$1" -o "$2"
    else
      # wget has no curl-style --proto-redir. Follow redirects ourselves so an
      # HTTPS origin cannot silently downgrade this trust boundary to HTTP.
      download_url=$1
      attempt=0
      while [ "$attempt" -lt 10 ]; do
        safe_url "$download_url"
        if wget -q --timeout=60 --server-response --max-redirect=0 -O "$2" "$download_url" 2> "$temp/headers"; then return 0; fi
        location=$(awk 'tolower($1)=="location:" { sub(/^[^:]*:[ \t]*/, ""); sub(/\r$/, ""); print; exit }' "$temp/headers")
        [ -n "$location" ] || return 1
        case "$location" in
          https://*|http://*) download_url=$location ;;
          //*) download_url="${download_url%%:*}:$location" ;;
          /*) origin=${download_url#*://}; download_url="${download_url%%:*}://${origin%%/*}$location" ;;
          *) download_url="${download_url%/*}/$location" ;;
        esac
        attempt=$((attempt + 1))
      done
      return 1
    fi
  }
  fetch "$release_base/volli-runner-manifest.json" "$temp/manifest.json" || fail 'manifest download failed'
  [ "$(wc -c < "$temp/manifest.json")" -le 65536 ] || fail 'manifest is too large'
  # Strict dependency-free parser for the ASCII runner release manifest. No eval, jq, Python
  # or system Node is needed. Escaped strings are refused rather than misread.
  LC_ALL=C awk -v arch="$arch" -v version="$version" '
    function bad() { exit 1 }
    function ws() { sub(/^[ \r\n\t]+/, "", src) }
    function take(c) { ws(); if (substr(src,1,1)!=c) bad(); src=substr(src,2) }
    function string(  end,s) {
      take("\""); end=index(src,"\""); if (!end) bad(); s=substr(src,1,end-1)
      if (s ~ /[\\[:cntrl:]]/) bad(); src=substr(src,end+1); return s
    }
    function value(path,depth,  c,k,n,v) {
      if (depth>16 || seen[path]++) bad(); ws(); c=substr(src,1,1)
      if (c=="{") {
        take("{"); ws(); if (substr(src,1,1)=="}") {take("}"); return}
        do { k=string(); if (k !~ /^[A-Za-z][A-Za-z0-9]*$/) bad(); take(":"); value(path "/" k,depth+1); ws(); c=substr(src,1,1); if(c==",") take(",") } while(c==",")
        take("}")
      } else if(c=="[") {
        take("["); n=0; ws(); if(substr(src,1,1)=="]") {take("]"); return}
        do { value(path "/" n++,depth+1); ws(); c=substr(src,1,1); if(c==",") take(",") } while(c==",")
        take("]"); count[path]=n
      } else if(c=="\"") data[path]=string()
      else { if(!match(src,/^(0|[1-9][0-9]*)([.][0-9]+)?([eE][+-]?[0-9]+)?|^true|^false|^null/)) bad(); data[path]=substr(src,1,RLENGTH); src=substr(src,RLENGTH+1) }
    }
    { src=src $0 "\n" }
    END {
      value("",0); ws(); if(src!="") bad()
      if(data["/schemaVersion"]!=1 || data["/version"]!=version || data["/releaseTag"]!="v" version || data["/minGlibc"]!="2.31" || count["/targets"]!=2) bad()
      matches=0
      for(i=0;i<2;i++) { p="/targets/" i; if(data[p "/platform"]!="linux") bad(); if(data[p "/arch"]==arch) { matches++; target=p } }
      if(matches!=1) bad()
      print data["/minGlibc"]; print data[target "/sha256"]; print data[target "/size"]; print data[target "/url"]
    }
  ' "$temp/manifest.json" > "$temp/target" || fail 'invalid runner manifest'
  min_glibc=$(sed -n '1p' "$temp/target")
  sha=$(sed -n '2p' "$temp/target")
  size=$(sed -n '3p' "$temp/target")
  url=$(sed -n '4p' "$temp/target")
  printf '%s\n' "$glibc $min_glibc" | awk '{ split($1,a,"."); split($2,b,"."); exit !(a[1]>b[1] || (a[1]==b[1] && a[2]>=b[2])) }' || fail "glibc >= $min_glibc is required"
  [ "${#sha}" -eq 64 ] || fail 'invalid manifest SHA-256'
  case "$sha" in *[!0-9a-f]*) fail 'invalid manifest SHA-256' ;; esac
  case "$size" in ''|*[!0-9]*) fail 'invalid manifest size' ;; esac
  [ "$size" -gt 0 ] || fail 'invalid manifest size'
  fetch "$url" "$temp/runner.tar.gz" || fail 'runner download failed'
  [ "$(wc -c < "$temp/runner.tar.gz")" -eq "$size" ] || fail 'runner size mismatch'
  if [ "$checksum" = sha256sum ]; then actual=$(sha256sum "$temp/runner.tar.gz"); else actual=$(shasum -a 256 "$temp/runner.tar.gz"); fi
  [ "${actual%% *}" = "$sha" ] || fail 'runner SHA-256 mismatch'
  printf '%s\n' 'SHA-256 verified. First-install authenticity trusts TLS to the release origin.' >&2
  if "$provenance"; then gh attestation verify "$temp/runner.tar.gz" --repo hussainph/volli-code >/dev/null || fail 'provenance verification failed'; fi
  root="volli-runner-$version-linux-$arch"
  tar -tzf "$temp/runner.tar.gz" > "$temp/entries" || fail 'invalid runner archive'
  # Reject traversal/absolute paths before extraction, even for a corrupt mirror.
  awk -v root="$root" 'index($0,root "/")!=1 && $0!=root {exit 1} /(^|\/)\.\.(\/|$)/ {exit 1}' "$temp/entries" || fail 'unsafe runner archive path'
  tar -xzf "$temp/runner.tar.gz" --no-same-owner -C "$temp" || fail 'runner extraction failed'
  from="$temp/$root"
  "$from/bin/node" "$from/lib/probe-natives.cjs" || fail 'native modules cannot run on this machine'
  "$from/bin/node" "$from/lib/probe-codemode.mjs" || fail 'Code Mode cannot run on this machine'
  # Keep tokens out of the process argument list, including --token input.
  export VOLLI_RUNNER_TOKEN="$token" VOLLI_SERVER="$server" \
    VOLLI_RUNNER_RELEASE_BASE="$release_base"
  set -- install "$mode" --from "$from" --channel "$channel"
  [ -z "$name" ] || set -- "$@" --name "$name"
  [ -z "$server" ] || set -- "$@" --server "$server"
  if "$no_start"; then set -- "$@" --no-start; fi
  if "$no_link"; then set -- "$@" --no-link; fi
  # install copies --from to its permanent release before starting the service.
  # The binary owns this handoff; staging contains no secrets and lives in /tmp.
  # The service account must be able to read root-owned release code and units;
  # install sets explicit 0700/0600 modes on its data and credentials instead.
  umask 022
  exec "$from/bin/volli-runner" "$@"
}
# Last line is deliberate: a partial curl download never begins installation.
main "$@"
