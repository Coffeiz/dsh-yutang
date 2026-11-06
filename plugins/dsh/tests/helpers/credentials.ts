import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials';

export class MemoryCredentials {
  private readonly records = new Map<CredentialKey, CredentialRecord>();

  async readRecord(key: CredentialKey) { return this.records.get(key); }
  async modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
    const next = await mutate(this.records.get(key));
    if (next) this.records.set(key, next);
    return next;
  }
  async deleteRecord(key: CredentialKey) { this.records.delete(key); }
  allRecords() { return [...this.records.values()]; }
}

export const asCredentialProvider = (credentials = new MemoryCredentials()) => credentials as unknown as CredentialProvider;
