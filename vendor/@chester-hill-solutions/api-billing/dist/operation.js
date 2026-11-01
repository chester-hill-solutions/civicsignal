/** IDs are opaque identifiers, never raw API keys or request bodies. */
export function validateOperationId(value) {
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(value)) {
        throw new TypeError('An operation ID must contain 1 to 128 letters, digits, dots, underscores, colons or hyphens.');
    }
}
export async function operationDigest(value) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
