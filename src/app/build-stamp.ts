/**
 * Which build of this application is running.
 *
 * Written into the page by scripts/stamp-build.mjs, so it travels with the
 * bundle it describes rather than being fetched separately and possibly
 * describing a different deployment.
 *
 * A development server carries no stamp, and that is reported as such instead
 * of being filled in with a guess.
 */
export interface BuildStamp {
  commit: string;
  shortCommit: string;
  repository: string;
  builtAt: string;
  /** The tree had uncommitted changes, so the commit is not the whole story. */
  modified: boolean;
  /** Where this exact build's source can be read. */
  commitUrl: string;
}

const COMMIT = /^[0-9a-f]{40}$/;

function meta(document: Document, name: string): string {
  return document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content?.trim() ?? '';
}

/** Reads the stamp, or null when this copy was not stamped. */
export function buildStamp(document = globalThis.document): BuildStamp | null {
  if (!document?.querySelector) return null;
  const commit = meta(document, 'build-commit');
  if (!COMMIT.test(commit)) return null;
  // Only a real repository URL becomes a link; anything else is shown as bare
  // text rather than turned into a link somewhere unexpected.
  let repository = meta(document, 'build-repository');
  try {
    const url = new URL(repository);
    if (url.protocol !== 'https:' || url.username || url.password) repository = '';
    else repository = url.href.replace(/\/$/, '');
  } catch {
    repository = '';
  }
  return {
    commit,
    shortCommit: commit.slice(0, 7),
    repository,
    builtAt: meta(document, 'build-time'),
    modified: meta(document, 'build-modified') === 'true',
    commitUrl: repository ? `${repository}/commit/${commit}` : '',
  };
}
