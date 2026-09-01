/**
 * Convenience barrel for the shared vocabulary. Everything else is reached by
 * subpath — `@mapply/core/tailor`, `@mapply/core/atsScore` and so on — because
 * a few modules deliberately re-export each other's helpers (`stripBulletPrefix`
 * comes from both `tailor` and `resumeFormat`) and a flat star-export would make
 * those ambiguous.
 */
export * from './types';
export * from './jobChat';
export * from './ports';
export * from './application';
