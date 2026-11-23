/** A compact D1 must never silently refill because a misspelled setting fell
 * back to the default. The initial rollout deliberately keeps full D1 text. */
export function retainD1Text(value: string | undefined, hasTextBucket: boolean): boolean {
  if (value !== undefined && value !== 'true' && value !== 'false') throw new Error('CORPUS_RETAIN_D1_TEXT must be true or false');
  const retain = value !== 'false';
  if (!retain && !hasTextBucket) throw new Error('CORPUS_RETAIN_D1_TEXT=false requires the CORPUS R2 text binding');
  return retain;
}
