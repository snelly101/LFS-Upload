/**
 * Runtime surface of @securesend/shared for the browser. The web app only needs the formatting
 * helpers at runtime (everything else it imports from the shared package is a type), so Vite aliases
 * the package to this file. That keeps the zod policy schemas out of every browser bundle. If a
 * value that is not re-exported here is ever imported, the production build fails loudly.
 */
export * from '../../../../packages/shared/src/format';
