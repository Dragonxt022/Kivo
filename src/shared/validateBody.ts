import type { Request, Response, NextFunction } from 'express';
import { z, type ZodSchema, ZodIssueCode } from 'zod';

function translateIssue(issue: z.ZodIssue): string {
  const custom = issue.message;
  // Se já tem mensagem customizada em português, mantém
  if (issue.code === ZodIssueCode.custom) return custom;

  switch (issue.code) {
    case ZodIssueCode.invalid_type: {
      const { expected, input } = issue;
      if (input === undefined) return 'Campo obrigatório.';
      if (input === null) return 'Campo não pode ser nulo.';
      if (expected === 'string') return 'Deve ser um texto.';
      if (expected === 'number') return 'Deve ser um número.';
      if (expected === 'int') return 'Deve ser um número inteiro.';
      if (expected === 'boolean') return 'Deve ser verdadeiro ou falso.';
      if (expected === 'array') return 'Deve ser uma lista.';
      if (expected === 'object') return 'Deve ser um objeto.';
      return `Tipo inválido: esperado ${expected}.`;
    }
    case ZodIssueCode.too_small: {
      const { origin, minimum, inclusive } = issue;
      if (origin === 'string') return inclusive
        ? `Deve ter no mínimo ${minimum} caractere${minimum === 1 ? '' : 's'}.`
        : `Deve ter mais de ${minimum} caracteres.`;
      if (origin === 'number' || origin === 'int' || origin === 'bigint') return inclusive
        ? `Deve ser no mínimo ${minimum}.`
        : `Deve ser maior que ${minimum}.`;
      if (origin === 'array' || origin === 'set') return inclusive
        ? `Deve conter no mínimo ${minimum} item(itens).`
        : `Deve conter mais de ${minimum} item(itens).`;
      return custom;
    }
    case ZodIssueCode.too_big: {
      const { origin, maximum, inclusive } = issue;
      if (origin === 'string') return inclusive
        ? `Deve ter no máximo ${maximum} caracteres.`
        : `Deve ter menos de ${maximum} caracteres.`;
      if (origin === 'number' || origin === 'int' || origin === 'bigint') return inclusive
        ? `Deve ser no máximo ${maximum}.`
        : `Deve ser menor que ${maximum}.`;
      if (origin === 'array' || origin === 'set') return inclusive
        ? `Deve conter no máximo ${maximum} item(itens).`
        : `Deve conter menos de ${maximum} item(itens).`;
      return custom;
    }
    case ZodIssueCode.invalid_value: {
      const { values } = issue;
      return `Valor inválido. Opções: ${values.join(', ')}.`;
    }
    case ZodIssueCode.unrecognized_keys:
      return `Campo não reconhecido: "${issue.keys.join(', ')}".`;
    case ZodIssueCode.invalid_union:
      return 'Nenhuma das alternativas é válida. Verifique os campos informados.';
    default:
      return custom;
  }
}

export function validateBody<T extends ZodSchema>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const first = result.error.issues[0];
      res.status(400).json({ error: `"${first.path.join('.')}": ${translateIssue(first)}` });
      return;
    }
    req.body = result.data as z.infer<T>;
    next();
  };
}
