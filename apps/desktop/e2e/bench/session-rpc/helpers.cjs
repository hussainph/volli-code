function argument(name, argv = process.argv) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function parsePositiveInteger(name, fallback, argv = process.argv) {
  const raw = argument(name, argv);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function percentile(values, fraction) {
  if (values.length === 0) throw new Error("Cannot summarize an empty benchmark");
  const ordered = values.toSorted((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))];
}

function distribution(values) {
  if (values.length === 0) throw new Error("Cannot summarize an empty benchmark");
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

module.exports = { argument, parsePositiveInteger, percentile, distribution };
