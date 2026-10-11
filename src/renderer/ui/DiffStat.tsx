/** Lines added and removed, in the verified and blocked inks; a change with neither reads +0. */
export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="tm-diffstat">
      {additions || !deletions ? <span className="tm-diffstat__added">+{additions}</span> : null}
      {deletions ? <span className="tm-diffstat__removed">−{deletions}</span> : null}
    </span>
  );
}
