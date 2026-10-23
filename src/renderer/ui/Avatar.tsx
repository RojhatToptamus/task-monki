import { User } from 'lucide-react';
import { personInitials } from '../model/formatting';

/**
 * Who wrote something, beside their name: their initials on the avatar
 * fallback plane, or a person when the account is not known. The name beside
 * it is what assistive technology reads.
 */
export function Avatar({ name, className }: { name: string | undefined; className?: string }) {
  return (
    <span className={`tm-avatar${className ? ` ${className}` : ''}`} aria-hidden="true">
      {name?.trim() ? personInitials(name) : <User size={13} />}
    </span>
  );
}
