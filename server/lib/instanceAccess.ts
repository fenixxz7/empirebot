import type { Request, Response, NextFunction } from "express";

/**
 * Middleware factory que bloqueia acesso a uma instância específica
 * se o usuário tiver allowedInstanceIds restrito em res.locals.
 *
 * Uso:
 *   router.use("/:id/...", instanceAccessGuard("id"), handler)
 *
 * null em allowedInstanceIds = acesso total (admin).
 */
export function instanceAccessGuard(paramName = "instanceId") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const allowed = res.locals.allowedInstanceIds as number[] | null;
    if (allowed === null || allowed === undefined) {
      // Admin ou sem restrição
      next();
      return;
    }
    const idStr = req.params[paramName];
    if (!idStr) {
      // Sem param (rota de listagem) — tratado no handler
      next();
      return;
    }
    const id = Number(idStr);
    if (isNaN(id) || !allowed.includes(id)) {
      res.status(403).json({ error: "Acesso negado a esta instância." });
      return;
    }
    next();
  };
}
