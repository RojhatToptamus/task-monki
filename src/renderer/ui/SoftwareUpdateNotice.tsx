import { Download, RefreshCw, Sparkles, TriangleAlert } from 'lucide-react';
import type { SoftwareUpdateState } from '../../shared/softwareUpdate';
import { UiLucideIcon } from './UiIcons';

export interface SoftwareUpdateNoticeProps {
  state: SoftwareUpdateState;
  collapsed: boolean;
  onDownload(): void;
  onInstall(): void;
}

export function SoftwareUpdateNotice({
  state,
  collapsed,
  onDownload,
  onInstall
}: SoftwareUpdateNoticeProps) {
  const notice = buildSoftwareUpdateNotice(state);
  if (!notice) return null;

  const content = (
    <>
      <span className="tm-software-update__icon" aria-hidden="true">
        <NoticeIcon tone={notice.tone} />
        {collapsed && notice.showDot ? <span className="tm-software-update__dot" /> : null}
      </span>
      <span className="tm-software-update__body">
        <span className="tm-software-update__label">{notice.label}</span>
        {notice.tone === 'downloading' ? (
          <span
            className="tm-software-update__progress"
            role="progressbar"
            aria-label="Update download progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={notice.percent}
          >
            <span style={{ width: `${notice.percent}%` }} />
          </span>
        ) : null}
      </span>
      {notice.tone === 'downloading' ? (
        <span className="tm-software-update__percent">{notice.percent}%</span>
      ) : null}
    </>
  );

  if (notice.action === 'none') {
    return (
      <div
        className={`tm-software-update tm-software-update--${notice.tone}`}
        aria-live="polite"
        aria-label={notice.label}
        data-tip={collapsed ? notice.label : undefined}
      >
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`tm-software-update tm-software-update--${notice.tone}`}
      aria-label={notice.label}
      title={notice.title}
      data-tip={collapsed ? notice.label : undefined}
      onClick={notice.action === 'install' ? onInstall : onDownload}
    >
      {content}
    </button>
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
  return <UiLucideIcon component={Sparkles} />;
}
