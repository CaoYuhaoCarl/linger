/**
 * The Computer the person last picked on the Local models page, per Tenant.
 * It lives only in this browser's localStorage, so every read and write
 * tolerates a missing or blocked storage.
 */

const storagePrefix = "local-models-last-computer.v1:";

export function readLastPickedComputer(tenantId: string) {
  try {
    return (
      window.localStorage.getItem(`${storagePrefix}${tenantId}`) ?? undefined
    );
  } catch {
    return undefined;
  }
}

export function rememberPickedComputer(tenantId: string, computerId: string) {
  try {
    window.localStorage.setItem(`${storagePrefix}${tenantId}`, computerId);
  } catch {
    // A blocked or full storage only loses the default for the next visit.
  }
}

export function clearLastPickedComputers() {
  try {
    const storage = window.localStorage;
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index);
      if (key?.startsWith(storagePrefix)) storage.removeItem(key);
    }
  } catch {
    // Blocked storage must not prevent Session cleanup.
  }
}
