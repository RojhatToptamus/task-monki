export const ATTACHMENT_MAX_COUNT = 10;
export const ATTACHMENT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const ATTACHMENT_MAX_IMAGE_MEGAPIXELS = 16;
export const ATTACHMENT_MAX_IMAGE_PIXELS = ATTACHMENT_MAX_IMAGE_MEGAPIXELS * 1_000_000;
export const ATTACHMENT_MAX_CLIPBOARD_IMAGE_PIXELS = 12_000_000;
export const ATTACHMENT_DEFAULT_STORAGE_QUOTA_BYTES = 1024 * 1024 * 1024;

const ATTACHMENT_CLIENT_TOKEN = /^[A-Za-z0-9_-]{16,128}$/u;

export const ATTACHMENT_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const;

export const ATTACHMENT_TEXT_EXTENSIONS = [
  '.c',
  '.cc',
  '.clj',
  '.cljs',
  '.cmake',
  '.cjs',
  '.conf',
  '.cpp',
  '.cs',
  '.cts',
  '.css',
  '.csv',
  '.dart',
  '.ex',
  '.exs',
  '.fs',
  '.fsx',
  '.go',
  '.graphql',
  '.gql',
  '.h',
  '.hpp',
  '.hs',
  '.html',
  '.htm',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.kts',
  '.less',
  '.lock',
  '.log',
  '.lua',
  '.m',
  '.md',
  '.markdown',
  '.mjs',
  '.mm',
  '.mts',
  '.php',
  '.pl',
  '.proto',
  '.properties',
  '.ps1',
  '.py',
  '.r',
  '.rb',
  '.rs',
  '.sass',
  '.scala',
  '.scss',
  '.sh',
  '.sol',
  '.sql',
  '.svelte',
  '.svg',
  '.swift',
  '.tex',
  '.text',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
  '.zig',
  '.zsh'
] as const;

export const ATTACHMENT_TEXT_FILENAMES = [
  '.editorconfig',
  '.eslintignore',
  '.eslintrc',
  '.gitignore',
  '.prettierignore',
  '.prettierrc',
  'Brewfile',
  'CMakeLists.txt',
  'Dockerfile',
  'Gemfile',
  'LICENSE',
  'Makefile',
  'Procfile',
  'README'
] as const;

export const ATTACHMENT_BLOCKED_FILENAMES = [
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'credentials.json',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'service-account.json',
  'serviceaccount.json'
] as const;

export const ATTACHMENT_FILE_INPUT_ACCEPT = [
  ...ATTACHMENT_IMAGE_EXTENSIONS,
  ...ATTACHMENT_TEXT_EXTENSIONS,
  'text/plain'
].join(',');

export type AttachmentKind = 'image' | 'text';

export interface AttachmentDescriptor {
  id: string;
  ordinal: number;
  displayName: string;
  kind: AttachmentKind;
  mediaType: string;
  byteCount: number;
  sha256: string;
  /** Schema 10 migration input only. New records derive storage from task and attachment ids. */
  storageKey?: string;
  createdAt: string;
}

export interface StagedAttachmentRecord extends AttachmentDescriptor {
  draftId: string;
  /**
   * Opaque idempotency key. Core creates one for trusted internal callers that
   * do not cross a retryable renderer transport.
   */
  clientToken?: string;
}

export interface TaskAttachmentRecord extends AttachmentDescriptor {
  taskId: string;
}

export interface AttachmentDraftSnapshot {
  id: string;
  attachments: StagedAttachmentRecord[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Exact provider delivery mechanism retained as evidence.
 *
 * `nativeFile` means the runtime received a structured file input (for
 * example an OpenCode file part), not merely a path mentioned in prompt text.
 */
export type AttachmentSubmissionMode =
  | 'localImage'
  | 'nativeFile'
  | 'prompt-file-reference';

/** Durable evidence recorded after the provider accepted a turn or review start. */
export interface AttachmentSubmissionRecord {
  attachmentId: string;
  ordinal: number;
  kind: AttachmentKind;
  mediaType: string;
  byteCount: number;
  sha256: string;
  submittedAs: AttachmentSubmissionMode;
  verifiedAt: string;
  providerTurnId: string;
  submittedAt: string;
}

export interface StageAttachmentBytesInput {
  draftId: string;
  clientToken?: string;
  displayName: string;
  bytes: Uint8Array;
  /** Browser-reported hint only. Admission is based on the name and bytes. */
  declaredMediaType?: string;
}

export interface StageTaskAttachmentBatchRequest {
  attachments: Array<{
    clientToken: string;
    displayName: string;
    declaredMediaType?: string;
    bytes: ArrayBuffer;
  }>;
}

export interface DiscardTaskAttachmentDraftRequest {
  draftId: string;
}

export interface ReadTaskAttachmentRequest {
  attachmentId: string;
}

export interface ReadDraftAttachmentRequest {
  draftId: string;
  attachmentId: string;
}

export interface ClipboardAttachmentImage {
  displayName: string;
  mediaType: string;
  bytes: ArrayBuffer;
}

export interface AttachmentContent {
  attachmentId: string;
  displayName: string;
  kind: AttachmentKind;
  mediaType: string;
  byteCount: number;
  bytes: ArrayBuffer;
}

export function attachmentKindForFileName(fileName: string): AttachmentKind | undefined {
  const normalized = fileName.normalize('NFC');
  const lowerName = normalized.toLocaleLowerCase('en-US');
  if (
    lowerName === '.env' ||
    lowerName.startsWith('.env.') ||
    (ATTACHMENT_BLOCKED_FILENAMES as readonly string[]).includes(lowerName)
  ) {
    return undefined;
  }
  if (ATTACHMENT_TEXT_FILENAMES.some((candidate) => candidate.toLocaleLowerCase('en-US') === lowerName)) {
    return 'text';
  }
  const extensionIndex = lowerName.lastIndexOf('.');
  const extension = extensionIndex >= 0 ? lowerName.slice(extensionIndex) : '';
  if ((ATTACHMENT_IMAGE_EXTENSIONS as readonly string[]).includes(extension)) {
    return 'image';
  }
  if ((ATTACHMENT_TEXT_EXTENSIONS as readonly string[]).includes(extension)) {
    return 'text';
  }
  return undefined;
}

export function attachmentMaxBytesForKind(kind: AttachmentKind): number {
  return kind === 'image' ? ATTACHMENT_MAX_IMAGE_BYTES : ATTACHMENT_MAX_TEXT_BYTES;
}

export function isAttachmentClientToken(value: unknown): value is string {
  return typeof value === 'string' && ATTACHMENT_CLIENT_TOKEN.test(value);
}
