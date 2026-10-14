// Only allow redirects to a page on this site: one leading "/", no "//" or "/\\" (browsers
// treat "/\\evil.com" like "//evil.com"), no spaces or control characters.
const safePath = (p, fallback = '/') => (typeof p === 'string' && /^\/(?![\/\\])[^\\\s\x00-\x1f]*$/.test(p) ? p : fallback);

module.exports = { safePath };
