import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { DestinationConfig } from '../src/backup/model.js';
import { probeDestination } from '../src/backup/s3.js';

interface MockOptions {
  createStatus: number;
  listStatus: number;
  allowPrefix: string;
}

interface MockServer {
  endpoint: string;
  requests: string[];
  objects: Map<string, Buffer>;
  close: () => Promise<void>;
}

const open: MockServer[] = [];

afterEach(async () => {
  const servers = open.splice(0);
  await Promise.all(servers.map((server) => server.close()));
});

function destination(endpoint: string, prefix: string): DestinationConfig {
  return {
    preset: 'custom',
    endpoint,
    region: 'us-east-1',
    pathStyle: true,
    bucket: 'qijuan-backups',
    prefix,
    accessKeyId: 'backup-access-key',
    secretAccessKey: 'aws-secret-key-value',
  };
}

function startS3(options: MockOptions): Promise<MockServer> {
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const method = request.method ?? 'GET';
      requests.push(`${method} ${request.url ?? '/'} md5=${request.headers['content-md5'] ? 'yes' : 'no'}`);
      const pathname = decodeURIComponent(url.pathname);
      const match = /^\/([^/]+)(?:\/(.*))?$/.exec(pathname);
      const key = match?.[2] ?? '';
      if (!key && method === 'PUT') {
        response.statusCode = options.createStatus;
        if (options.createStatus === 200) {
          response.end();
          return;
        }
        const code = options.createStatus === 409 ? 'BucketAlreadyOwnedByYou' : 'AccessDenied';
        response.end(`<Error><Code>${code}</Code><Message>create denied</Message></Error>`);
        return;
      }
      if (!key && method === 'GET') {
        // The bucket-existence check is the only list that sends max-keys.
        // Later probe lists must still return the objects that were written.
        if (url.searchParams.has('max-keys') && options.listStatus !== 200) {
          response.statusCode = options.listStatus;
          response.end('<Error><Code>AccessDenied</Code><Message>cannot list</Message></Error>');
          return;
        }
        const prefix = url.searchParams.get('prefix') ?? '';
        const listed = [...objects.keys()].filter((name) => name.startsWith(prefix));
        const xml = listed.map((name) => `<Contents><Key>${name}</Key></Contents>`).join('');
        response.end(`<ListBucketResult>${xml}</ListBucketResult>`);
        return;
      }
      if (key && options.allowPrefix && !key.startsWith(options.allowPrefix)) {
        response.statusCode = 403;
        response.end('<Error><Code>AccessDenied</Code><Message>outside prefix</Message></Error>');
        return;
      }
      if (method === 'POST' && url.searchParams.has('uploads')) {
        const id = `upload-${uploads.size + 1}`;
        uploads.set(id, { key, parts: new Map() });
        response.end(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
        return;
      }
      if (method === 'PUT' && url.searchParams.has('partNumber')) {
        const upload = uploads.get(url.searchParams.get('uploadId') ?? '');
        if (!upload) {
          response.statusCode = 404;
          response.end();
          return;
        }
        upload.parts.set(Number(url.searchParams.get('partNumber')), body);
        response.setHeader('ETag', '"probe-etag"');
        response.statusCode = 200;
        response.end();
        return;
      }
      if (method === 'POST' && url.searchParams.has('uploadId')) {
        const id = url.searchParams.get('uploadId') ?? '';
        const upload = uploads.get(id);
        if (!upload) {
          response.statusCode = 404;
          response.end();
          return;
        }
        objects.set(upload.key, upload.parts.get(1) ?? Buffer.alloc(0));
        uploads.delete(id);
        response.end('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>');
        return;
      }
      if (method === 'PUT') {
        objects.set(key, body);
        response.statusCode = 200;
        response.end();
        return;
      }
      if (method === 'HEAD') {
        response.statusCode = objects.has(key) ? 200 : 404;
        response.end();
        return;
      }
      if (method === 'GET') {
        const stored = objects.get(key);
        if (!stored) {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.statusCode = 200;
        response.end(stored);
        return;
      }
      if (method === 'DELETE') {
        objects.delete(key);
        response.statusCode = 204;
        response.end();
        return;
      }
      response.statusCode = 405;
      response.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      const mock: MockServer = {
        endpoint: `http://127.0.0.1:${address.port}`,
        requests,
        objects,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      };
      open.push(mock);
      resolve(mock);
    });
  });
}

describe('S3 connection probe', () => {
  it('writes under the prefix when creating the bucket is denied', async () => {
    const mock = await startS3({
      createStatus: 403,
      listStatus: 200,
      allowPrefix: 'library/nested/qijuan-connection-probe/',
    });
    await probeDestination(destination(mock.endpoint, 'library/nested'));
    expect(mock.objects.size).toBe(0);
    expect(mock.requests.some((line) => line.startsWith('PUT /qijuan-backups md5='))).toBe(true);
    expect(mock.requests.some((line) => line.includes('max-keys=1') && line.includes('prefix=library%2Fnested%2F'))).toBe(
      true,
    );
    const writes = mock.requests.filter((line) => line.includes('/qijuan-backups/library/nested/qijuan-connection-probe/'));
    expect(writes.some((line) => line.startsWith('PUT ') && line.includes('md5=yes'))).toBe(true);
    expect(writes.some((line) => line.startsWith('HEAD '))).toBe(true);
    expect(writes.some((line) => line.startsWith('GET '))).toBe(true);
    expect(writes.some((line) => line.startsWith('POST ') && line.includes('uploads='))).toBe(true);
    expect(writes.some((line) => line.startsWith('DELETE '))).toBe(true);
    expect(mock.requests.some((line) => /\/qijuan-backups\/qijuan-connection-probe/.test(line))).toBe(false);
  });

  it('treats an existing bucket as reachable when it can be listed', async () => {
    const mock = await startS3({
      createStatus: 409,
      listStatus: 200,
      allowPrefix: 'library/qijuan-connection-probe/',
    });
    await probeDestination(destination(mock.endpoint, 'library'));
    expect(mock.objects.size).toBe(0);
    expect(mock.requests.some((line) => line.startsWith('DELETE /qijuan-backups/library/qijuan-connection-probe/'))).toBe(
      true,
    );
  });

  it('does not require a bucket list when the bucket was just created', async () => {
    const mock = await startS3({
      createStatus: 200,
      listStatus: 403,
      allowPrefix: 'qijuan-connection-probe/',
    });
    await probeDestination(destination(mock.endpoint, ''));
    expect(mock.objects.size).toBe(0);
    expect(mock.requests.some((line) => line.includes('max-keys=1'))).toBe(false);
    expect(mock.requests.some((line) => line.startsWith('PUT /qijuan-backups/qijuan-connection-probe/') && line.includes('md5=yes'))).toBe(
      true,
    );
  });

  it('fails when the bucket cannot be created or listed', async () => {
    const mock = await startS3({
      createStatus: 403,
      listStatus: 403,
      allowPrefix: 'library/qijuan-connection-probe/',
    });
    await expect(probeDestination(destination(mock.endpoint, 'library'))).rejects.toThrow(/list the bucket/);
    expect(mock.objects.size).toBe(0);
    expect(mock.requests.some((line) => line.includes('qijuan-connection-probe'))).toBe(false);
  });

  it('does not probe objects when bucket creation fails for another reason', async () => {
    const mock = await startS3({
      createStatus: 400,
      listStatus: 200,
      allowPrefix: 'library/qijuan-connection-probe/',
    });
    await expect(probeDestination(destination(mock.endpoint, 'library'))).rejects.toThrow(/create the bucket/);
    expect(mock.requests.some((line) => line.startsWith('GET '))).toBe(false);
  });
});
