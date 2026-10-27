import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import type { DestinationConfig } from './model.js';

const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

interface S3Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export class S3ProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'S3ProbeError';
  }
}

/**
 * Writes and deletes the objects restic needs under the configured prefix:
 * a single PUT (with Content-MD5), list, head, get, a multipart upload, and
 * delete. Path-style is used when the destination asks for it.
 *
 * Creating the bucket is optional. Restic never creates it, and a normal
 * object credential often cannot. A 403 or 409 is success when listing that
 * bucket works.
 */
export async function probeDestination(destination: DestinationConfig): Promise<void> {
  const endpoint = new URL(destination.endpoint);
  await ensureBucket(destination, endpoint);
  const key = probeObjectKey(destination, randomBytes(8).toString('hex'));
  const body = Buffer.from('qijuan-connection-probe');
  await putObject(destination, endpoint, key, body);
  await headObject(destination, endpoint, key);
  const read = await getObject(destination, endpoint, key);
  if (!read.equals(body)) throw new S3ProbeError('The destination returned different bytes than were written.');
  await listObjects(destination, endpoint, key);
  const multipartKey = probeObjectKey(destination, `${randomBytes(8).toString('hex')}-part`);
  await multipartRoundTrip(destination, endpoint, multipartKey, Buffer.from('qijuan-multipart-part'));
  await deleteObject(destination, endpoint, key);
  await deleteObject(destination, endpoint, multipartKey);
  await assertRepositoryPolicies(destination, endpoint);
}

/**
 * Lifecycle expiration, storage-class transitions, and object lock delete or
 * freeze objects restic still needs. Aborting incomplete multipart uploads
 * is allowed. A key that cannot read these settings is rejected too: QiJuan
 * will not claim the bucket is safe when it cannot see the rules.
 */
async function assertRepositoryPolicies(destination: DestinationConfig, endpoint: URL): Promise<void> {
  const location = bucketLocation(destination, endpoint);
  const lifecycle = await signedRequest(destination, endpoint, {
    method: 'GET',
    host: location.host,
    path: location.path,
    query: { lifecycle: '' },
    body: Buffer.alloc(0),
  });
  if (lifecycle.status === 200) {
    const xml = lifecycle.body.toString('utf8');
    if (/<(Expiration|NoncurrentVersionExpiration|Transition|NoncurrentVersionTransition)\b/.test(xml)) {
      throw new S3ProbeError(
        'This bucket has a lifecycle rule that can expire, transition, or delete objects. Remove those rules. Restic retention is the only cleanup that should delete backup data. Aborting incomplete multipart uploads is allowed.',
      );
    }
  } else if (!absentConfiguration(lifecycle, ['NoSuchLifecycleConfiguration', 'NoSuchLifecycle'])) {
    if (lifecycle.status === 403) {
      throw new S3ProbeError(
        'This key cannot read the bucket lifecycle configuration. Allow that read, and remove expiration and transition rules before using the bucket.',
      );
    }
    throw new S3ProbeError(errorText('read the bucket lifecycle', lifecycle));
  }

  const lock = await signedRequest(destination, endpoint, {
    method: 'GET',
    host: location.host,
    path: location.path,
    query: { 'object-lock': '' },
    body: Buffer.alloc(0),
  });
  if (lock.status === 200 && /<ObjectLockEnabled>\s*Enabled\s*<\/ObjectLockEnabled>/.test(lock.body.toString('utf8'))) {
    throw new S3ProbeError(
      'Object lock is enabled on this bucket. Restic has to delete objects when retention removes a snapshot. Use a bucket without object lock or a default retention period.',
    );
  }
  if (lock.status === 200) return;
  if (absentConfiguration(lock, ['ObjectLockConfigurationNotFoundError', 'ObjectLockConfigurationNotFound'])) return;
  if (lock.status === 403) {
    throw new S3ProbeError(
      'This key cannot read the bucket object-lock configuration. Allow that read, and use a bucket without object lock.',
    );
  }
  throw new S3ProbeError(errorText('read the bucket object lock', lock));
}

function absentConfiguration(response: S3Response, codes: string[]): boolean {
  if (response.status === 404) return true;
  const code = xmlTag(response.body.toString('utf8'), 'Code');
  return code !== null && codes.includes(code);
}

async function ensureBucket(destination: DestinationConfig, endpoint: URL): Promise<void> {
  const location = bucketLocation(destination, endpoint);
  const created = await signedRequest(destination, endpoint, {
    method: 'PUT',
    host: location.host,
    path: location.path,
    body: Buffer.alloc(0),
  });
  if (created.status === 200) return;
  if (created.status === 403 || created.status === 409) {
    await listBucket(destination, endpoint);
    return;
  }
  throw new S3ProbeError(errorText('create the bucket', created));
}

/** Confirms the bucket exists and this key can list it, without creating it. */
async function listBucket(destination: DestinationConfig, endpoint: URL): Promise<void> {
  const location = bucketLocation(destination, endpoint);
  const query: Record<string, string> = { 'list-type': '2', 'max-keys': '1' };
  const prefix = destinationPrefix(destination);
  if (prefix) query.prefix = `${prefix}/`;
  const response = await signedRequest(destination, endpoint, {
    method: 'GET',
    host: location.host,
    path: location.path,
    query,
    body: Buffer.alloc(0),
  });
  if (response.status !== 200) throw new S3ProbeError(errorText('list the bucket', response));
}

async function putObject(destination: DestinationConfig, endpoint: URL, key: string, body: Buffer): Promise<void> {
  const location = objectLocation(destination, endpoint, key);
  const response = await signedRequest(destination, endpoint, {
    method: 'PUT',
    host: location.host,
    path: location.path,
    body,
    contentType: 'application/octet-stream',
    contentMd5: createHash('md5').update(body).digest('base64'),
  });
  if (response.status !== 200) throw new S3ProbeError(errorText('write an object', response));
}

async function headObject(destination: DestinationConfig, endpoint: URL, key: string): Promise<void> {
  const location = objectLocation(destination, endpoint, key);
  const response = await signedRequest(destination, endpoint, {
    method: 'HEAD',
    host: location.host,
    path: location.path,
    body: Buffer.alloc(0),
  });
  if (response.status !== 200) throw new S3ProbeError(errorText('read object metadata', response));
}

async function getObject(destination: DestinationConfig, endpoint: URL, key: string): Promise<Buffer> {
  const location = objectLocation(destination, endpoint, key);
  const response = await signedRequest(destination, endpoint, {
    method: 'GET',
    host: location.host,
    path: location.path,
    body: Buffer.alloc(0),
  });
  if (response.status !== 200) throw new S3ProbeError(errorText('read an object', response));
  return response.body;
}

async function listObjects(destination: DestinationConfig, endpoint: URL, key: string): Promise<void> {
  const location = bucketLocation(destination, endpoint);
  const response = await signedRequest(destination, endpoint, {
    method: 'GET',
    host: location.host,
    path: location.path,
    query: { 'list-type': '2', prefix: key },
    body: Buffer.alloc(0),
  });
  if (response.status !== 200) throw new S3ProbeError(errorText('list objects', response));
  if (!response.body.toString('utf8').includes(`<Key>${key}</Key>`)) {
    throw new S3ProbeError('The destination listed the bucket but did not return the probe object.');
  }
}

async function deleteObject(destination: DestinationConfig, endpoint: URL, key: string): Promise<void> {
  const location = objectLocation(destination, endpoint, key);
  const response = await signedRequest(destination, endpoint, {
    method: 'DELETE',
    host: location.host,
    path: location.path,
    body: Buffer.alloc(0),
  });
  if (response.status !== 204 && response.status !== 200) {
    throw new S3ProbeError(errorText('delete an object', response));
  }
}

async function multipartRoundTrip(
  destination: DestinationConfig,
  endpoint: URL,
  key: string,
  part: Buffer,
): Promise<void> {
  const location = objectLocation(destination, endpoint, key);
  const started = await signedRequest(destination, endpoint, {
    method: 'POST',
    host: location.host,
    path: location.path,
    query: { uploads: '' },
    body: Buffer.alloc(0),
  });
  if (started.status !== 200) throw new S3ProbeError(errorText('start a multipart upload', started));
  const uploadId = xmlTag(started.body.toString('utf8'), 'UploadId');
  if (!uploadId) throw new S3ProbeError('The destination did not return a multipart upload id.');
  const uploaded = await signedRequest(destination, endpoint, {
    method: 'PUT',
    host: location.host,
    path: location.path,
    query: { partNumber: '1', uploadId },
    body: part,
    contentType: 'application/octet-stream',
  });
  if (uploaded.status !== 200) throw new S3ProbeError(errorText('upload a multipart part', uploaded));
  const etag = uploaded.headers.etag;
  if (!etag || Array.isArray(etag)) throw new S3ProbeError('The destination did not return a part ETag.');
  const completeBody = Buffer.from(
    `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${escapeXml(etag)}</ETag></Part></CompleteMultipartUpload>`,
  );
  const completed = await signedRequest(destination, endpoint, {
    method: 'POST',
    host: location.host,
    path: location.path,
    query: { uploadId },
    body: completeBody,
    contentType: 'application/xml',
  });
  if (completed.status !== 200) throw new S3ProbeError(errorText('finish a multipart upload', completed));
}

function destinationPrefix(destination: DestinationConfig): string {
  return destination.prefix.replace(/^\/+|\/+$/g, '');
}

function probeObjectKey(destination: DestinationConfig, suffix: string): string {
  const prefix = destinationPrefix(destination);
  const name = `qijuan-connection-probe/${suffix}`;
  return prefix ? `${prefix}/${name}` : name;
}

function objectLocation(destination: DestinationConfig, endpoint: URL, key: string): { host: string; path: string } {
  if (!destination.pathStyle) {
    return { host: `${destination.bucket}.${endpoint.host}`, path: `/${key}` };
  }
  return { host: endpoint.host, path: `/${destination.bucket}/${key}` };
}

function bucketLocation(destination: DestinationConfig, endpoint: URL): { host: string; path: string } {
  if (!destination.pathStyle) {
    return { host: `${destination.bucket}.${endpoint.host}`, path: '/' };
  }
  return { host: endpoint.host, path: `/${destination.bucket}` };
}

function signedRequest(
  destination: DestinationConfig,
  endpoint: URL,
  input: {
    method: string;
    host: string;
    path: string;
    query?: Record<string, string>;
    body: Buffer;
    contentType?: string;
    contentMd5?: string;
  },
): Promise<S3Response> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = input.body.length === 0 ? EMPTY_HASH : createHash('sha256').update(input.body).digest('hex');
  const host = input.host;
  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (input.contentType) headers['content-type'] = input.contentType;
  if (input.contentMd5) headers['content-md5'] = input.contentMd5;
  const signed = Object.keys(headers).sort();
  const canonicalHeaders = signed.map((name) => `${name}:${headers[name]}\n`).join('');
  const query = canonicalQuery(input.query ?? {});
  const canonical = `${input.method}\n${encodePath(input.path)}\n${query}\n${canonicalHeaders}\n${signed.join(';')}\n${payloadHash}`;
  const scope = `${dateStamp}/${destination.region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash('sha256').update(canonical).digest('hex')}`;
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${destination.secretAccessKey}`, dateStamp), destination.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${destination.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`;
  const search = query ? `?${query}` : '';
  const transport = endpoint.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: endpoint.protocol,
        hostname: host.split(':')[0],
        port: endpoint.port || undefined,
        method: input.method,
        path: `${encodePath(input.path)}${search}`,
        headers: {
          ...headers,
          authorization,
          'content-length': input.body.length,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on('error', () => {
      reject(new S3ProbeError(`Could not connect to ${endpoint.origin}.`));
    });
    request.setTimeout(20_000, () => {
      request.destroy();
      reject(new S3ProbeError(`The destination at ${endpoint.origin} did not respond.`));
    });
    request.end(input.body);
  });
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((key) => `${awsEncode(key)}=${awsEncode(query[key] ?? '')}`)
    .join('&');
}

function encodePath(value: string): string {
  return value
    .split('/')
    .map((segment) => awsEncode(segment))
    .join('/');
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function xmlTag(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return match?.[1] ?? null;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function errorText(action: string, response: S3Response): string {
  const body = response.body.toString('utf8');
  const code = xmlTag(body, 'Code');
  const message = xmlTag(body, 'Message');
  const detail = [code, message].filter(Boolean).join(': ') || `HTTP ${response.status}`;
  return `Could not ${action} (${detail}).`;
}
