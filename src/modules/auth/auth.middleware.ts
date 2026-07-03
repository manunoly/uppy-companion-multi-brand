import type { Response, NextFunction } from 'express';
import type { AppRequest } from '../../core/types/express.js';

/**
 * Interim fail-closed auth shim (Task 2.7 → Fase 3 of the abeduls3-alignment
 * plan). The legacy `GET brand.auth.url` cookie-forwarding flow
 * (`auth.service.ts`) has been deleted along with the rest of the legacy
 * brand model — Fase 3 replaces it with `resolveSession` (`partner-whoami`
 * fetch, SSRF gate, circuit breaker, Redis cache; see
 * `docs/superpowers/specs/2026-07-02-companion-multibrand-alineacion-abeduls3-design.md`
 * D5). Until then, this module is an explicit, minimal shim:
 *
 *   - `attachUser` is a NO-OP. It never populates `req.user`. There is no
 *     interim session validation — pretending to authenticate with the
 *     retired model would be worse than refusing outright.
 *   - `requireAuth` ALWAYS responds 401, regardless of brand/cookie/req.user
 *     state. An upload-signing endpoint must NEVER let a request through
 *     unauthenticated; refusing everything is the only safe failure mode
 *     until the real session-resolver is wired in.
 */
export const attachUser = async (
    _req: AppRequest,
    _res: Response,
    next: NextFunction,
): Promise<void> => {
    next();
};

export const requireAuth = async (
    _req: AppRequest,
    res: Response,
    _next: NextFunction,
): Promise<void> => {
    res.status(401).json({ error: 'Authentication is not available yet (pending Fase 3 session-resolver)' });
};
