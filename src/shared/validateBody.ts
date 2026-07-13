import type { Request, Response, NextFunction } from 'express';
import { z, type ZodSchema } from 'zod';

export function validateBody<T extends ZodSchema>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const first = result.error.issues[0];
      res.status(400).json({ error: `Campo "${first.path.join('.')}": ${first.message}` });
      return;
    }
    req.body = result.data as z.infer<T>;
    next();
  };
}
