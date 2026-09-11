// @types/node >= 23 dropped the top-level `JsonWebKey` alias; src/vendor targets ^22 and must stay byte-identical.
declare module 'node:crypto' {
    type JsonWebKey = import('node:crypto').webcrypto.JsonWebKey;
}
