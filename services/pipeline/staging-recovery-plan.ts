/** Fixed local candidate. Deployment/initialization requires separate explicit user approval. */
export const STAGE_RECOVERY_PLAN = Object.freeze({
  "format": 1,
  "id": "v1-stage-recovery-20261023-1112-to-1752",
  "accountId": "ad5ec479b9a421faa2ed06c3d1c2b23a",
  "worker": "civicsignal-v1-stage-pipeline-20261022",
  "namespaceId": "751026e8a12f46dc87f829d44cef4221",
  "coordinatorId": "5f57efc844823b53825d844574680ed1be6d0c372a32db23482639a321ca9504",
  "corpusId": "statutes-canada",
  "commit": "0507465393c224c0491fc8c17c88340217acc656",
  "date": "2026-10-15",
  "parser": "statutes-v2",
  "initialAdmissionRevision": 1,
  "originalCap": 1112,
  "originalSubmitted": 1112,
  "totalCap": 1752,
  "maxCalls": 20,
  "maxDocumentsPerCall": 32,
  "indexDigest": "b9b9ad97092ae2c5b4a35580f0cafe73"
});
/** SHA-256 of compact JSON.stringify(STAGE_RECOVERY_PLAN), in the declared key order. */
export const STAGE_RECOVERY_PLAN_SHA256 = '26b6b13a511ac3f55e07bffc08686f8997addc88425838564bbf789d256e5b13';
export interface StageRecoveryAuthorization { coordinatorId: string; mode: 'extend' | 'verify' }
export interface StageRecoveryReceipt { plan: typeof STAGE_RECOVERY_PLAN; planSha256: string; reservedCalls: number }

export function readRecoveryReceipt(value: unknown, submitted: number): StageRecoveryReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'plan,planSha256,reservedCalls' ||
      !('planSha256' in value) || value.planSha256 !== STAGE_RECOVERY_PLAN_SHA256 ||
      !('plan' in value) || !value.plan || typeof value.plan !== 'object' || Array.isArray(value.plan) ||
      Object.keys(value.plan).length !== Object.keys(STAGE_RECOVERY_PLAN).length ||
      Object.entries(STAGE_RECOVERY_PLAN).some(([key, expected]) => Reflect.get(value.plan!, key) !== expected) ||
      !('reservedCalls' in value) || typeof value.reservedCalls !== 'number' ||
      !Number.isSafeInteger(value.reservedCalls) || value.reservedCalls < 0 || value.reservedCalls > STAGE_RECOVERY_PLAN.maxCalls ||
      submitted - STAGE_RECOVERY_PLAN.originalSubmitted < value.reservedCalls ||
      submitted - STAGE_RECOVERY_PLAN.originalSubmitted > value.reservedCalls * STAGE_RECOVERY_PLAN.maxDocumentsPerCall) {
    throw new Error('Invalid authorized staging recovery receipt or counters.');
  }
  return { plan: STAGE_RECOVERY_PLAN, planSha256: STAGE_RECOVERY_PLAN_SHA256, reservedCalls: value.reservedCalls };
}
