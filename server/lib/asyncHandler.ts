import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Wrapper para handlers async no Express. Sem isso, exceções dentro de
 * `async (req, res) => {...}` viram unhandled rejections e não chegam no
 * middleware global de erro. Uso:
 *
 *   router.get("/x", asyncHandler(async (req, res) => { ... }));
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Middleware global de tratamento de erros. Deve ser registrado por último,
 * depois de todas as rotas. Centraliza:
 *  - log estruturado do erro
 *  - resposta JSON consistente pro cliente
 *  - status code apropriado (400 pra ZodError, 500 pra resto)
 */
export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) return;

  // Erros de validação zod chegam aqui já tratados pelo `validate()`,
  // mas se algum vazar, blindamos:
  const e = err as { name?: string; issues?: unknown; message?: string };
  if (e?.name === "ZodError") {
    res.status(400).json({ error: "Dados inválidos", details: e.issues });
    return;
  }

  console.error("[api]", err);
  res.status(500).json({
    error: e?.message ?? "Erro interno",
  });
}
