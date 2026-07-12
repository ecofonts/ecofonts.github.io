/**
 * Hands a dropped file from the landing page to /font across the full page
 * navigation. IndexedDB is used because File objects survive structured
 * cloning there, with no practical size limit (fonts can be tens of MB —
 * far beyond what sessionStorage could hold as base64).
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

/** Store a file for the next page to pick up. */
export async function stashFile(file: File): Promise<void> {
    const db = await openDb();
    try {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, "readwrite");
            tx.objectStore(STORE).put(file, KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

/** Retrieve and remove the pending file, if any. Never throws. */
export async function takeFile(): Promise<File | null> {
    try {
        const db = await openDb();
        try {
            return await new Promise<File | null>((resolve, reject) => {
                const tx = db.transaction(STORE, "readwrite");
                const store = tx.objectStore(STORE);
                const get = store.get(KEY);
                get.onsuccess = () => {
                    store.delete(KEY);
                    resolve(get.result instanceof File ? get.result : null);
                };
                get.onerror = () => reject(get.error);
            });
        } finally {
            db.close();
        }
    } catch {
        return null;
    }
}
