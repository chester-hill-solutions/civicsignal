import { describe, expect, it } from 'vitest';
import { pipelineIntervalMilliseconds } from '../scripts/lib/pipeline-interval';

describe('pipeline polling configuration', () => {
  it('waits six hours for the deployed 21600-second setting', () => {
    expect(pipelineIntervalMilliseconds('21600')).toBe(6 * 60 * 60 * 1000);
    expect(pipelineIntervalMilliseconds()).toBe(6 * 60 * 60 * 1000);
  });

  it('supports a subsecond interval without losing the unit conversion', () => {
    expect(pipelineIntervalMilliseconds('0.5')).toBe(500);
  });

  it.each(['', ' ', '0', '-1', 'NaN', 'Infinity', '2160000000'])('rejects %j instead of running a tight loop', (value) => {
    expect(() => pipelineIntervalMilliseconds(value)).toThrow('PIPELINE_INTERVAL_SECONDS');
  });
});
