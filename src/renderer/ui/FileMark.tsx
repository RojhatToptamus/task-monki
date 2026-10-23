import { FileCode, FileCog, FileImage, FileJson, FileLock, FileMinus, FilePlus, FileTerminal, FileText, type LucideIcon } from 'lucide-react';
import type { DiffFile } from '../model/diffEvidence';
import { reviewFileKind, type ReviewFileKind } from '../model/reviewOrder';

const KIND_ICONS: Record<ReviewFileKind, LucideIcon> = {
  code: FileCode,
  text: FileText,
  data: FileJson,
  image: FileImage,
  script: FileTerminal,
  lock: FileLock,
  config: FileCog
};

/**
 * A changed file's mark, in every list and head that names the file: a new or
 * deleted file says so by its shape, in the diff's own green or red; any other
 * file shows what it is, in its row's ink.
 */
export function FileMark({ file }: { file: Pick<DiffFile, 'path' | 'status'> }) {
  if (file.status === 'added') return <FilePlus size={13} className="tm-file-mark" data-status="added" role="img" aria-label={fileStatusLabel(file)} />;
  if (file.status === 'deleted') return <FileMinus size={13} className="tm-file-mark" data-status="deleted" role="img" aria-label={fileStatusLabel(file)} />;
  const Icon = KIND_ICONS[reviewFileKind(file.path)];
  return <Icon size={13} className="tm-file-mark" aria-hidden="true" />;
}

/** What a new or deleted file's mark says, for a control whose own name hides the mark's. */
export function fileStatusLabel(file: Pick<DiffFile, 'status'>): string | undefined {
  return file.status === 'added' ? 'New file' : file.status === 'deleted' ? 'Deleted file' : undefined;
}
