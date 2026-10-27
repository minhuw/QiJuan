/** One library maintenance job or one backup task at a time, in this process. */
type Owner = 'backup' | 'library';

let owner: Owner | null = null;

export function tryAcquire(next: Owner): boolean {
  if (owner !== null) return false;
  owner = next;
  return true;
}

export function release(current: Owner): void {
  if (owner === current) owner = null;
}

export function holder(): Owner | null {
  return owner;
}
