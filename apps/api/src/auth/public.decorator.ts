import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route as reachable without an access token. Every other route is
 * protected by default (deny by default), so forgetting a decorator fails safe.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
