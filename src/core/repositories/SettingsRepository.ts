import { BaseRepository, type Row } from '../database/repository';

export class SettingsRepository extends BaseRepository {
  constructor() {
    super('settings');
  }

  get(key: string): string | null {
    const row = this.rawOne("SELECT value FROM settings WHERE key = ? AND deleted_at IS NULL", key) as
      { value: string | null } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    const existing = this.rawOne("SELECT id FROM settings WHERE key = ?", key) as { id: number } | undefined;
    if (existing) {
      this.update(existing.id, { value });
    } else {
      this.create({ key, value, uuid: crypto.randomUUID(), comment: '' });
    }
  }

  getBool(key: string, defaultVal = false): boolean {
    const v = this.get(key);
    return v !== null ? v === '1' : defaultVal;
  }
}

export const settingsRepository = new SettingsRepository();
