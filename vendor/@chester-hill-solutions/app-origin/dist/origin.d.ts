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
export declare function appPublicOrigin(): string;
/**
 * The origins that a redirect may use. The list holds the public origin and
 * the origins that the host configured. A host that names no origin gets the
 * fallback.
 */
export declare function authTrustedOrigins(fallback?: string): string[];
/**
 * An absolute address of the application. The address stays on the origin that
 * the browser uses, so a redirect cannot leave the application.
 */
export declare function absoluteAppUrl(request: Request, pathname: string): string;
