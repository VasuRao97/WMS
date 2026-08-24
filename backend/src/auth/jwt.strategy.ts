import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'change-me-in-production',
    });
  }

  // Re-checks `isActive` against the DB on every authenticated request — a
  // signature-valid, unexpired token alone isn't enough. Without this, a
  // deactivated user's already-issued token kept working for up to the 8h
  // token lifetime (auth.module.ts's `expiresIn`) regardless of deactivation,
  // since nothing else in the request path re-reads the User row. Fixed
  // 2026-08-24 — see CLAUDE.md's "Role & Access model" for the full context.
  async validate(payload: any) {
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub }, select: { isActive: true } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('This account is no longer active.');
    }
    return {
      userId: payload.sub,
      email: payload.email,
      role: payload.role,
      companyId: payload.companyId,
    };
  }
}