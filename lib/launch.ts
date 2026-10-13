// Files that arrive from the OS rather than a drop or the picker, once the
// app is installed: "Open with" (manifest file_handlers, delivered through
// launchQueue) and the share sheet (manifest share_target, POSTed to the
// service worker, which leaves them in the share inbox; see
// scripts/sw-template.js).

import { pastedTextKind } from './paste';

const SHARE_INBOX = 'share-inbox';
const SHARE_TTL_MS = 15 * 60 * 1000;

interface LaunchParams {
  files?: { getFile(): Promise<File> }[];
}
interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void;
}

/** Empties the share inbox, returning what was in it, oldest first. */
export async function takeSharedFiles(): Promise<File[]> {
  if (typeof caches === 'undefined') return [];
  const inbox = await caches.open(SHARE_INBOX);
  const requests = [...(await inbox.keys())].sort((a, b) =>
    a.url.localeCompare(b.url, 'en', { numeric: true }),
  );
  const files: File[] = [];
  for (const request of requests) {
    const id = new URL(request.url).pathname.split('/').pop() ?? '';
    const created = Number(id.split('-')[0]);
    // A crashed or abandoned share must not remain as sensitive cached data.
    const expired =
      !Number.isFinite(created) || created <= 0 || Date.now() - created > SHARE_TTL_MS;
    const response = expired ? null : await inbox.match(request);
    await inbox.delete(request);
    if (!response) continue;
    const blob = await response.blob();
    let name = decodeURIComponent(response.headers.get('x-file-name') ?? 'shared');
    if (name === 'shared.txt') {
      // Shared text is named for what it is, as a paste would be.
      name = `shared.${pastedTextKind(await blob.text(), '')}`;
    }
    files.push(new File([blob], name, { type: blob.type }));
  }
  await caches.delete(SHARE_INBOX);
  return files;
}

/** Calls back with the files of each "Open with" launch. */
export function onLaunchFiles(receive: (files: File[]) => void): void {
  const queue = (globalThis as { launchQueue?: LaunchQueue }).launchQueue;
  queue?.setConsumer(async (params) => {
    if (!params.files?.length) return;
    receive(await Promise.all(params.files.map((handle) => handle.getFile())));
  });
}
