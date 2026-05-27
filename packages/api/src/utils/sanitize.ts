/**
 * Sanitizes user-provided text to prevent stored XSS vulnerabilities
 * by escaping HTML control characters (&, <, >, ", ').
 */
export function sanitizeHTML(text: string): string {
    if (typeof text !== 'string') {
        return '';
    }
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}
