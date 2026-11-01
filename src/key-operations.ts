import { generateOpaqueToken, hashOpaqueToken } from '@chester-hill-solutions/auth';
import { RETRIEVE_CAPABILITY } from './access';

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
const validId = (value: string) => {
  if (!value.trim() || value.length > 200) throw new Error('An identity must contain 1 to 200 characters.');
  return value;
};

/** Prepare a CHS-compatible key. The reviewed SQL contains only its hash. */
export function prepareWorkspaceKey(workspaceId: string, name: string) {
  validId(workspaceId);
  if (!name.trim() || name.length > 200) throw new Error('The key name must contain 1 to 200 characters.');
  const rawKey = `sk_live_${generateOpaqueToken()}`;
  const id = `wak_${crypto.randomUUID()}`;
  const now = Date.now();
  const values = [id, workspaceId, name.trim(), hashOpaqueToken(rawKey), rawKey.slice(0, 16),
    JSON.stringify([RETRIEVE_CAPABILITY]), 'active'].map(literal).join(',');
  return { rawKey, id, workspaceId, sql: `INSERT INTO workspace_api_key
    (id,workspace_id,name,key_hash,display_prefix,capabilities,status,created_at,updated_at)
    VALUES(${values},${now},${now});\n` };
}

/** Scope revocation to its workspace. A revoked key cannot be reactivated here. */
export function prepareKeyRevocation(workspaceId: string, keyId: string): string {
  return `UPDATE workspace_api_key SET status='revoked',updated_at=${Date.now()}
    WHERE id=${literal(validId(keyId))} AND workspace_id=${literal(validId(workspaceId))} AND status='active';\n`;
}
