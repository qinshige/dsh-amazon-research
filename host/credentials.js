import { join } from 'node:path';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';

/** 每个数据源的凭证引用（POSIX 环境变量名） */
export const CREDENTIAL_REFS = {
  sellersprite: 'SELLERSPRITE_SECRET_KEY',
  sorftime: 'SORFTIME_MCP_KEY',
  sif: 'SIF_SECRET_KEY',
  xiyou: 'XIYOU_API_KEY',
};

/**
 * 凭证读写：优先宿主 ctx.credentials，其次环境变量，最后插件数据目录 secrets.json（0600）。
 * 任何情况下都不把密钥写进 config.json、日志或报告。
 */
export class Secrets {
  constructor(ctx, dataDir) {
    this.ctx = ctx;
    this.dataDir = dataDir;
    this.file = join(dataDir, 'secrets.json');
    this._credentials = null;
    this._probed = false;
  }

  _cred() {
    if (this._probed) return this._credentials;
    this._probed = true;
    try {
      const svc = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('credentials') : null;
      this._credentials = svc || null;
    } catch {
      this._credentials = null;
    }
    return this._credentials;
  }

  async _fileAll() {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  async _fileSet(provider, value) {
    const all = await this._fileAll();
    if (value === null) delete all[provider];
    else all[provider] = value;
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.file, JSON.stringify(all, null, 2) + '\n', 'utf8');
    await chmod(this.file, 0o600);
  }

  /** @returns {Promise<{value:string, source:'credentials'|'env'|'file'}|null>} */
  async get(provider) {
    const ref = CREDENTIAL_REFS[provider];
    if (!ref) return null;
    const cred = this._cred();
    if (cred && typeof cred.resolve === 'function') {
      try {
        const hit = await cred.resolve(ref);
        const value = hit && typeof hit.value === 'string' ? hit.value.trim() : '';
        if (value) return { value, source: 'credentials' };
      } catch {
        /* 凭证服务异常时回退环境变量 */
      }
    }
    const envValue = (process.env[ref] || '').trim();
    if (envValue) return { value: envValue, source: 'env' };
    const fileValue = (await this._fileAll())[provider];
    if (typeof fileValue === 'string' && fileValue.trim()) return { value: fileValue.trim(), source: 'file' };
    return null;
  }

  /** 保存密钥：优先宿主凭证服务；不可用时写本地 secrets.json */
  async set(provider, key) {
    const ref = CREDENTIAL_REFS[provider];
    if (!ref) throw new Error('未知数据源: ' + provider);
    const value = String(key || '').trim();
    if (!value) throw new Error('密钥不能为空');
    const cred = this._cred();
    if (cred && typeof cred.set === 'function') {
      try {
        await cred.set(ref, value);
        return { ok: true, source: 'credentials' };
      } catch {
        /* 回退本地文件 */
      }
    }
    await this._fileSet(provider, value);
    return { ok: true, source: 'file' };
  }

  async clear(provider) {
    const ref = CREDENTIAL_REFS[provider];
    const cred = this._cred();
    if (cred && ref && typeof cred.unset === 'function') {
      try {
        await cred.unset(ref);
      } catch {
        /* 忽略 */
      }
    }
    await this._fileSet(provider, null);
    return { ok: true };
  }

  async describe(provider) {
    const hit = await this.get(provider);
    return { configured: Boolean(hit), source: hit ? hit.source : null };
  }
}
