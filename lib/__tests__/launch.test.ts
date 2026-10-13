import { afterEach, describe, expect, it, vi } from 'vitest';
import { onLaunchFiles, takeSharedFiles } from '@/lib/launch';

afterEach(() => vi.unstubAllGlobals());

function fakeCaches(entries: [string, Response][]) {
  const store = new Map(entries);
  const inbox = {
    keys: async () => [...store.keys()].map((url) => new Request(`http://x${url}`)),
    match: async (req: Request) => store.get(new URL(req.url).pathname)?.clone(),
    delete: async (req: Request) => store.delete(new URL(req.url).pathname),
  };
  const deleted: string[] = [];
  vi.stubGlobal('caches', {
    open: async () => inbox,
    delete: async (name: string) => deleted.push(name),
  });
  return { store, deleted };
}

const entry = (body: string, name: string, type: string): Response =>
  new Response(body, {
    headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name) },
  });

describe('takeSharedFiles', () => {
  it('returns the inbox oldest first, with names, and empties it', async () => {
    const { store, deleted } = fakeCaches([
      ['/share-inbox/' + (Date.now() - 1_000) + '-1', entry('b', 'b é.png', 'image/png')],
      ['/share-inbox/' + (Date.now() - 2_000) + '-0', entry('a', 'a.csv', 'text/csv')],
    ]);
    const files = await takeSharedFiles();
    expect(files.map((f) => [f.name, f.type])).toEqual([
      ['a.csv', 'text/csv'],
      ['b é.png', 'image/png'],
    ]);
    expect(store.size).toBe(0);
    expect(deleted).toEqual(['share-inbox']);
  });

  it('names shared text for what it is', async () => {
    fakeCaches([
      ['/share-inbox/' + Date.now() + '-0', entry('x\ty\n1\t2', 'shared.txt', 'text/plain')],
    ]);
    expect((await takeSharedFiles())[0].name).toBe('shared.tsv');
  });

  it('discards a share abandoned beyond the 15-minute TTL', async () => {
    const { store } = fakeCaches([
      [
        '/share-inbox/' + (Date.now() - 16 * 60_000) + '-0',
        entry('sensitive', 'id.pdf', 'application/pdf'),
      ],
    ]);
    expect(await takeSharedFiles()).toEqual([]);
    expect(store.size).toBe(0);
  });

  it('no Cache API, nothing shared', async () => {
    vi.stubGlobal('caches', undefined);
    expect(await takeSharedFiles()).toEqual([]);
  });
});

describe('onLaunchFiles', () => {
  it('hands over the files of an "Open with" launch', async () => {
    let consumer: ((params: unknown) => Promise<void>) | undefined;
    vi.stubGlobal('launchQueue', { setConsumer: (c: typeof consumer) => (consumer = c) });
    const receive = vi.fn();
    onLaunchFiles(receive);
    const file = new File(['x'], 'a.png');
    await consumer!({ files: [{ getFile: async () => file }] });
    await consumer!({ files: [] });
    expect(receive).toHaveBeenCalledOnce();
    expect(receive).toHaveBeenCalledWith([file]);
  });

  it('does nothing where launchQueue is missing', () => {
    expect(() => onLaunchFiles(vi.fn())).not.toThrow();
  });
});
