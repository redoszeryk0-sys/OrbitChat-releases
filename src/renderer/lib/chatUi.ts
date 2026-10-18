export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export function isNearLatest(metrics: ScrollMetrics, threshold = 100): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < threshold;
}

export interface AudioDeviceIdentity {
  kind: string;
  deviceId: string;
}

export function uniqueSelectableAudioDevices<T extends AudioDeviceIdentity>(devices: readonly T[]): T[] {
  const seen = new Set<string>();
  return devices.filter((device) => {
    if ((device.kind !== 'audioinput' && device.kind !== 'audiooutput') || !device.deviceId || device.deviceId === 'default') return false;
    const key = `${device.kind}:${device.deviceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function shouldSendComposerOnEnter(key: string, shiftKey: boolean, isComposing: boolean): boolean {
  return key === 'Enter' && !shiftKey && !isComposing;
}
