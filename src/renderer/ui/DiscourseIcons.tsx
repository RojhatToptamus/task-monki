const ICON = {
  width: 13,
  height: 13,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
};

const iconA11y = { 'aria-hidden': true, focusable: false } as const;

export function DiscoursePinIcon() {
  return <svg {...ICON} {...iconA11y} width={12} height={12}><path d="m14 4 6 6-4 1-4 4-1 5-2-2-5 2 4-4 1-4z" /></svg>;
}

export function DiscourseTaskIcon() {
  return <svg {...ICON} {...iconA11y}><rect x="4" y="3" width="16" height="18" rx="2" /><path d="m8 10 2 2 4-4M8 16h8" /></svg>;
}

export function DiscourseRepositoryIcon() {
  return <svg {...ICON} {...iconA11y}><path d="M4 4h12a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2z" /><path d="M8 4v16M18 8h2" /></svg>;
}

export function DiscoursePanelLeftIcon({ expanded = false }: { expanded?: boolean }) {
  return (
    <svg {...ICON} {...iconA11y} width={16} height={16}>
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="M9 4v16" />
      <path d={expanded ? 'm6.8 9-2 3 2 3' : 'm5.2 9 2 3-2 3'} />
    </svg>
  );
}

export function DiscoursePanelRightIcon({ expanded = false }: { expanded?: boolean }) {
  return (
    <svg {...ICON} {...iconA11y} width={16} height={16}>
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="M15 4v16" />
      <path d={expanded ? 'm17.2 9 2 3-2 3' : 'm18.8 9-2 3 2 3'} />
    </svg>
  );
}

export function DiscourseContextPreviewIcon() {
  return (
    <svg {...ICON} {...iconA11y} width={16} height={16}>
      <path d="M6 3.5h8l4 4V20H6zM14 3.5V8h4" />
      <path d="M9 12h6M9 16h4" />
    </svg>
  );
}

export function DiscourseSlidersIcon() {
  return (
    <svg {...ICON} {...iconA11y} width={15} height={15}>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </svg>
  );
}

export function DiscourseReplyIcon() {
  return (
    <svg {...ICON} {...iconA11y} width={15} height={15}>
      <path d="m9 7-5 5 5 5" />
      <path d="M5 12h7c4 0 7 2 8 6-1-7-4-10-8-10H9" />
    </svg>
  );
}

export function DiscourseCopyIcon() {
  return (
    <svg {...ICON} {...iconA11y} width={15} height={15}>
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

export function DiscourseCheckIcon() {
  return <svg {...ICON} {...iconA11y} width={14} height={14}><path d="m5 12 4 4L19 6" /></svg>;
}

export function DiscourseMoreIcon() {
  return (
    <svg {...ICON} {...iconA11y} width={16} height={16}>
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function DiscourseChevronDownIcon() {
  return <svg {...ICON} {...iconA11y} width={14} height={14}><path d="m7 9 5 5 5-5" /></svg>;
}

export function DiscourseCloseIcon() {
  return <svg {...ICON} {...iconA11y} width={15} height={15}><path d="m7 7 10 10M17 7 7 17" /></svg>;
}

export function DiscourseRoundtableIcon() {
  return (
    <svg {...ICON} {...iconA11y} width={28} height={28}>
      <circle cx="12" cy="12" r="4" />
      <circle cx="5" cy="7" r="2" />
      <circle cx="19" cy="7" r="2" />
      <circle cx="5" cy="18" r="2" />
      <circle cx="19" cy="18" r="2" />
    </svg>
  );
}
