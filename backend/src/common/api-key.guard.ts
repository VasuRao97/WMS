import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// A second, parallel auth mechanism to JwtAuthGuard — for a machine caller
// (an ERP integration) that has no logged-in User at all, only a
// per-company secret (2026-08-27, ERP push). Reads `X-Api-Key`, looks up
// the Company it belongs to, and attaches `request.company` (read via the
// CurrentCompany decorator) instead of `request.user`. Deliberately NOT
// combined with JwtAuthGuard/RolesGuard on the same route — a route
// guarded by this one has no concept of a human role at all, only "this
// company's key was presented."
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const key = request.headers['x-api-key'];
    if (!key || typeof key !== 'string') {
      throw new UnauthorizedException('X-Api-Key header is required.');
    }
    const company = await this.prisma.company.findUnique({ where: { erpApiKey: key } });
    if (!company) {
      throw new UnauthorizedException('Invalid API key.');
    }
    if (!company.isActive) {
      throw new ForbiddenException('This company account is inactive.');
    }
    if (!company.allowErpInboundPush) {
      throw new ForbiddenException('ERP push is not enabled for this company — turn it on in Company Settings first.');
    }
    request.company = company;
    return true;
  }
}
