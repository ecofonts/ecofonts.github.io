/**
 * Failure reporting shared by the worker boundary and the UI.
 *
 * The pieces of a thrown value worth keeping are not the obvious ones. A
 * DOMException's `message` alone is close to useless — "The operation was
 * aborted." names neither the API that gave up nor the reason — while its
 * `name` distinguishes an AbortError from a NotReadableError, which point at
 * completely different causes. Errors are flattened to plain data to cross
 * postMessage, so both must be carried explicitly or they are lost.
 */

export interface ErrorReport {
    message: string;
    name?: string;
    stack?: string;
}

/** Flatten a thrown value into structured-cloneable pieces. */
export function describeError(err: unknown): ErrorReport {
    // Duck-typed rather than `instanceof Error`: DOMException does inherit
    // from Error, but what a dynamically imported library throws is not ours
    // to assume.
    const error = err as Partial<Error> | null | undefined;
    if (typeof error?.message !== "string") return { message: String(err) };
    return {
        message: error.message,
        // "Error" carries no information; anything else does.
        name: error.name && error.name !== "Error" ? error.name : undefined,
        stack: typeof error.stack === "string" ? error.stack : undefined,
    };
}

/** Rebuild a reported failure as an Error, keeping its name and stack. */
export function rebuildError(report: ErrorReport): Error {
    const error = new Error(report.message);
    if (report.name) error.name = report.name;
    if (report.stack) error.stack = report.stack;
    return error;
}

/**
 * One-line failure text for the user. The name is included because it is the
 * part a bug report can be diagnosed from, and works for both pipeline paths:
 * worker failures arrive rebuilt with their name, inline ones never lost it.
 */
export function formatError(err: unknown): string {
    const { message, name } = describeError(err);
    return name ? `${name}: ${message}` : message;
}
