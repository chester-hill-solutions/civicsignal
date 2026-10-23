/** Convert the service's seconds setting to a valid JavaScript timer delay. */
export function pipelineIntervalMilliseconds(seconds = '21600'): number {
  const milliseconds = Number(seconds) * 1000;
  // Node and Bun timers clamp overflowing/invalid delays to approximately 1 ms.
  // Refuse these settings rather than accidentally busy-looping ingestion.
  if (!seconds.trim() || !Number.isFinite(milliseconds) || milliseconds < 1 || milliseconds > 2_147_483_647) {
    throw new Error('PIPELINE_INTERVAL_SECONDS must be positive and fit a 32-bit millisecond timer');
  }
  return milliseconds;
}
