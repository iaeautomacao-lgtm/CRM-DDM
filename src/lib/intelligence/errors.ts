// Erros do DDM Intelligence com status HTTP próprio. Forbidden/Unauthorized
// reaproveitam os de src/lib/auth/account.ts (toErrorResponse já os mapeia);
// aqui ficam só os que faltam lá.

export class BadRequestError extends Error {
  readonly status = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

export class NotFoundError extends Error {
  readonly status = 404 as const;
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
