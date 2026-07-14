import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ServerConfig } from './config.js';

export interface ObjectStorage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  signedDownloadUrl(key: string, expiresInSeconds?: number): Promise<string>;
}

export class MemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(key, bytes.slice());
  }

  async get(key: string): Promise<Uint8Array> {
    const value = this.objects.get(key);
    if (!value) throw new Error('object_not_found');
    return value.slice();
  }

  async signedDownloadUrl(key: string): Promise<string> {
    if (!this.objects.has(key)) throw new Error('object_not_found');
    return `memory://${encodeURIComponent(key)}`;
  }
}

class FilesystemObjectStorage implements ObjectStorage {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    const normalized = key.replaceAll('\\', '/').replace(/^\/+/, '');
    const path = resolve(this.root, normalized);
    const root = resolve(this.root);
    if (path !== root && !path.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new Error('invalid_storage_key');
    }
    return path;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }

  async get(key: string): Promise<Uint8Array> {
    return readFile(this.path(key));
  }

  async signedDownloadUrl(key: string): Promise<string> {
    await readFile(this.path(key));
    return `local-object://${encodeURIComponent(key)}`;
  }
}

class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(private readonly config: ServerConfig['objectStorage']) {
    if (!config.accessKey || !config.secretKey) {
      throw new Error('S3 object storage vyžaduje access key a secret key');
    }
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    });
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      Body: bytes,
      ContentType: contentType,
      ServerSideEncryption: 'AES256',
    }));
  }

  async get(key: string): Promise<Uint8Array> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
    if (!response.Body) throw new Error('object_not_found');
    return response.Body.transformToByteArray();
  }

  async signedDownloadUrl(key: string, expiresInSeconds = 300): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn: Math.min(Math.max(expiresInSeconds, 30), 900) },
    );
  }
}

export function createObjectStorage(config: ServerConfig): ObjectStorage {
  if (config.objectStorage.mode === 'memory') return new MemoryObjectStorage();
  if (config.objectStorage.mode === 's3') return new S3ObjectStorage(config.objectStorage);
  return new FilesystemObjectStorage(config.objectStorage.filesystemRoot);
}
