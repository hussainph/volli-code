#!/usr/bin/env bash
# The runner's own health, sampled beside a test shard (VC-1209).
#
# A shard can stall because a test stalls, or because the VM under it does.
# A test's own timings cannot tell the two apart. One red desktop shard had
# two test files run about 14x their usual time, and both forks woke in the same
# millisecond, on a runner whose dependency install had already taken twice
# the 99th percentile before any test ran. Each line here is the
# kernel's view of the last interval: CPU split including steal (time the
# hypervisor gave to someone else) and I/O wait, runnable and blocked tasks,
# available memory and the pressure-stall averages. A stalled VM shows as
# steal, I/O wait or pressure on every line of the stall. A stalled test shows
# as an idle machine.
#
# Usage: ci-runner-health.sh <diagnostics-dir> &   (the caller kills it)
# Linux only. It writes <diagnostics-dir>/runner-health.log, one line per
# interval (VOLLI_RUNNER_HEALTH_INTERVAL seconds, default 5), and never fails
# the job: each read that is not available is left out of the line.
set -u

dir="${1:?usage: ci-runner-health.sh <diagnostics-dir>}"
interval="${VOLLI_RUNNER_HEALTH_INTERVAL:-5}"
out="$dir/runner-health.log"
mkdir -p "$dir" 2>/dev/null || true

# user, system (incl. irq/softirq), idle, iowait, steal, total — cumulative ticks.
cpu_ticks() {
  awk '/^cpu /{u=$2+$3; s=$4+$7+$8; t=u+s+$5+$6+$9; print u, s, $5, $6, $9, t}' /proc/stat 2>/dev/null
}

psi() {
  local name="$1"
  [[ -r "/proc/pressure/$name" ]] || return 0
  awk -v k="$name" '{split($2, a, "="); printf " %s_%s=%s", k, $1, a[2]}' "/proc/pressure/$name"
}

{
  printf '# start=%s nproc=%s' "$(date -u +%FT%TZ)" "$(nproc 2>/dev/null)"
  printf ' cpu=%s' "$(awk -F': ' '/^model name/{print $2; exit}' /proc/cpuinfo 2>/dev/null | tr ' ' '_')"
  printf ' kernel=%s\n' "$(uname -r)"
  echo "# percentages are of the last interval; *_some/*_full are /proc/pressure avg10"
} >>"$out" 2>/dev/null

prev="$(cpu_ticks)"
while sleep "$interval"; do
  cur="$(cpu_ticks)"
  line="$(date -u +%T)"
  if [[ -n "$prev" && -n "$cur" ]]; then
    line+="$(awk -v p="$prev" -v c="$cur" 'BEGIN {
      split(p, a, " "); split(c, b, " ");
      dt = b[6] - a[6]; if (dt <= 0) dt = 1;
      printf " user=%.0f%% sys=%.0f%% idle=%.0f%% iowait=%.0f%% steal=%.0f%%",
        100 * (b[1] - a[1]) / dt, 100 * (b[2] - a[2]) / dt, 100 * (b[3] - a[3]) / dt,
        100 * (b[4] - a[4]) / dt, 100 * (b[5] - a[5]) / dt
    }')"
  fi
  prev="$cur"
  line+="$(awk '/^procs_running/{r=$2} /^procs_blocked/{b=$2} END{if (r != "") printf " running=%s blocked=%s", r, b}' /proc/stat 2>/dev/null)"
  line+="$(awk '{printf " load1=%s", $1}' /proc/loadavg 2>/dev/null)"
  line+="$(awk '/^MemAvailable:/{printf " mem_available_mb=%d", $2 / 1024}' /proc/meminfo 2>/dev/null)"
  line+="$(psi cpu)$(psi io)$(psi memory)"
  echo "$line" >>"$out" 2>/dev/null
done
