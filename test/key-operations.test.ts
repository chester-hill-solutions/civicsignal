import { describe, expect, it } from 'vitest';
import { authenticateRequest } from '../src/access';
import { prepareKeyRevocation, prepareWorkspaceKey } from '../src/key-operations';
import { testD1 } from './helpers/d1';

describe('reviewable CHS key operations', () => {
  it('issues and rotates keys without resetting the workspace or accepting revoked secrets', async () => {
    const fixture = testD1();
    try {
      fixture.sqlite.exec("INSERT INTO workspace(id) VALUES('kept'); INSERT INTO civic_workspace_billing(workspace_id,plan,fuse_limit,fuse_soft_warn,enabled) VALUES('kept','free',5,0,1)");
      const first = prepareWorkspaceKey('kept', 'First key');
      expect(first.sql).not.toContain(first.rawKey);
      fixture.sqlite.exec(first.sql);
      const authenticate = (raw: string) => authenticateRequest({ CIVIC_DB: fixture.db }, new Request('https://example.test', {
        headers: { Authorization: `Bearer ${raw}` },
      }));
      expect((await authenticate(first.rawKey)).customer.id).toBe('kept');
      const replacement = prepareWorkspaceKey('kept', 'Replacement');
      fixture.sqlite.exec(replacement.sql);
      expect((await authenticate(replacement.rawKey)).customer.fuseLimit).toBe(5);
      fixture.sqlite.exec(prepareKeyRevocation('another-workspace', first.id));
      expect((await authenticate(first.rawKey)).actor.keyId).toBe(first.id);
      fixture.sqlite.exec(prepareKeyRevocation('kept', first.id));
      await expect(authenticate(first.rawKey)).rejects.toMatchObject({ code: 'KEY_INVALID' });
      expect((await authenticate(replacement.rawKey)).customer.id).toBe('kept');
    } finally { fixture.close(); }
  });
});
