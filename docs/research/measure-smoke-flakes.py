#!/usr/bin/env python3
"""VC-522: read-only GitHub CI census; no dependencies or local app/suite runs.

Collect: python3 docs/research/measure-smoke-flakes.py collect --end 2026-10-02T20:41:51Z
Summarize: python3 docs/research/measure-smoke-flakes.py summarize
Parser checks: python3 docs/research/measure-smoke-flakes.py self-test

Uses the requested gh CLI for authenticated Actions history/log endpoints only.
After collect, run the enrich subcommand to retain final-failure and Scope evidence.
The cache is resumable; delete it to take a new snapshot. Errors are recorded,
never converted to passes. Keep the evidence JSON and table, not the cache.
"""
import argparse
import concurrent.futures
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
import hashlib
import gzip
import json
import math
import os
from pathlib import Path
import re
import statistics
import subprocess
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / '.smoke-flakes-cache'
EVIDENCE = ROOT / 'smoke-flakes-2026-10-evidence.json.gz'
TABLE = ROOT / 'smoke-flakes-2026-10-table.md'
REPO = 'hussainph/volli-code'
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
RESULT = re.compile(r'^\s*(PASS|FLAKY|FAIL)\s+(\S+\.mjs)\s+\((\d+(?:\.\d+)?)s\)\s*$')
STAMP = re.compile(r'^\d{4}-\d\d-\d\dT\S+Z ?')


def now():
    return datetime.now(timezone.utc).isoformat()


def gh(endpoint, raw=False):
    result = subprocess.run(['gh', 'api', endpoint, '--allow-escape-sequences'],
                            capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError(result.stderr.strip()[:500])
    return result.stdout if raw else json.loads(result.stdout)


def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = (json.dumps(value, separators=(',', ':'), ensure_ascii=False) + '\n').encode()
    path.write_bytes(gzip.compress(raw, mtime=0) if path.suffix == '.gz' else raw)


def load_evidence():
    return json.loads(gzip.decompress(EVIDENCE.read_bytes()))


def duration(start, end):
    if not start or not end:
        return None
    return (datetime.fromisoformat(end.replace('Z', '+00:00')) -
            datetime.fromisoformat(start.replace('Z', '+00:00'))).total_seconds()


def parse_log(log):
    observations, excerpts, headers = [], [], []
    lines = [STAMP.sub('', ANSI.sub('', line)).replace('##[group]', '::group::').replace('##[endgroup]', '::endgroup::')
             for line in log.splitlines()]
    failure = None
    for index, line in enumerate(lines):
        match = RESULT.match(line)
        if match:
            observations.append({'smoke': match[2], 'status': match[1],
                                 'seconds': float(match[3]), 'line': index + 1,
                                 'evidence': log.splitlines()[index]})
        if 'Running ' in line and 'smoke(s)' in line:
            headers.append(line)
        if '::group::FAILED ' in line:
            label = line.split('::group::FAILED ', 1)[1]
            # VC-522 now replays each attempt; keep filename identity separate
            # from the attempt/exit metadata while accepting historical groups.
            failure = {'smoke': label.split(' attempt ', 1)[0], 'line': index + 1, 'lines': []}
        elif failure is not None:
            if '::endgroup::' in line:
                body = '\n'.join(failure.pop('lines'))
                failure['excerpt_truncated'] = len(body) > 32000
                failure['excerpt'] = body if len(body) <= 32000 else body[:16000] + '\n[excerpt truncated]\n' + body[-16000:]
                excerpts.append(failure)
                failure = None
            else:
                failure['lines'].append(line)
        elif 'QUIET WINDOW CHECK FAILED' in line or 'smoke-quiet-check failed:' in line:
            excerpts.append({'kind': 'quiet-wrapper', 'line': index + 1, 'excerpt': line})
    if failure:
        body = '\n'.join(failure.pop('lines'))
        failure['excerpt_truncated'] = len(body) > 32000
        failure['excerpt'] = body if len(body) <= 32000 else body[:16000] + '\n[excerpt truncated]\n' + body[-16000:]
        excerpts.append(failure)
    # The final FLAKY/FAILED summaries deliberately do not match RESULT.
    assert len({x['smoke'] for x in observations}) == len(observations), 'duplicate smoke result in job'
    return observations, excerpts, headers


def mark_inherited(record):
    # GitHub's failed-jobs-only rerun clones successful jobs with NEW IDs and
    # attempt numbers but the original timestamps/logs. They are not executions.
    seen = {}
    for attempt in record['attempts']:
        for job in attempt['jobs']:
            key = (job['name'], job['started_at'], job['completed_at'])
            if job['started_at'] and job['completed_at'] and key in seen:
                job['inherited_from_attempt'] = seen[key]
            else:
                seen[key] = attempt['attempt']
    return record


def collect_run(run):
    path = CACHE / f"run-{run['id']}.json"
    if path.exists():
        return mark_inherited(json.loads(path.read_text()))
    record = {'run': run, 'attempts': [], 'collected_at': now()}
    for attempt in range(1, run['attempt'] + 1):
        entry = {'attempt': attempt, 'jobs': [], 'errors': []}
        try:
            page = gh(f"repos/{REPO}/actions/runs/{run['id']}/attempts/{attempt}/jobs?per_page=100")
            if page['total_count'] > 100:
                raise RuntimeError('more than 100 jobs: pagination required; refusing truncated census')
        except Exception as error:
            entry['errors'].append(str(error))
            record['attempts'].append(entry)
            continue
        for job in page['jobs']:
            item = {key: job.get(key) for key in ('id', 'name', 'conclusion', 'status', 'started_at', 'completed_at')}
            item['seconds'] = duration(item['started_at'], item['completed_at'])
            item['steps'] = [{key: step.get(key) for key in ('name', 'conclusion', 'status', 'started_at', 'completed_at')}
                             for step in job.get('steps', []) if 'smoke' in job['name'].lower()]
            if 'smoke' in job['name'].lower():
                item['observations'] = []
                if item['status'] == 'completed' and item['conclusion'] != 'skipped':
                    try:
                        log = gh(f"repos/{REPO}/actions/jobs/{job['id']}/logs", raw=True)
                        item['log_sha256'] = hashlib.sha256(log.encode()).hexdigest()
                        item['observations'], item['failure_excerpts'], item['runner_headers'] = parse_log(log)
                        item['log_lines'] = len(log.splitlines())
                    except Exception as error:
                        item['log_error'] = str(error)
                else:
                    item['log_censored'] = 'skipped or not completed at collection'
            entry['jobs'].append(item)
        record['attempts'].append(entry)
    mark_inherited(record)
    dump(path, record)
    return record


def collect(args):
    end = datetime.fromisoformat(args.end.replace('Z', '+00:00'))
    start = end - timedelta(days=args.days)
    manifest_path = CACHE / 'manifest.json'
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        if manifest['end'] != args.end or manifest['days'] != args.days:
            raise SystemExit('Existing cache has a different window; remove it explicitly before recollecting.')
    else:
        runs = []
        first_count = None
        for page in range(1, 11):
            query = urlencode({'created': f'{start.isoformat()}..{end.isoformat()}', 'per_page': 100, 'page': page})
            response = gh(f'repos/{REPO}/actions/workflows/ci.yml/runs?{query}')
            first_count = response['total_count'] if first_count is None else first_count
            if first_count > 1000:
                raise SystemExit('GitHub search cap exceeded; partition the date window before collecting.')
            for run in response['workflow_runs']:
                runs.append({'id': run['id'], 'created_at': run['created_at'], 'updated_at': run['updated_at'],
                             'event': run['event'], 'branch': run['head_branch'], 'sha': run['head_sha'],
                             'attempt': run['run_attempt'], 'status': run['status'], 'conclusion': run['conclusion'],
                             'title': run['display_title'], 'url': run['html_url'],
                             'prs': [pr['number'] for pr in run.get('pull_requests', [])]})
            if len(response['workflow_runs']) < 100:
                break
        if len({run['id'] for run in runs}) != first_count:
            raise SystemExit(f'Incomplete/unstable pagination: {len(runs)} returned vs {first_count} expected.')
        manifest = {'repo': REPO, 'workflow': 'ci.yml', 'start': start.isoformat(), 'end': args.end,
                    'days': args.days, 'listed_at': now(), 'api_total': first_count,
                    'excluded_events': dict(Counter(run['event'] for run in runs if
                                                   run['event'] not in ('push', 'pull_request'))),
                    'runs': [run for run in runs if run['event'] == 'pull_request' or
                             (run['event'] == 'push' and run['branch'] == 'main')]}
        dump(manifest_path, manifest)
    workers = max(1, min(4, int(os.environ.get('VOLLI_CONCURRENCY_HINT', '1'))))
    records = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(collect_run, run): run for run in manifest['runs']}
        for future in concurrent.futures.as_completed(futures):
            record = future.result()
            records.append(record)
            print(f"{len(records)}/{len(futures)} run {record['run']['id']} attempts={len(record['attempts'])}", flush=True)
    output = {key: value for key, value in manifest.items() if key != 'runs'}
    output.update({'collected_until': now(), 'records': sorted(records, key=lambda r: r['run']['created_at'])})
    dump(EVIDENCE, output)
    summarize()


def enrich():
    """Inspect final-failure output and exact run Scope logs; never infer unrelatedness."""
    data = load_evidence()
    records = [record for record in data['records'] if any(
        row['status'] == 'FAIL' for attempt in record['attempts']
        for job in attempt['jobs'] for row in job.get('observations', []))]

    def inspect(record):
        for attempt in record['attempts']:
            for job in attempt['jobs']:
                if any(row['status'] == 'FAIL' for row in job.get('observations', [])) and not job.get('failure_excerpts'):
                    log = gh(f"repos/{REPO}/actions/jobs/{job['id']}/logs", raw=True)
                    _, job['failure_excerpts'], _ = parse_log(log)
                if job['name'] == 'Scope' and attempt['attempt'] == 1:
                    log = gh(f"repos/{REPO}/actions/jobs/{job['id']}/logs", raw=True)
                    lines = [STAMP.sub('', ANSI.sub('', line)) for line in log.splitlines()]
                    paths, capturing = [], False
                    for line in lines:
                        if line == 'changed files:':
                            capturing = True
                        elif capturing and line.startswith('  '):
                            paths.append(line.strip())
                        elif capturing:
                            break
                    record['scope_diff'] = {'job_id': job['id'], 'paths': paths,
                                            'log_sha256': hashlib.sha256(log.encode()).hexdigest()}
        return record

    workers = max(1, min(4, int(os.environ.get('VOLLI_CONCURRENCY_HINT', '1'))))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for index, record in enumerate(pool.map(inspect, records), 1):
            print(f"inspected {index}/{len(records)} failure runs: {record['run']['id']}", flush=True)
    data['unrelated_diff_checks'] = [
        {'run_id': record['run']['id'], 'scope_job_id': record['scope_diff']['job_id'],
         'paths': record['scope_diff']['paths'],
         'decision': 'verified-unrelated-to-desktop-runtime',
         'reason': 'The exact Scope diff changes only the separate release workflow, not ci.yml, app code, probes, or dependencies.'}
        for record in records if record.get('scope_diff', {}).get('paths') == ['.github/workflows/release.yml']]
    data['enriched_at'] = now()
    dump(EVIDENCE, data)


def all_observations(data):
    for record in data['records']:
        mark_inherited(record)
        for attempt in record['attempts']:
            for job in attempt['jobs']:
                if job.get('inherited_from_attempt'):
                    continue
                for observation in job.get('observations', []):
                    yield {**observation, 'run_id': record['run']['id'], 'sha': record['run']['sha'],
                           'event': record['run']['event'], 'branch': record['run']['branch'],
                           'attempt': attempt['attempt'], 'job_id': job['id'], 'job': job['name']}


def percentile(values, fraction):
    values = sorted(values)
    return values[max(0, math.ceil(len(values) * fraction) - 1)]


def summarize():
    data = load_evidence()
    rows = list(all_observations(data))
    grouped = defaultdict(list)
    for row in rows:
        grouped[row['smoke']].append(row)
    unrelated = {check['run_id'] for check in data.get('unrelated_diff_checks', [])}
    table = ['| Smoke (`.mjs` omitted) | N (main/PR) | Initial N | PASS | Retry-green | Final FAIL | Same-run recovery | Initial retry/fail SHAs | Verified unrelated FAIL | Runtime median/p95 s |',
             '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
    recovery = []
    for smoke, values in sorted(grouped.items()):
        counts = Counter(row['status'] for row in values)
        n = len(values)
        initial = sum(row['attempt'] == 1 for row in values)
        recovered = 0
        for row in values:
            if row['status'] != 'FAIL':
                continue
            later = [x for x in values if x['run_id'] == row['run_id'] and x['attempt'] > row['attempt'] and x['status'] in ('PASS', 'FLAKY')]
            if later:
                recovered += 1
                recovery.append({'smoke': smoke, 'run_id': row['run_id'], 'sha': row['sha'],
                                 'failed_attempt': row['attempt'], 'passed_attempt': min(x['attempt'] for x in later)})
        bad_shas = len({row['sha'] for row in values if row['status'] in ('FAIL', 'FLAKY') and row['attempt'] == 1})
        main = sum(row['event'] == 'push' for row in values)
        times = [row['seconds'] for row in values]
        unrelated_count = sum(row['status'] == 'FAIL' and row['run_id'] in unrelated for row in values)
        table.append(f"| {smoke.removesuffix('.mjs')} | {n} ({main}/{n-main}) | {initial} | {counts['PASS']} | {counts['FLAKY']} | {counts['FAIL']} | {recovered} | {bad_shas} | {unrelated_count} | {statistics.median(times):.1f}/{percentile(times, .95):.1f} |")
    TABLE.write_text('\n'.join(table) + '\n')
    print(json.dumps({'runs': len(data['records']), 'attempts': sum(len(r['attempts']) for r in data['records']),
                      'observations': len(rows), 'smokes': len(grouped), 'status': dict(Counter(r['status'] for r in rows)),
                      'rerun_recoveries': recovery}, indent=2))


def self_test():
    log = ('2026-10-02T20:30:00.0000000Z   PASS  board-smoke.mjs (10.0s)\n'
           '2026-10-02T20:30:01.0000000Z   FLAKY  canvas-theming-smoke.mjs (25.2s)\n'
           '2026-10-02T20:30:02.0000000Z   FAIL  database-recovery-smoke.mjs (40.0s)\n'
           '2026-10-02T20:30:03.0000000Z ::group::FAILED database-recovery-smoke.mjs\n'
           '2026-10-02T20:30:03.0000000Z Error: quit timeout\n'
           '2026-10-02T20:30:04.0000000Z ::endgroup::\n'
           '2026-10-02T20:30:05.0000000Z FLAKY (passed on retry): canvas-theming-smoke.mjs\n')
    observations, excerpts, _ = parse_log(log)
    assert [x['status'] for x in observations] == ['PASS', 'FLAKY', 'FAIL']
    assert observations[1]['seconds'] == 25.2
    assert excerpts[0]['excerpt'] == 'Error: quit timeout'
    assert parse_log('FLAKY (passed on retry): board-smoke.mjs\nFAILED: board-smoke.mjs')[0] == []
    assert duration('2026-10-02T20:30:00Z', '2026-10-02T20:31:00Z') == 60
    assert parse_log(log.replace('::group::', '##[group]').replace('::endgroup::', '##[endgroup]'))[1] == excerpts
    assert STAMP.sub('', '2026-10-02T20:30:00.0000000Z   docs/research/example.md') == '  docs/research/example.md'
    job = {'name': 'Smoke (boot tier)', 'started_at': '2026-10-02T20:30:00Z', 'completed_at': '2026-10-02T20:31:00Z'}
    record = {'attempts': [{'attempt': 1, 'jobs': [dict(job)]}, {'attempt': 2, 'jobs': [dict(job)]}]}
    assert mark_inherited(record)['attempts'][1]['jobs'][0]['inherited_from_attempt'] == 1
    attempted = log.replace('::group::FAILED database-recovery-smoke.mjs',
                            '::group::FAILED database-recovery-smoke.mjs attempt 1 (exit 1)')
    assert parse_log(attempted)[1][0]['smoke'] == 'database-recovery-smoke.mjs'
    print('9 focused parser/duration/inherited-job assertions passed')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    collector = sub.add_parser('collect')
    collector.add_argument('--end', required=True)
    collector.add_argument('--days', type=int, default=14)
    sub.add_parser('summarize')
    sub.add_parser('enrich')
    sub.add_parser('self-test')
    args = parser.parse_args()
    if args.command == 'collect':
        collect(args)
    elif args.command == 'summarize':
        summarize()
    elif args.command == 'enrich':
        enrich()
    else:
        self_test()
