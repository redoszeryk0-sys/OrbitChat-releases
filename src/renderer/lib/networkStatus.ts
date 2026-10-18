export function playitStatusLabel(configured: boolean, reachable: boolean | null, agentRunningOnThisPc: boolean, agentLocation: 'this-pc' | 'unknown' = 'this-pc'): string {
  if (!configured) return 'Not configured';
  if (reachable === true) return 'Public tunnel reachable';
  if (reachable === null) return 'Public tunnel not checked';
  if (agentLocation === 'unknown') return 'Public tunnel not verified · agent status unknown on this PC';
  return agentRunningOnThisPc
    ? 'Public tunnel not verified · agent running on this PC'
    : 'Public tunnel not verified · agent not detected on this PC';
}