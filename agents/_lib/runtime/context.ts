import type { ProjectState } from '../types.ts';

/** The slice of the Makers agent `context` this template actually reads. */
export type AgentContext = {
  conversation_id?: string;
  run_id?: string;
  env?: Record<string, string | undefined>;
  request?: {
    body?: unknown;
    headers?: Headers | Record<string, string>;
    signal?: AbortSignal;
    url?: string;
    path?: string;
    query?: unknown;
    params?: unknown;
    [key: string]: unknown;
  };
  sandbox?: {
    files: {
      exists: (path: string) => Promise<boolean>;
      read: (path: string) => Promise<string | Uint8Array>;
      write: (path: string, content: string | Uint8Array) => Promise<void>;
      makeDir: (path: string) => Promise<void>;
      remove?: (path: string) => Promise<void>;
    };
    commands: { run: (command: string, options?: Record<string, unknown>) => Promise<unknown> };
    persist: (options: { path: string }) => Promise<unknown>;
    restore: (options: { path: string }) => Promise<{ restored?: boolean } | undefined>;
    getHost?: (port: number) => Promise<string | undefined>;
    envdAccessToken?: string;
    browser?: { liveUrl?: string };
    extendTimeout?: (seconds: number) => unknown;
  };
  tools?: {
    toClaudeMcpServer: (name: string, options?: { alwaysLoad?: boolean }) => {
      tools: unknown[];
      allowedTools: string[];
    };
  };
  utils?: {
    abortActiveRun?: (conversationId: string) => Promise<{ aborted?: boolean } | undefined>;
  };
  /** Test seam: an in-memory Blob stand-in. Production uses `@edgeone/pages-blob`. */
  blobStore?: BlobStoreLike;
};

export type BlobStoreLike = {
  set: (key: string, value: string | ArrayBuffer | Blob | ReadableStream, options?: { onlyIfNew?: boolean }) => Promise<void>;
  setJSON: (key: string, value: unknown, options?: { onlyIfNew?: boolean }) => Promise<void>;
  get: (key: string, options?: { type?: 'text' | 'json' | 'arrayBuffer' | 'blob' | 'stream'; consistency?: 'strong' | 'eventual' }) => Promise<unknown>;
  delete: (key: string) => Promise<void>;
  list: (options?: { prefix?: string }) => Promise<{ blobs: Array<{ key: string; etag?: string }> }>;
};

export type WorkspaceMode = 'prepare' | 'resume';

export type { ProjectState };
