import { asCapabilityId, requireActorCapability, type ApiKeyAuthorizationActor } from '@chester-hill-solutions/auth';
import { verifyApiKey } from '@chester-hill-solutions/auth-d1';
import type { MeteredCustomer } from '@chester-hill-solutions/api-billing';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { Env } from './types';

export const RETRIEVE_CAPABILITY = asCapabilityId('civicsignal.retrieve');

// The product owns its plan. CHS auth owns workspace and key identity.
export const workspaceBilling = sqliteTable('civic_workspace_billing', {
  workspaceId: text('workspace_id').primaryKey(),
  plan: text('plan', { enum: ['free', 'metered', 'enterprise'] }).notNull(),
  fuseLimit: integer('fuse_limit').notNull(),
  fuseSoftWarn: integer('fuse_soft_warn', { mode: 'boolean' }).notNull(),
  stripeCustomerId: text('stripe_customer_id'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
});

export interface RetrievalIdentity {
  actor: ApiKeyAuthorizationActor;
  customer: MeteredCustomer;
}

export class AccessError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = 'AccessError';
  }
}

export async function authenticateRequest(env: Env, request: Request): Promise<RetrievalIdentity> {
  const authorization = request.headers.get('Authorization');
  if (!authorization) throw new AccessError('KEY_REQUIRED', 'A Bearer API key is required.', 401);
  const secret = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
  if (!secret) throw new AccessError('KEY_INVALID', 'The authorization header is invalid.', 401);
  if (secret.startsWith('pk_')) {
    throw new AccessError('WRONG_KEY_KIND', 'A public browser key cannot authorize this route.', 403);
  }
  if (!env.CIVIC_DB) throw new AccessError('AUTH_UNAVAILABLE', 'Authorization is unavailable.', 503);

  const db = drizzle(env.CIVIC_DB);
  const actor = await verifyApiKey(db, secret).catch(() => {
    throw new AccessError('AUTH_UNAVAILABLE', 'Authorization is unavailable.', 503);
  });
  if (!actor) throw new AccessError('KEY_INVALID', 'The API key is unknown or revoked.', 401);
  try {
    requireActorCapability(actor, RETRIEVE_CAPABILITY);
  } catch {
    throw new AccessError('CAPABILITY_REQUIRED', 'The key does not permit corpus retrieval.', 403);
  }
  const [profile] = await db.select().from(workspaceBilling)
    .where(eq(workspaceBilling.workspaceId, actor.workspaceId)).limit(1).catch(() => {
      throw new AccessError('AUTH_UNAVAILABLE', 'Authorization is unavailable.', 503);
    });
  if (!profile || !profile.enabled) {
    throw new AccessError('WORKSPACE_DISABLED', 'The workspace is unavailable.', 403);
  }
  return {
    actor,
    customer: {
      id: actor.workspaceId,
      plan: profile.plan,
      fuseLimit: profile.fuseLimit,
      fuseSoftWarn: profile.fuseSoftWarn,
      stripeCustomerId: profile.stripeCustomerId ?? undefined,
    },
  };
}
