#!/usr/bin/env bash
# Read-only attribution of retained Linux frames. Never execute the archive's
# binary. The next ordinary package CI job is the sole caller; no retry lane.
set -euo pipefail

out="${1:?diagnostics directory required}"
mkdir -p "$out" .tmp
work="$(mktemp -d .tmp/worker-symbolize.XXXXXX)"
finish() {
  code=$?
  if (( code != 0 )); then printf 'diagnostic_status=failed\n'; fi
  if ! rm -rf "$work"; then
    printf 'diagnostic_failure=cleanup_failed\ndiagnostic_status=failed\n'
    code=1
  fi
  exit "$code"
}
trap finish EXIT
fail() { printf 'diagnostic_failure=%s\n' "$1"; exit 1; }

[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || fail unsupported_platform
for tool in curl tar sha256sum cmp readelf addr2line nm awk; do
  command -v "$tool" >/dev/null || fail tool_unavailable
done

# Provenance: actions/node-versions manifest for this exact setup-node asset.
url='https://github.com/actions/node-versions/releases/download/24.22.1-39619001896/node-24.22.1-linux-x64.tar.gz'
expected='13c8f1384f72ada969d164b8de7ebacd55f3fb18a97ea86abd9b7ebdb6c77c26'
printf 'archive_source=%s\narchive_sha256_expected=%s\n' "$url" "$expected"
job_node="$(command -v node)" || fail job_node_missing
cache="${VOLLI_WORKER_NODE_ARCHIVE:-.tmp/worker-node-archive/$expected.tar.gz}"
cache_miss=0
if node scripts/worker-node-archive.mjs restore "$cache" "$work/node.tar.gz" "$expected"; then
  printf 'archive_cache=verified_hit\n'
else
  code=$?
  (( code == 2 )) || exit 1
  cache_miss=1
  printf 'archive_cache=miss\n'
  curl --disable --fail --silent --location --proto '=https' --proto-redir '=https' \
    --max-time 90 --max-filesize 134217728 "$url" -o "$work/node.tar.gz" \
    || fail archive_download_failed
fi
actual="$(sha256sum "$work/node.tar.gz" | awk '{print $1}')"
printf 'archive_sha256_actual=%s\n' "$actual"
[[ "$actual" == "$expected" ]] || fail archive_checksum_mismatch
member="$(tar -tzf "$work/node.tar.gz" | awk '/(^|\/)bin\/node$/ {n++; path=$0} END {if(n != 1) exit 1; print path}')" \
  || fail archive_binary_missing
[[ "$member" != /* && "/$member/" != *'/../'* ]] || fail unsafe_archive_member
tar -xOzf "$work/node.tar.gz" -- "$member" > "$work/node" || fail archive_extract_failed
archive_binary_sha="$(sha256sum "$work/node" | awk '{print $1}')"
job_binary_sha="$(sha256sum "$job_node" | awk '{print $1}')"
printf 'archive_node_sha256=%s\njob_node_sha256=%s\n' "$archive_binary_sha" "$job_binary_sha"
cmp -s "$work/node" "$job_node" || fail job_binary_identity_mismatch
printf 'binary_identity=verified_exact_match\n'
# Never publish partial downloads, unsafe members or a different Node binary.
if (( cache_miss )); then
  node scripts/worker-node-archive.mjs publish "$cache" "$work/node.tar.gz" "$expected" || exit 1
fi
readelf -n "$job_node" > "$work/notes" || fail readelf_failed
build_id="$(awk '/Build ID:/ {print $3; found=1} END {if(!found) exit 1}' "$work/notes")" \
  || fail build_id_unavailable
[[ "$build_id" != *[^a-fA-F0-9]* && -n "$build_id" ]] || fail invalid_build_id
printf 'elf_build_id=%s\n' "$build_id"

addresses=(0xd95c19 0x1903873 0x193e2cf 0x19231ae 0x1923361 0x18fb1bf 0x18fdfbc 0x17930ef)
addr2line -C -f -e "$job_node" "${addresses[@]}" > "$work/lines" || fail addr2line_failed
unknown=0
for address in "${addresses[@]}"; do
  IFS= read -r function <&3 || fail addr2line_incomplete
  IFS= read -r source <&3 || fail addr2line_incomplete
  printf 'address=%s\nfunction=%s\nsource=%s\n' "$address" "${function:0:1024}" "${source:0:1024}"
  if [[ "$function" == '??' ]]; then unknown=1; fi
done 3< "$work/lines"
if (( unknown == 0 )); then
  printf 'diagnostic_status=functions_resolved_not_test_attributed\n'
  exit 0
fi

# Nearest preceding symbols are clues, not exact function or test attribution.
# Stream/filter nm output; never retain its full symbol table in the artifact.
nm -n -C "$job_node" 2>/dev/null | awk '
  BEGIN {split("0000000000d95c19 0000000001903873 000000000193e2cf 00000000019231ae 0000000001923361 00000000018fb1bf 00000000018fdfbc 00000000017930ef", target)}
  length($1) == 16 && $1 !~ /[^a-fA-F0-9]/ && $2 ~ /^[tTwW]$/ {
    address=tolower($1)
    for(i=1; i<=8; i++) if(address "x" <= target[i] "x") nearest[i]=substr($0,1,1024)
  }
  END {
    for(i=1; i<=8; i++) if(nearest[i] != "") {
      printf "nearest_preceding_symbol[%s]=%s\n", target[i], nearest[i]; found=1
    }
    if(!found) print "symbol_table=unavailable_or_stripped"
  }' || fail nm_failed
printf 'diagnostic_status=unattributed_or_partial_no_cause_inferred\n'
