import type { Request, Response, NextFunction, RequestHandler } from "express";
import { ZodError, type ZodTypeAny, type infer as ZodInfer } from "zod";

/**
 * Middleware que valida `req.body`, `req.query` e/ou `req.params` contra
 * schemas zod. Substitui o conteúdo pelo dado *parsed* (com tipos coercidos
 * e defaults aplicados). Se inválido, responde 400 e não chama o handler.
 *
 * Uso:
 *   const Body = z.object({ name: z.string().min(1) });
 *   router.post("/x", validate({ body: Body }), (req, res) => {
 *     // req.body é tipado como { name: string }
 *   });
 */
export function validate<
  B extends ZodTypeAny | undefined = undefined,
  Q extends ZodTypeAny | undefined = undefined,
  P extends ZodTypeAny | undefined = undefined,
>(schemas: { body?: B; query?: Q; params?: P }): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      if (schemas.query) {
        // req.query é read-only no Express 5+ — atribuímos por descritor
        Object.defineProperty(req, "query", {
          value: schemas.query.parse(req.query),
          writable: true,
          configurable: true,
        });
      }
      if (schemas.params) {
        req.params = schemas.params.parse(req.params) as Record<string, string>;
      }
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const friendly = err.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        }));
        res.status(400).json({
          error: "Dados inválidos",
          details: friendly,
        });
        return;
      }
      next(err);
    }
  };
}

/** Helper pra inferir o tipo do body parseado. */
export type Infer<T extends ZodTypeAny> = ZodInfer<T>;
