import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
/** Optional bounded disk cache. Source URLs and hashes stay in a local index. */
export class DiskResourceCache {
  constructor(directory, maximum = 256 * 1048576) {
    this.directory = resolve(directory);
    this.maximum = maximum;
    this.queue = Promise.resolve();
  }
  async index() {
    try {
      return JSON.parse(await readFile(join(this.directory, 'index.json'), 'utf8'));
    } catch {
      return {};
    }
  }
  async get(url) {
    await this.queue.catch(() => {});
    const entry = (await this.index())[url];
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256)) return;
    try {
      return {
        ...entry,
        bytes: new Uint8Array(await readFile(join(this.directory, entry.sha256))),
      };
    } catch {
      return;
    }
  }
  async blob(hash) {
    const entries = await this.index();
    const url = Object.keys(entries).find((k) => entries[k].sha256 === hash);
    return url ? this.get(url) : undefined;
  }
  put(url, entry) {
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        if (entry.bytes.length > this.maximum || !/^[a-f0-9]{64}$/.test(entry.sha256)) return;
        await mkdir(this.directory, { recursive: true });
        const entries = await this.index();
        const { bytes, ...metadata } = entry;
        const oldHash = entries[url]?.sha256;
        entries[url] = { ...metadata, size: bytes.length };
        await writeFile(join(this.directory, entry.sha256 + '.tmp'), bytes);
        await rename(
          join(this.directory, entry.sha256 + '.tmp'),
          join(this.directory, entry.sha256),
        );
        const removed = oldHash && oldHash !== entry.sha256 ? [oldHash] : [];
        while (
          Object.keys(entries).length > 512 ||
          Object.values(entries).reduce((n, e) => n + e.size, 0) > this.maximum
        ) {
          const key = Object.keys(entries).sort((a, b) => entries[a].saved - entries[b].saved)[0];
          removed.push(entries[key].sha256);
          delete entries[key];
        }
        await writeFile(join(this.directory, 'index.json.tmp'), JSON.stringify(entries));
        await rename(join(this.directory, 'index.json.tmp'), join(this.directory, 'index.json'));
        for (const hash of removed)
          if (/^[a-f0-9]{64}$/.test(hash) && !Object.values(entries).some((e) => e.sha256 === hash))
            await rm(join(this.directory, hash), { force: true });
      });
    this.queue = task;
    return task;
  }
}
