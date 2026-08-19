/**
 * Project identity for this deployment. v1 is single-project: the slug is
 * seeded as `default` by the PocketBase migration (Task 8). If multi-project
 * routing ever lands, the Caddyfile can inject `window.__C11N_PROJECT` and
 * this becomes the one place to read it.
 */
export const PROJECT = 'default'
