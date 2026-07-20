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

export function DiscoursePinIcon() {
  return <svg {...ICON} width={12} height={12}><path d="m14 4 6 6-4 1-4 4-1 5-2-2-5 2 4-4 1-4z" /></svg>;
}

export function DiscourseTaskIcon() {
  return <svg {...ICON}><rect x="4" y="3" width="16" height="18" rx="2" /><path d="m8 10 2 2 4-4M8 16h8" /></svg>;
}

export function DiscourseRepositoryIcon() {
  return <svg {...ICON}><path d="M4 4h12a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2z" /><path d="M8 4v16M18 8h2" /></svg>;
}
