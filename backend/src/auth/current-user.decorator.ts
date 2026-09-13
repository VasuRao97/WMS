import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { type AuthUser } from '../common/tenant.util';

// `request.user` is set by JwtStrategy.validate() (see auth/jwt.strategy.ts)
// — Express's own Request type has no idea about it, hence the cast rather
// than a type Nest can infer on its own.
export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as AuthUser;
  },
);
