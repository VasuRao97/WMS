import { createParamDecorator, ExecutionContext } from '@nestjs/common';

// The ApiKeyGuard-authenticated twin of auth/current-user.decorator.ts —
// reads `request.company` (set by ApiKeyGuard) instead of `request.user`
// (set by JwtAuthGuard), for routes with no logged-in human at all.
export const CurrentCompany = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  return request.company;
});
