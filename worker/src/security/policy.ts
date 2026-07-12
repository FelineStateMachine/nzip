export interface WindowStats {
  bucket: number;
  addresses: number;
  scanners: number;
  misses: number;
  liveHits: number;
  rateLimited: number;
  topScannerAddresses: number;
  longestSequence: number;
  vaultMask: number;
  countries: string[];
  asns: number[];
}

export interface IncidentRow {
  status: "open" | "closed";
  severity: number;
  opened_at: number;
  last_seen_at: number;
  last_alerted_at: number;
  quiet_windows: number;
  peak_addresses: number;
  total_addresses: number;
  total_live_hits: number;
  total_rate_limited: number;
  vault_mask: number;
}

export type AlertAction = "open" | "escalate" | "summary" | "resolve" | null;

export function signalSeverity(
  stats: WindowStats,
  incidentOpen = false,
): number {
  const distributed = stats.addresses >= 128 && stats.scanners >= 10 &&
    (stats.addresses === 0 || stats.misses / stats.addresses >= 0.9);
  const scannerSweep = stats.topScannerAddresses >= 20;
  const suspiciousLiveHit = stats.liveHits > 0 &&
    (incidentOpen || stats.topScannerAddresses >= 8 ||
      stats.longestSequence >= 8);
  if (stats.rateLimited > 0 || suspiciousLiveHit) return 2;
  if (scannerSweep || distributed) return 1;
  return 0;
}

export function chooseAlertAction(
  incident: IncidentRow | null,
  stats: WindowStats,
  now: number,
): AlertAction {
  const severity = signalSeverity(stats, incident?.status === "open");
  if (!incident || incident.status === "closed") {
    return severity > 0 ? "open" : null;
  }
  if (severity === 0) return incident.quiet_windows >= 2 ? "resolve" : null;
  if (
    severity > incident.severity ||
    stats.addresses >= Math.max(20, incident.peak_addresses * 2) ||
    (stats.liveHits > 0 && incident.total_live_hits === 0)
  ) return "escalate";
  const reachedNewVault = (stats.vaultMask & ~incident.vault_mask) !== 0;
  if (reachedNewVault && now - incident.last_alerted_at >= 1800) {
    return "escalate";
  }
  if (now - incident.last_alerted_at >= 3600) return "summary";
  return null;
}

export function longestAdjacentRun(addresses: number[]): number {
  if (addresses.length === 0) return 0;
  const sorted = [...new Set(addresses)].sort((a, b) => a - b);
  let longest = 1;
  let current = 1;
  for (let i = 1; i < sorted.length; i++) {
    current = sorted[i] === sorted[i - 1] + 1 ? current + 1 : 1;
    longest = Math.max(longest, current);
  }
  return longest;
}
