import { CircleArrowUp, Download, RefreshCw, TriangleAlert } from 'lucide-react';
import type { SoftwareUpdateState } from '../../shared/softwareUpdate';
import { Tooltip } from './Tooltip';
import { UiLucideIcon } from './UiIcons';

export interface SoftwareUpdateNoticeProps {
  state: SoftwareUpdateState;
  onDownload(): void;
  onInstall(): void;
}

/** The rail's update control: one icon, a dot while it needs the user, and the state in its tooltip. */
export function SoftwareUpdateNotice({ state, onDownload, onInstall }: SoftwareUpdateNoticeProps) {
  const notice = buildSoftwareUpdateNotice(state);
  if (!notice) return null;
  const label = notice.tone === 'downloading' ? `${notice.label}, ${notice.percent}%` : notice.label;
  const icon = <>
    <NoticeIcon tone={notice.tone} />
    {notice.showDot ? <span className="tm-rail__dot" aria-hidden="true" /> : null}
  </>;

  if (notice.action === 'none') {
    return (
      <Tooltip label={label} side="right">
        <div className="tm-rail__item tm-rail__update" data-tone={notice.tone} tabIndex={0} aria-label={label}>
          {icon}
          <span
            className="tm-visually-hidden"
            role="progressbar"
            aria-label="Update download progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={notice.percent}
          />
        </div>
      </Tooltip>
    );
  }

  return (
    <Tooltip label={notice.title} side="right">
      <button
        type="button"
        className="tm-rail__item tm-rail__update"
        data-tone={notice.tone}
        aria-label={notice.label}
        onClick={notice.action === 'install' ? onInstall : onDownload}
      >
        {icon}
      </button>
    </Tooltip>
  );
}

export function buildSoftwareUpdateNotice(state: SoftwareUpdateState): {
  tone: 'available' | 'downloading' | 'ready' | 'failed';
  label: string;
  title: string;
  action: 'download' | 'install' | 'none';
  percent: number;
  showDot: boolean;
} | null {
  const version = state.availableVersion;
  if (state.status === 'available' && version) {
    return {
      tone: 'available',
      label: `Update to ${version}`,
      title: `Download Task Monki ${version}`,
      action: 'download',
      percent: 0,
      showDot: true
    };
  }
  if (state.status === 'downloading' && version) {
    const percent = Math.round(state.progress?.percent ?? 0);
    return {
      tone: 'downloading',
      label: `Downloading ${version}`,
      title: `Downloading Task Monki ${version}`,
      action: 'none',
      percent,
      showDot: true
    };
  }
  if (state.status === 'downloaded') {
    return {
      tone: 'ready',
      label: 'Restart to update',
      title: 'Restart Task Monki and install the update',
      action: 'install',
      percent: 100,
      showDot: false
    };
  }
  if (state.status === 'error' && version) {
    return {
      tone: 'failed',
      label: 'Update failed',
      title: 'Try downloading the update again',
      action: 'download',
      percent: 0,
      showDot: true
    };
  }
  return null;
}

function NoticeIcon({ tone }: { tone: 'available' | 'downloading' | 'ready' | 'failed' }) {
  if (tone === 'ready') return <UiLucideIcon component={RefreshCw} />;
  if (tone === 'failed') return <UiLucideIcon component={TriangleAlert} />;
  if (tone === 'downloading') return <UiLucideIcon component={Download} />;
  return <UiLucideIcon component={CircleArrowUp} />;
}
