/**
 * Hands files dropped on the landing page to /font across the full page
 * navigation. IndexedDB is used because File objects survive structured
 * cloning there, with no practical size limit (fonts and PDFs can be tens
 * of MB — far beyond what sessionStorage could hold as base64).
 */

const DB_NAME = "ecofonts-handoff";
const STORE = "files";
const KEY = "pending";

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/** Store files for the next page to pick up. */
export async function stashFiles(files: File[]): Promise<void> {
    const db = await openDb();
    try {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, "readwrite");
            tx.objectStore(STORE).put(files, KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

/** Retrieve and remove the pending files, if any. Never throws. */
export async function takeFiles(): Promise<File[]> {
    try {
        const db = await openDb();
        try {
            return await new Promise<File[]>((resolve, reject) => {
                const tx = db.transaction(STORE, "readwrite");
                const store = tx.objectStore(STORE);
                const get = store.get(KEY);
                get.onsuccess = () => {
                    store.delete(KEY);
                    const value: unknown = get.result;
                    // Accept both the current array shape and the legacy
                    // single-File shape (from a page cached before this change).
                    if (Array.isArray(value)) {
                        resolve(value.filter((item): item is File => item instanceof File));
                    } else if (value instanceof File) {
                        resolve([value]);
                    } else {
                        resolve([]);
                    }
                };
                get.onerror = () => reject(get.error);
            });
        } finally {
            db.close();
        }
    } catch {
        return [];
    }
}
