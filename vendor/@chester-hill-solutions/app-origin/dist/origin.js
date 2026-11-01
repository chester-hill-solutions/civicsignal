/**
 * The public origin of a deployed application.
 *
 * The public origin is the address that a browser uses to reach the
 * application. It is the base of every absolute link that the application
 * sends, and it is the value that the origin of a request must match.
 *
 * On Railway the platform publishes the public domain as a host name without a
 * scheme, so the helper adds the scheme. A trailing slash is removed, because
 * a browser sends the origin without one, and a request origin must compare
 * equal to the configured origin.
 */
/** The public origin, or an empty string when no host has configured one. */
export function appPublicOrigin() {
    const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
    if (railway) {
        if (/^https?:\/\//i.test(railway))
            return railway.replace(/\/$/, "");
        return `https://${railway.replace(/\/$/, "")}`;
    }
    const fromApp = process.env.APP_PUBLIC_ORIGIN?.trim();
    if (fromApp)
        return fromApp.replace(/\/$/, "");
    return "";
}
/**
 * The origins that a redirect may use. The list holds the public origin and
 * the origins that the host configured. A host that names no origin gets the
 * fallback.
 */
export function authTrustedOrigins(fallback = "http://localhost:5173") {
    const fromEnv = (process.env.APP_TRUSTED_ORIGINS ?? fallback)
        .split(/[,;\s]+/)
        .map((value) => value.trim())
        .filter(Boolean);
    const publicOrigin = appPublicOrigin();
    const merged = publicOrigin ? [publicOrigin, ...fromEnv] : fromEnv;
    return [...new Set(merged)];
}
/**
 * An absolute address of the application. The address stays on the origin that
 * the browser uses, so a redirect cannot leave the application.
 */
export function absoluteAppUrl(request, pathname) {
    const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
    const origin = appPublicOrigin() || new URL(request.url).origin;
    return new URL(path, origin).href;
}
